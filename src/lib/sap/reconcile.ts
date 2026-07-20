import { getSapToken } from './token';

// Reconciliation, run by the */10 cron. Two safety nets for the queue path:
//  - reconcileOutbound re-enqueues outbox rows that are still pending past a
//    grace window (their queue send was lost or the consumer never ran).
//  - reconcileInbound polls SAP for cases changed since a watermark and enqueues
//    them, so a missed webhook is still picked up.

// Re-enqueue is safe: the consumer is idempotent (already-sent rows ack no-op).
const GRACE_MS = 5 * 60 * 1000;
const WATERMARK_KEY = 'inbound_watermark';

export async function reconcileOutbound(env: Env, now: number = Date.now()): Promise<number> {
	const cutoff = now - GRACE_MS;
	const { results } = await env.DB.prepare("SELECT id, issue_id FROM sap_outbox WHERE status = 'pending' AND created_at < ?")
		.bind(cutoff)
		.all<{ id: string; issue_id: string }>();
	for (const row of results) {
		await env.SAP_OUTBOUND.send({ outboxId: row.id, issueId: row.issue_id });
	}
	if (results.length > 0) {
		console.log({ event: 'sap.reconcile.outbound', reenqueued: results.length });
	}
	return results.length;
}

export async function reconcileInbound(env: Env, now: number = Date.now()): Promise<number> {
	const state = await env.DB.prepare('SELECT watermark FROM sync_state WHERE key = ?').bind(WATERMARK_KEY).first<{ watermark: string }>();
	const watermark = state?.watermark ?? '0';

	const token = await getSapToken(env);
	const res = await fetch(`${env.SAP_API_BASE}/cases?changedSince=${encodeURIComponent(watermark)}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!res.ok) {
		console.error({ event: 'sap.reconcile.inbound.error', status: res.status });
		return 0;
	}

	const data = await res.json().then(
		(v) => v as { cases?: Array<{ case_id: string; status: string; change_id: string }>; watermark?: string },
		() => ({}) as { cases?: Array<{ case_id: string; status: string; change_id: string }>; watermark?: string },
	);
	const cases = data.cases ?? [];
	if (cases.length === 0) {
		// Nothing changed — leave the watermark where it is and re-poll next tick.
		return 0;
	}

	for (const change of cases) {
		await env.SAP_INBOUND.send({ case_id: change.case_id, status: change.status, change_id: change.change_id });
	}
	// Advance to the server-provided watermark, or to now if it didn't give one.
	const next = data.watermark ?? String(now);
	await env.DB.prepare(
		`INSERT INTO sync_state (key, watermark) VALUES (?, ?)
		 ON CONFLICT(key) DO UPDATE SET watermark = excluded.watermark`,
	)
		.bind(WATERMARK_KEY, next)
		.run();
	console.log({ event: 'sap.reconcile.inbound', enqueued: cases.length, watermark: next });
	return cases.length;
}
