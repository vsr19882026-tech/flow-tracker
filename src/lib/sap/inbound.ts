import { fromSapCase, UNMAPPED_STATUS } from './mapper';
import type { StatusMapRow } from './mapper';

// A minimal view of a Queue message — the fields the inbound consumer uses.
export type InboundMessage = {
	body: { case_id?: string; status?: string; change_id?: string };
	attempts: number;
	ack: () => void;
	retry: () => void;
};

export type InboundResult = { outcome: 'applied' | 'skipped' | 'dead'; reason?: string };

type LinkRow = { issue_id: string; last_change_id: string | null };

// Process one sap-inbound message: apply a SAP case change to the linked issue.
export async function processInboundMessage(env: Env, msg: InboundMessage): Promise<InboundResult> {
	const { case_id, status, change_id } = msg.body;

	const link = await env.DB.prepare('SELECT issue_id, last_change_id FROM sap_links WHERE sap_case_id = ?')
		.bind(case_id ?? null)
		.first<LinkRow>();
	if (!link) {
		// A case we never linked (or was unlinked) — nothing to apply.
		msg.ack();
		console.warn({ event: 'sap.inbound.unknown_case', case_id });
		return { outcome: 'skipped', reason: 'unknown_case' };
	}
	if (change_id != null && change_id === link.last_change_id) {
		// Already applied this change — idempotent redelivery.
		msg.ack();
		return { outcome: 'skipped', reason: 'duplicate' };
	}

	const statusMap = (await env.DB.prepare('SELECT flow_status, sap_status, direction FROM sap_status_map').all<StatusMapRow>()).results;
	const flowStatus = fromSapCase({ status }, statusMap);
	if (flowStatus === UNMAPPED_STATUS) {
		// No inbound mapping for this SAP status — dead-letter, leave the issue alone.
		msg.ack();
		console.error({ event: 'sap.inbound.dead', case_id, sap_status: status, reason: 'unmapped_status' });
		return { outcome: 'dead', reason: 'unmapped_status' };
	}

	// Apply the status, record the change under actor sap-sync, and advance the
	// idempotency cursor — atomically.
	const now = Date.now();
	await env.DB.batch([
		env.DB.prepare('UPDATE issues SET status = ?, updated_at = ? WHERE id = ?').bind(flowStatus, now, link.issue_id),
		env.DB.prepare(
			`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, diff, ip, user_agent, created_at)
			 VALUES (?, 'sap-sync', 'sap-inbound', 'issue', ?, ?, NULL, NULL, ?)`,
		).bind(crypto.randomUUID(), link.issue_id, JSON.stringify({ status: flowStatus, sap_status: status, case_id, change_id }), now),
		env.DB.prepare('UPDATE sap_links SET last_change_id = ?, updated_at = ? WHERE sap_case_id = ?').bind(change_id ?? null, now, case_id ?? null),
	]);
	msg.ack();
	console.log({ event: 'sap.inbound.applied', case_id, issue_id: link.issue_id, status: flowStatus });
	return { outcome: 'applied' };
}
