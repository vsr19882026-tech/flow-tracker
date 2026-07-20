// Field/status mapping between a flow-tracker issue and a SAP ITSM case. The maps
// are data (sap_field_map / sap_status_map rows), so the mapping is configurable
// without code changes.

export type FieldMapRow = {
	flow_field: string;
	sap_field: string;
	direction: string; // 'outbound' | 'inbound' | 'both'
	transform: string | null; // reserved for future value transforms; unused today
	active: number;
};

export type StatusMapRow = {
	flow_status: string;
	sap_status: string;
	direction: string; // 'outbound' | 'inbound' | 'both'
};

// Returned when an inbound SAP status has no flow mapping — the caller dead-letters
// the change rather than crashing or guessing a status.
export const UNMAPPED_STATUS = Symbol('sap.unmapped_status');

function isOutbound(direction: string): boolean {
	return direction === 'outbound' || direction === 'both';
}

function isInbound(direction: string): boolean {
	return direction === 'inbound' || direction === 'both';
}

// Translate a flow status to its SAP status (outbound direction). null if unmapped.
function statusToSap(flowStatus: string, statusMap: StatusMapRow[]): string | null {
	const row = statusMap.find((r) => r.flow_status === flowStatus && isOutbound(r.direction));
	return row ? row.sap_status : null;
}

/**
 * Build the SAP case payload for an issue from the active outbound field map.
 * The `status` field's value is itself translated through the status map; other
 * fields copy the issue value straight across. Unset values and an unmapped
 * status are omitted from the payload.
 */
export function toSapCase(
	issue: Record<string, unknown>,
	fieldMap: FieldMapRow[],
	statusMap: StatusMapRow[],
): Record<string, unknown> {
	const payload: Record<string, unknown> = {};
	for (const field of fieldMap) {
		if (!field.active || !isOutbound(field.direction)) continue;

		let value = issue[field.flow_field];
		if (field.flow_field === 'status') {
			if (typeof value !== 'string') continue;
			const mapped = statusToSap(value, statusMap);
			if (mapped === null) continue;
			value = mapped;
		}
		if (value === undefined || value === null) continue;
		payload[field.sap_field] = value;
	}
	return payload;
}

/**
 * Map an inbound SAP case change's status to a flow status. Returns
 * UNMAPPED_STATUS when the SAP status has no inbound mapping, so the caller can
 * dead-letter the change instead of crashing.
 */
export function fromSapCase(caseChange: { status?: unknown }, statusMap: StatusMapRow[]): string | typeof UNMAPPED_STATUS {
	const sapStatus = caseChange.status;
	if (typeof sapStatus !== 'string') return UNMAPPED_STATUS;
	const row = statusMap.find((r) => r.sap_status === sapStatus && isInbound(r.direction));
	return row ? row.flow_status : UNMAPPED_STATUS;
}
