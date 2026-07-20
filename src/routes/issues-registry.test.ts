import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';

// POST /issues validates against FIELD_REGISTRY, never a ui_layouts row — a field
// hidden in the active layout is still accepted.

const USER_ID = 'reg_user';
const TOKEN = 'reg-token';
const COOKIE = `better-auth.session=${TOKEN}`;

beforeEach(async () => {
	const db = env.DB;
	for (const t of ['ui_layouts', 'issues', 'session', 'user']) {
		await db.exec(`DROP TABLE IF EXISTS ${t}`);
	}
	await db
		.prepare(`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, role TEXT NOT NULL DEFAULT 'member', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`)
		.run();
	await db
		.prepare(`CREATE TABLE "session" (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES "user"(id), token TEXT NOT NULL UNIQUE, expiresAt TEXT NOT NULL, ipAddress TEXT, userAgent TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`)
		.run();
	await db
		.prepare(
			`CREATE TABLE issues (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES "user"(id), title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')), priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')), issue_number INTEGER NOT NULL, project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(issue_number))`,
		)
		.run();
	await db.prepare(`CREATE TABLE ui_layouts (id TEXT PRIMARY KEY, version INTEGER NOT NULL, layout_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0)`).run();

	await db
		.prepare(`INSERT INTO "user" (id, name, email, emailVerified, role, createdAt, updatedAt) VALUES (?, ?, ?, 1, 'member', ?, ?)`)
		.bind(USER_ID, 'Reg', 'reg@example.com', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
	await db
		.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind('reg_sess', USER_ID, TOKEN, '2999-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();

	// An active layout that HIDES the title field — it must not affect validation.
	await db
		.prepare(`INSERT INTO ui_layouts (id, version, layout_json, created_by, created_at, active) VALUES ('L1', 1, ?, ?, 1000, 1)`)
		.bind(JSON.stringify({ fields: [{ field: 'title', hidden: true }] }), USER_ID)
		.run();
});

async function post(body: unknown): Promise<Response> {
	return SELF.fetch('http://tracker.test/issues', {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie: COOKIE },
		body: JSON.stringify(body),
	});
}

describe('POST /issues validates against the registry', () => {
	it('2. a valid title is accepted even though the active layout hides it', async () => {
		const res = await post({ title: 'Registry-validated' });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { title: string };
		expect(body.title).toBe('Registry-validated');
	});

	it('an empty title is rejected by the registry validator', async () => {
		const res = await post({ title: '   ' });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe('title is required');
	});
});
