import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { parseInviteEmails } from '../lib/invites';

// Admin UI: admin-only access + the bulk-invite flow. The session middleware
// resolves the caller's role from "user", so seed an admin and a plain member.

const ADMIN_ID = 'admin_1';
const ADMIN_TOKEN = 'admin-session-token';
const ADMIN_COOKIE = `better-auth.session=${ADMIN_TOKEN}`;
const MEMBER_ID = 'member_1';
const MEMBER_TOKEN = 'member-session-token';
const MEMBER_COOKIE = `better-auth.session=${MEMBER_TOKEN}`;

beforeEach(async () => {
	const db = env.DB;
	await db.exec('DROP TABLE IF EXISTS invites');
	await db.exec('DROP TABLE IF EXISTS session');
	await db.exec('DROP TABLE IF EXISTS user');

	await db
		.prepare(
			`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
				emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
				role TEXT NOT NULL DEFAULT 'member')`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE "session" (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES "user"(id), token TEXT NOT NULL UNIQUE,
				expiresAt TEXT NOT NULL, ipAddress TEXT, userAgent TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
		)
		.run();
	await db
		.prepare(`CREATE TABLE invites (id TEXT PRIMARY KEY, email TEXT NOT NULL, invited_by TEXT NOT NULL REFERENCES "user"(id), created_at INTEGER NOT NULL)`)
		.run();

	const now = new Date().toISOString();
	const future = '2999-12-31T23:59:59.999Z';
	for (const [id, email, role] of [
		[ADMIN_ID, 'admin@flow.test', 'admin'],
		[MEMBER_ID, 'member@flow.test', 'member'],
	]) {
		await db
			.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt, role) VALUES (?, ?, ?, 1, ?, ?, ?)`)
			.bind(id, id, email, now, now, role)
			.run();
	}
	await db
		.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind('sess_admin', ADMIN_ID, ADMIN_TOKEN, future, now, now)
		.run();
	await db
		.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind('sess_member', MEMBER_ID, MEMBER_TOKEN, future, now, now)
		.run();
});

describe('admin access control', () => {
	it('1. renders the users table for an admin', async () => {
		const res = await SELF.fetch('http://tracker.test/admin/users', { headers: { cookie: ADMIN_COOKIE } });
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('admin@flow.test');
		expect(html).toContain('signups this week');
	});

	it('2. returns 403 for a member', async () => {
		const res = await SELF.fetch('http://tracker.test/admin/users', { headers: { cookie: MEMBER_COOKIE } });
		expect(res.status).toBe(403);
	});

	it('3. returns 403 for a member trying to bulk-invite (mutating route is gated too)', async () => {
		const res = await SELF.fetch('http://tracker.test/admin/invites', {
			method: 'POST',
			headers: { cookie: MEMBER_COOKIE, 'content-type': 'application/x-www-form-urlencoded' },
			body: 'emails=x@northwind.dev',
			redirect: 'manual',
		});
		expect(res.status).toBe(403);
		const { results } = await env.DB.prepare('SELECT * FROM invites').all();
		expect(results.length).toBe(0);
	});
});

describe('bulk-invite parser', () => {
	it('4. handles commas, spaces, newlines, and de-dups', () => {
		const raw = 'a@northwind.dev, b@northwind.dev\n  a@northwind.dev , \n C@Northwind.dev\tnot-an-email';
		expect(parseInviteEmails(raw)).toEqual(['a@northwind.dev', 'b@northwind.dev', 'c@northwind.dev']);
	});
});

describe('POST /admin/invites', () => {
	it('5. bulk-inviting two emails creates two invite rows', async () => {
		const res = await SELF.fetch('http://tracker.test/admin/invites', {
			method: 'POST',
			headers: { cookie: ADMIN_COOKIE, 'content-type': 'application/x-www-form-urlencoded' },
			body: `emails=${encodeURIComponent('a@northwind.dev, b@northwind.dev')}`,
			redirect: 'manual',
		});
		expect(res.status).toBe(302);

		const { results } = await env.DB.prepare('SELECT email, invited_by FROM invites ORDER BY email').all<{ email: string; invited_by: string }>();
		expect(results.map((r) => r.email)).toEqual(['a@northwind.dev', 'b@northwind.dev']);
		expect(results.every((r) => r.invited_by === ADMIN_ID)).toBe(true);
	});
});
