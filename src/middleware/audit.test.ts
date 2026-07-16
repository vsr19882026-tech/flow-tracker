import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';

// Audit middleware: writes are recorded, reads are not, sensitive fields are
// redacted, and the admin audit page filters.

const ADMIN_ID = 'admin_1';
const ADMIN_TOKEN = 'audit-admin-token';
const ADMIN_COOKIE = `better-auth.session=${ADMIN_TOKEN}`;

beforeEach(async () => {
	const db = env.DB;
	for (const t of ['audit_log', 'issues', 'session', 'user']) {
		await db.exec(`DROP TABLE IF EXISTS ${t}`);
	}
	await db
		.prepare(
			`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
				emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
				role TEXT NOT NULL DEFAULT 'member')`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE "session" (id TEXT PRIMARY KEY, userId TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
				expiresAt TEXT NOT NULL, ipAddress TEXT, userAgent TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE issues (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
				status TEXT NOT NULL DEFAULT 'open', issue_number INTEGER NOT NULL, project_id TEXT,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(issue_number))`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE audit_log (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT NOT NULL,
				target_id TEXT NOT NULL, diff TEXT, ip TEXT, user_agent TEXT, created_at INTEGER NOT NULL)`,
		)
		.run();

	const now = new Date().toISOString();
	await db
		.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 1, ?, ?, 'admin')`)
		.bind(ADMIN_ID, 'Admin', 'admin@flow.test', now, now)
		.run();
	await db
		.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind('sess_admin', ADMIN_ID, ADMIN_TOKEN, '2999-12-31T23:59:59.999Z', now, now)
		.run();
});

describe('audit middleware', () => {
	it('1. a write (POST /issues) produces an audit_log row', async () => {
		const res = await SELF.fetch('http://tracker.test/issues', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: ADMIN_COOKIE },
			body: JSON.stringify({ title: 'Audited issue' }),
		});
		expect(res.status).toBe(200);

		const { results } = await env.DB.prepare('SELECT * FROM audit_log').all<{ actor_id: string; action: string; target_type: string; diff: string }>();
		expect(results.length).toBe(1);
		expect(results[0].actor_id).toBe(ADMIN_ID);
		expect(results[0].action).toBe('POST /issues');
		expect(results[0].target_type).toBe('issue');
		expect(results[0].diff).toContain('Audited issue'); // title is not sensitive
	});

	it('2. a read (GET /issues) produces NO audit_log row', async () => {
		const res = await SELF.fetch('http://tracker.test/issues', { headers: { cookie: ADMIN_COOKIE } });
		expect(res.status).toBe(200);
		const { results } = await env.DB.prepare('SELECT * FROM audit_log').all();
		expect(results.length).toBe(0);
	});

	it('3. redacts sensitive fields - magic-link email becomes <redacted>', async () => {
		await SELF.fetch('http://tracker.test/auth/sign-in/magic-link', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email: 'secret-person@evil.com' }),
		});
		const row = await env.DB.prepare(`SELECT * FROM audit_log WHERE target_type = 'auth'`).first<{ diff: string; actor_id: string }>();
		expect(row).not.toBeNull();
		expect(row!.actor_id).toBe('anonymous');
		expect(row!.diff).toContain('<redacted>');
		expect(row!.diff).not.toContain('secret-person@evil.com');
	});

	it('4. the admin audit page filters by actor', async () => {
		const mk = (actor: string, action: string, target: string, at: number) =>
			env.DB.prepare(
				`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, diff, created_at) VALUES (?, ?, ?, 'issue', ?, '{}', ?)`,
			)
				.bind(crypto.randomUUID(), actor, action, target, at)
				.run();
		await mk(ADMIN_ID, 'POST /issues/:id/comments', 'keep-me', 2000);
		await mk('zzz_other', 'DELETE /projects/:id', 'drop-me', 1000);

		const res = await SELF.fetch(`http://tracker.test/admin/audit?actor=${ADMIN_ID}`, { headers: { cookie: ADMIN_COOKIE } });
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('POST /issues/:id/comments');
		expect(html).not.toContain('DELETE /projects/:id');
	});
});
