import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { replayOutbox } from '../lib/sap/replay';

// The SAP admin tab (under requireAdmin) + the replay helper.

const ADMIN_ID = 'admin_1';
const ADMIN_TOKEN = 'sap-admin-token';
const ADMIN_COOKIE = `better-auth.session=${ADMIN_TOKEN}`;
const MEMBER_ID = 'member_1';
const MEMBER_TOKEN = 'sap-member-token';
const MEMBER_COOKIE = `better-auth.session=${MEMBER_TOKEN}`;

async function seedUser(id: string, role: string, token: string): Promise<void> {
	await env.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, role, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?, ?)`)
		.bind(id, id, `${id}@example.com`, role, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
	await env.DB.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind(`sess_${id}`, id, token, '2999-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
}

beforeEach(async () => {
	const db = env.DB;
	for (const t of ['sap_links', 'sap_outbox', 'sap_status_map', 'sap_field_map', 'sync_state', 'session', 'user']) {
		await db.exec(`DROP TABLE IF EXISTS ${t}`);
	}
	await db
		.prepare(`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, role TEXT NOT NULL DEFAULT 'member', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`)
		.run();
	await db
		.prepare(`CREATE TABLE "session" (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES "user"(id), token TEXT NOT NULL UNIQUE, expiresAt TEXT NOT NULL, ipAddress TEXT, userAgent TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`)
		.run();
	await db.prepare(`CREATE TABLE sap_links (issue_id TEXT PRIMARY KEY, sap_case_id TEXT, external_ref TEXT, last_seq_sent INTEGER, last_change_id TEXT, updated_at INTEGER)`).run();
	await db
		.prepare(`CREATE TABLE sap_outbox (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, issue_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)`)
		.run();
	await db.prepare(`CREATE TABLE sap_field_map (flow_field TEXT NOT NULL, sap_field TEXT NOT NULL, direction TEXT NOT NULL, transform TEXT, active INTEGER NOT NULL DEFAULT 1)`).run();
	await db.prepare(`CREATE TABLE sap_status_map (flow_status TEXT NOT NULL, sap_status TEXT NOT NULL, direction TEXT NOT NULL)`).run();
	await db.prepare(`CREATE TABLE sync_state (key TEXT PRIMARY KEY, watermark TEXT)`).run();

	await seedUser(ADMIN_ID, 'admin', ADMIN_TOKEN);
	await seedUser(MEMBER_ID, 'member', MEMBER_TOKEN);

	// One linked issue, one dead outbox row, some state and maps.
	await db.prepare(`INSERT INTO sap_links (issue_id, sap_case_id, external_ref, last_seq_sent, updated_at) VALUES ('issue-1','CASE-1','ft-issue-1-1',1,1000)`).run();
	await db.prepare(`INSERT INTO sap_outbox (id, seq, issue_id, event_type, payload, status, created_at) VALUES ('issue-9:1',1,'issue-9','created','{}','dead',2000)`).run();
	await db.prepare(`INSERT INTO sync_state (key, watermark) VALUES ('inbound_watermark','200')`).run();
	await db.prepare(`INSERT INTO sap_field_map (flow_field, sap_field, direction, transform, active) VALUES ('title','subject','both',NULL,1)`).run();
	await db.prepare(`INSERT INTO sap_status_map (flow_status, sap_status, direction) VALUES ('open','New','both')`).run();
});

describe('SAP admin tab', () => {
	it('1. an admin GET renders 200 with the linked count and the DLQ row', async () => {
		const res = await SELF.fetch('http://tracker.test/admin/integrations/sap', { headers: { cookie: ADMIN_COOKIE } });
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('1 linked issues');
		expect(html).toContain('issue-9:1'); // the dead outbox row is listed in the DLQ
		expect(html).toContain('inbound_watermark');
	});

	it('2. a member GET is 403', async () => {
		const res = await SELF.fetch('http://tracker.test/admin/integrations/sap', { headers: { cookie: MEMBER_COOKIE } });
		expect(res.status).toBe(403);
		await res.text(); // drain the body so the response stream doesn't outlive the test
	});
});

describe('replayOutbox', () => {
	it('3. replaying a dead row sets it back to pending and re-enqueues it', async () => {
		const send = vi.fn();
		const testEnv = { DB: env.DB, SAP_OUTBOUND: { send } } as unknown as Env;

		const ok = await replayOutbox(testEnv, 'issue-9:1');

		expect(ok).toBe(true);
		expect(send).toHaveBeenCalledWith({ outboxId: 'issue-9:1', issueId: 'issue-9' });
		const row = await env.DB.prepare("SELECT status FROM sap_outbox WHERE id = 'issue-9:1'").first<{ status: string }>();
		expect(row!.status).toBe('pending');
	});
});
