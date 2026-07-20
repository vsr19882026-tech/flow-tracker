import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';

// SAP transactional-outbox behavior on the issue write path (Session 5, Step 3).
// A write in a `sap_synced` project appends a sap_outbox row in the SAME batch as
// the issue write; a write in a non-synced project does not. Written before the
// implementation (TDD) — the outbox rows do not exist until the batch is wired.

const USER_ID = 'user_sap_1';
const SESSION_TOKEN = 'sap-session-token';
const AUTH_COOKIE = `better-auth.session=${SESSION_TOKEN}`;
// Bare raw token; the session middleware does split('.')[0], so no HMAC needed.

beforeEach(async () => {
	const db = env.DB;
	for (const t of ['sap_outbox', 'issues', 'projects', 'session', 'user']) {
		await db.exec(`DROP TABLE IF EXISTS ${t}`);
	}

	await db
		.prepare(
			`CREATE TABLE "user" (
				id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
				emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
				role TEXT NOT NULL DEFAULT 'member', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
			)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE "session" (
				id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES "user"(id), token TEXT NOT NULL UNIQUE,
				expiresAt TEXT NOT NULL, ipAddress TEXT, userAgent TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
			)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE projects (
				id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES "user"(id), name TEXT NOT NULL,
				slug TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, sap_synced INTEGER NOT NULL DEFAULT 0
			)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE issues (
				id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES "user"(id), title TEXT NOT NULL, description TEXT,
				status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
				priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
				issue_number INTEGER NOT NULL, project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
				UNIQUE(issue_number)
			)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE sap_outbox (
				id TEXT PRIMARY KEY, seq INTEGER NOT NULL, issue_id TEXT NOT NULL REFERENCES issues(id),
				event_type TEXT NOT NULL CHECK (event_type IN ('created','updated')), payload TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending','sent','dead')) DEFAULT 'pending', created_at INTEGER NOT NULL
			)`,
		)
		.run();

	// Admin user, so canWrite authorizes writes in any project without seeding
	// project_members (RBAC is orthogonal to what this suite exercises).
	await db
		.prepare(`INSERT INTO "user" (id, name, email, emailVerified, role, createdAt, updatedAt) VALUES (?, ?, ?, 1, 'admin', ?, ?)`)
		.bind(USER_ID, 'SAP Tester', 'sap-tester@example.com', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
	await db
		.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind('sap_sess_1', USER_ID, SESSION_TOKEN, '2999-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();

	// Two projects: one opted into SAP sync, one not.
	await db
		.prepare(`INSERT INTO projects (id, owner_id, name, slug, created_at, sap_synced) VALUES ('proj_synced', ?, 'Synced', 'synced', 1000, 1)`)
		.bind(USER_ID)
		.run();
	await db
		.prepare(`INSERT INTO projects (id, owner_id, name, slug, created_at, sap_synced) VALUES ('proj_plain', ?, 'Plain', 'plain', 1000, 0)`)
		.bind(USER_ID)
		.run();
});

async function postIssue(title: string, projectId: string): Promise<Response> {
	return SELF.fetch('http://tracker.test/issues', {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
		body: JSON.stringify({ title, project_id: projectId }),
	});
}

describe('SAP outbox on the issue write path', () => {
	it('1. a POST in a sap_synced project writes both an issue row and a sap_outbox row', async () => {
		const res = await postIssue('Synced issue', 'proj_synced');
		expect(res.status).toBe(200);
		const { id } = (await res.json()) as { id: string };

		const issue = await env.DB.prepare('SELECT id FROM issues WHERE id = ?').bind(id).first();
		expect(issue).not.toBeNull();

		const { results } = await env.DB.prepare('SELECT * FROM sap_outbox WHERE issue_id = ?').bind(id).all();
		expect(results).toHaveLength(1);
	});

	it('2. a POST in a non-synced project writes no sap_outbox row', async () => {
		const res = await postIssue('Plain issue', 'proj_plain');
		expect(res.status).toBe(200);
		const { id } = (await res.json()) as { id: string };

		const issue = await env.DB.prepare('SELECT id FROM issues WHERE id = ?').bind(id).first();
		expect(issue).not.toBeNull();

		const { results } = await env.DB.prepare('SELECT * FROM sap_outbox WHERE issue_id = ?').bind(id).all();
		expect(results).toHaveLength(0);
	});

	it('3. the outbox row is pending and its payload carries the changed fields', async () => {
		const res = await postIssue('Payload issue', 'proj_synced');
		const { id } = (await res.json()) as { id: string };

		const row = await env.DB.prepare('SELECT event_type, status, payload FROM sap_outbox WHERE issue_id = ?')
			.bind(id)
			.first<{ event_type: string; status: string; payload: string }>();
		expect(row!.status).toBe('pending');
		expect(row!.event_type).toBe('created');
		const payload = JSON.parse(row!.payload) as { title?: string; status?: string };
		expect(payload.title).toBe('Payload issue');
		expect(payload.status).toBe('open');
	});
});
