import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { processInboundMessage } from '../lib/sap/inbound';

// Inbound SAP webhook + consumer. The webhook (SELF.fetch) verifies the HMAC and
// enqueues; the consumer (processInboundMessage, called directly) applies the
// change. The queue decouples them, so each half is exercised on its own.

const WEBHOOK_SECRET = 'test-webhook-secret'; // matches vitest.config.mts

async function sign(body: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
	return 'sha256=' + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function postWebhook(payload: unknown, signature: string): Promise<Response> {
	return SELF.fetch('http://tracker.test/integrations/sap/inbound', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'X-FT-Signature': signature },
		body: JSON.stringify(payload),
	});
}

function makeMsg(body: { case_id?: string; status?: string; change_id?: string }) {
	let acked = 0;
	let retried = 0;
	return { body, attempts: 1, ack: () => { acked++; }, retry: () => { retried++; }, acked: () => acked, retried: () => retried };
}

beforeEach(async () => {
	const db = env.DB;
	for (const t of ['audit_log', 'sap_links', 'sap_status_map', 'issues']) {
		await db.exec(`DROP TABLE IF EXISTS ${t}`);
	}
	await db
		.prepare(`CREATE TABLE issues (id TEXT PRIMARY KEY, reporter_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL, issue_number INTEGER NOT NULL, project_id TEXT, created_at INTEGER, updated_at INTEGER)`)
		.run();
	await db
		.prepare(`CREATE TABLE sap_links (issue_id TEXT PRIMARY KEY, sap_case_id TEXT, external_ref TEXT, last_seq_sent INTEGER, last_change_id TEXT, updated_at INTEGER)`)
		.run();
	await db.prepare(`CREATE TABLE sap_status_map (flow_status TEXT NOT NULL, sap_status TEXT NOT NULL, direction TEXT NOT NULL)`).run();
	await db
		.prepare(
			`CREATE TABLE audit_log (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, diff TEXT, ip TEXT, user_agent TEXT, created_at INTEGER NOT NULL)`,
		)
		.run();

	await db.batch([
		db.prepare(`INSERT INTO sap_status_map (flow_status, sap_status, direction) VALUES ('open','New','both')`),
		db.prepare(`INSERT INTO sap_status_map (flow_status, sap_status, direction) VALUES ('in_progress','In Process','both')`),
		db.prepare(`INSERT INTO sap_status_map (flow_status, sap_status, direction) VALUES ('done','Completed','both')`),
	]);

	// One linked issue: SAP case CASE-1 <-> issue-1 (status open, no change applied yet).
	await db.prepare(`INSERT INTO issues (id, reporter_id, title, status, issue_number, created_at, updated_at) VALUES ('issue-1','u1','Login broken','open',1,1000,1000)`).run();
	await db.prepare(`INSERT INTO sap_links (issue_id, sap_case_id, external_ref, last_seq_sent, last_change_id, updated_at) VALUES ('issue-1','CASE-1','ft-issue-1-1',1,NULL,1000)`).run();
});

describe('inbound webhook + consumer', () => {
	it('1. valid HMAC returns 202, and the consumer updates status with actor sap-sync', async () => {
		const payload = { case_id: 'CASE-1', status: 'In Process', change_id: 'chg-1' };
		const body = JSON.stringify(payload);

		const res = await postWebhook(payload, await sign(body));
		expect(res.status).toBe(202);

		// Apply the change (out of band via the queue in prod).
		const msg = makeMsg(payload);
		const result = await processInboundMessage(env, msg);
		expect(result.outcome).toBe('applied');
		expect(msg.acked()).toBe(1);

		const issue = await env.DB.prepare("SELECT status FROM issues WHERE id = 'issue-1'").first<{ status: string }>();
		expect(issue!.status).toBe('in_progress');

		const audit = await env.DB.prepare("SELECT actor_id FROM audit_log WHERE actor_id = 'sap-sync'").first<{ actor_id: string }>();
		expect(audit!.actor_id).toBe('sap-sync');
	});

	it('2. invalid HMAC returns 401 and nothing changes', async () => {
		const payload = { case_id: 'CASE-1', status: 'In Process', change_id: 'chg-1' };

		const res = await postWebhook(payload, 'sha256=deadbeef');
		expect(res.status).toBe(401);

		const issue = await env.DB.prepare("SELECT status FROM issues WHERE id = 'issue-1'").first<{ status: string }>();
		expect(issue!.status).toBe('open');
	});

	it('3. an unknown case_id is acked without crashing', async () => {
		const msg = makeMsg({ case_id: 'NOPE', status: 'New', change_id: 'x' });
		const result = await processInboundMessage(env, msg);

		expect(result.outcome).toBe('skipped');
		expect(result.reason).toBe('unknown_case');
		expect(msg.acked()).toBe(1);
	});

	it('4. the same change_id twice is a no-op the second time', async () => {
		const first = makeMsg({ case_id: 'CASE-1', status: 'In Process', change_id: 'chg-1' });
		expect((await processInboundMessage(env, first)).outcome).toBe('applied');

		const second = makeMsg({ case_id: 'CASE-1', status: 'Completed', change_id: 'chg-1' });
		const result = await processInboundMessage(env, second);
		expect(result.outcome).toBe('skipped');
		expect(result.reason).toBe('duplicate');

		// Status stayed at the first change's value; the second (Completed) was skipped.
		const issue = await env.DB.prepare("SELECT status FROM issues WHERE id = 'issue-1'").first<{ status: string }>();
		expect(issue!.status).toBe('in_progress');
	});

	it('5. an unmapped inbound status is dead-lettered and the issue is untouched', async () => {
		const msg = makeMsg({ case_id: 'CASE-1', status: 'Escalated to L3', change_id: 'chg-2' });
		const result = await processInboundMessage(env, msg);

		expect(result.outcome).toBe('dead');
		expect(result.reason).toBe('unmapped_status');
		expect(msg.acked()).toBe(1);

		const issue = await env.DB.prepare("SELECT status FROM issues WHERE id = 'issue-1'").first<{ status: string }>();
		expect(issue!.status).toBe('open');
	});
});
