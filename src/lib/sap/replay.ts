// Replay a dead outbox row: flip it back to pending and re-enqueue it. Used by
// the admin SAP tab to retry a message that dead-lettered (e.g. after fixing a
// mapping). Returns false if the row isn't found or isn't dead.
export async function replayOutbox(env: Env, outboxId: string): Promise<boolean> {
	const row = await env.DB.prepare("UPDATE sap_outbox SET status = 'pending' WHERE id = ? AND status = 'dead' RETURNING id, issue_id")
		.bind(outboxId)
		.first<{ id: string; issue_id: string }>();
	if (!row) return false;
	await env.SAP_OUTBOUND.send({ outboxId: row.id, issueId: row.issue_id });
	return true;
}
