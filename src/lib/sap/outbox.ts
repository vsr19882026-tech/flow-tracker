// The SAP transactional outbox. An issue change destined for SAP is recorded in
// sap_outbox in the SAME D1 batch as the issue write, so the change and the
// intent to sync it commit atomically — no lost updates if the queue send fails.
// The outbound queue message and the reconcile cron both drain pending rows.

// Build (but do not execute) the INSERT for one outbox row, so the caller can put
// it in the same db.batch([...]) as the issue write. The row id is deterministic
// — `${issueId}:${seq}` — so the caller can address the row on the queue without
// a round-trip, and (issue, seq) is naturally unique.
export function appendOutbox(
	db: D1Database,
	issueId: string,
	seq: number,
	eventType: 'created' | 'updated',
	changedFields: Record<string, unknown>,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO sap_outbox (id, seq, issue_id, event_type, payload, status, created_at)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
		)
		.bind(`${issueId}:${seq}`, seq, issueId, eventType, JSON.stringify(changedFields), Date.now());
}

// The deterministic outbox row id for an (issue, seq), matching appendOutbox.
export function outboxId(issueId: string, seq: number): string {
	return `${issueId}:${seq}`;
}
