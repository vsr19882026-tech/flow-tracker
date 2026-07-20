import { getSapToken } from './token';
import { toSapCase, mapStatusOutbound } from './mapper';
import type { FieldMapRow, StatusMapRow } from './mapper';
import { resolveSapTarget } from './target';

// A minimal view of a Queue message — the fields the outbound consumer uses. The
// real Cloudflare Message satisfies this structurally.
export type OutboundMessage = {
	body: { outboxId: string; issueId: string };
	attempts: number;
	ack: () => void;
	retry: () => void;
};

export type OutboundResult = { outcome: 'sent' | 'retried' | 'dead' | 'skipped'; reason?: string };

// Cloudflare retries the message up to the queue's max_retries (5, see
// wrangler.toml). Once attempts reach that ceiling the consumer gives up and
// marks the row dead so it isn't stuck pending; sap-dlq backstops unhandled throws.
const MAX_RETRIES = 5;

type OutboxRow = { id: string; seq: number; issue_id: string; event_type: string; payload: string; status: string };
type IssueRow = { id: string; title: string; description: string | null; status: string; issue_number: number };

async function markDead(env: Env, outboxId: string): Promise<void> {
	await env.DB.prepare("UPDATE sap_outbox SET status = 'dead' WHERE id = ?").bind(outboxId).run();
}

// Process one sap-outbound message: sync the issue change to SAP as a case
// upsert, then ack / retry / dead-letter per the outcome.
export async function processOutboundMessage(env: Env, msg: OutboundMessage): Promise<OutboundResult> {
	// Which SAP the current mode points at (mock/real), or null when sync is off.
	const target = await resolveSapTarget(env);
	if (!target) {
		msg.ack();
		return { outcome: 'skipped', reason: 'sync_disabled' };
	}

	const { outboxId, issueId } = msg.body;

	const row = await env.DB.prepare('SELECT id, seq, issue_id, event_type, payload, status FROM sap_outbox WHERE id = ?')
		.bind(outboxId)
		.first<OutboxRow>();
	if (!row) {
		// Row pruned or a stale message — nothing to send.
		msg.ack();
		return { outcome: 'skipped', reason: 'missing_row' };
	}
	if (row.status === 'sent') {
		// Idempotent redelivery — already synced.
		msg.ack();
		return { outcome: 'skipped', reason: 'already_sent' };
	}

	const issue = await env.DB.prepare('SELECT id, title, description, status, issue_number FROM issues WHERE id = ?')
		.bind(issueId)
		.first<IssueRow>();
	if (!issue) {
		await markDead(env, outboxId);
		msg.ack();
		return { outcome: 'dead', reason: 'missing_issue' };
	}

	const fieldMap = (await env.DB.prepare('SELECT flow_field, sap_field, direction, transform, active FROM sap_field_map').all<FieldMapRow>()).results;
	const statusMap = (await env.DB.prepare('SELECT flow_status, sap_status, direction FROM sap_status_map').all<StatusMapRow>()).results;

	// An issue status with no outbound SAP mapping is a permanent failure — dead.
	if (mapStatusOutbound(issue.status, statusMap) === null) {
		await markDead(env, outboxId);
		msg.ack();
		console.error({ event: 'sap.outbound.dead', outbox_id: outboxId, issue_id: issueId, reason: 'unmapped_status' });
		return { outcome: 'dead', reason: 'unmapped_status' };
	}

	// externalReference is the idempotency key SAP upserts on. ft-<issue>-<seq>.
	const externalRef = `ft-${issueId}-${row.seq}`;
	const payload = toSapCase(issue, fieldMap, statusMap);
	payload.externalReference = externalRef;

	const token = await getSapToken(env, target.tokenUrl);
	const res = await fetch(`${target.base}/cases`, {
		method: 'PUT',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	});

	if (res.ok) {
		const data = await res.json().then(
			(v) => v as { caseId?: string; id?: string },
			() => ({}) as { caseId?: string; id?: string },
		);
		const caseId = data.caseId ?? data.id ?? null;
		await env.DB.prepare(
			`INSERT INTO sap_links (issue_id, sap_case_id, external_ref, last_seq_sent, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(issue_id) DO UPDATE SET
			   sap_case_id = excluded.sap_case_id,
			   external_ref = excluded.external_ref,
			   last_seq_sent = excluded.last_seq_sent,
			   updated_at = excluded.updated_at`,
		)
			.bind(issueId, caseId, externalRef, row.seq, Date.now())
			.run();
		await env.DB.prepare("UPDATE sap_outbox SET status = 'sent' WHERE id = ?").bind(outboxId).run();
		msg.ack();
		console.log({ event: 'sap.outbound.sent', outbox_id: outboxId, issue_id: issueId, sap_case_id: caseId, external_ref: externalRef });
		return { outcome: 'sent' };
	}

	if (res.status >= 500) {
		// Retryable upstream failure. Give up once retries are exhausted.
		if (msg.attempts >= MAX_RETRIES) {
			await markDead(env, outboxId);
			msg.ack();
			console.error({ event: 'sap.outbound.dead', outbox_id: outboxId, issue_id: issueId, reason: 'retries_exhausted', status: res.status });
			return { outcome: 'dead', reason: 'retries_exhausted' };
		}
		msg.retry();
		return { outcome: 'retried' };
	}

	// 4xx — permanent client error, do not retry.
	await markDead(env, outboxId);
	msg.ack();
	console.error({ event: 'sap.outbound.dead', outbox_id: outboxId, issue_id: issueId, reason: `http_${res.status}` });
	return { outcome: 'dead', reason: `http_${res.status}` };
}
