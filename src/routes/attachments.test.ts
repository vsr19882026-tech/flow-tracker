import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';

// Contract tests for the attachments feature, written BEFORE the implementation
// exists (TDD). The schema setup below mirrors issues.test.ts and additionally
// DROP/CREATEs the `attachments` table so failures are never setup errors.

const USER_ID = 'user_test_1';
const USER_EMAIL = 'tester@example.com';
const SESSION_TOKEN = 'test-session-token-abc';
const AUTH_COOKIE = `better-auth.session=${SESSION_TOKEN}`;
// Bare raw token; the session middleware does split('.')[0], so no HMAC needed.

const ISSUE_ID = 'issue_test_1';
const ISSUE_NUMBER = 1;

beforeEach(async () => {
	const db = env.DB;
	await db.exec('DROP TABLE IF EXISTS attachments');
	await db.exec('DROP TABLE IF EXISTS issues');
	await db.exec('DROP TABLE IF EXISTS session');
	await db.exec('DROP TABLE IF EXISTS user');

	await db
		.prepare(
			`CREATE TABLE "user" (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				email TEXT NOT NULL UNIQUE,
				emailVerified INTEGER NOT NULL DEFAULT 0,
				image TEXT,
				createdAt TEXT NOT NULL,
				updatedAt TEXT NOT NULL
			)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE "session" (
				id TEXT PRIMARY KEY,
				userId TEXT NOT NULL REFERENCES "user"(id),
				token TEXT NOT NULL UNIQUE,
				expiresAt TEXT NOT NULL,
				ipAddress TEXT,
				userAgent TEXT,
				createdAt TEXT NOT NULL,
				updatedAt TEXT NOT NULL
			)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE issues (
				id TEXT PRIMARY KEY,
				reporter_id TEXT NOT NULL REFERENCES "user"(id),
				title TEXT NOT NULL,
				description TEXT,
				status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
				issue_number INTEGER NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				UNIQUE(issue_number)
			)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE attachments (
				id          TEXT PRIMARY KEY,
				issue_id    TEXT NOT NULL REFERENCES issues(id),
				uploader_id TEXT NOT NULL REFERENCES "user"(id),
				r2_key      TEXT NOT NULL,
				filename    TEXT NOT NULL,
				mime        TEXT NOT NULL,
				size        INTEGER NOT NULL,
				created_at  INTEGER NOT NULL
			)`,
		)
		.run();

	// Seed the authenticated user + a valid (far-future) session.
	await db
		.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`)
		.bind(USER_ID, 'Tester', USER_EMAIL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
	await db
		.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind('sess_1', USER_ID, SESSION_TOKEN, '2999-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
	// Seed an issue to attach to.
	await db
		.prepare(
			`INSERT INTO issues (id, reporter_id, title, status, issue_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(ISSUE_ID, USER_ID, 'Attach here', 'open', ISSUE_NUMBER, 1000, 1000)
		.run();
});

const base = `http://tracker.test/issues/${ISSUE_NUMBER}/attachments`;

function post(body: unknown, auth = true) {
	return SELF.fetch(base, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(auth ? { cookie: AUTH_COOKIE } : {}) },
		body: JSON.stringify(body),
	});
}

const hasExpiry = (url: string) => url.includes('X-Amz-Expires') || url.includes('Expires');

describe('POST /issues/:issue_number/attachments', () => {
	it('1. rejects a size over 20MB with 400', async () => {
		const res = await post({ filename: 'big.png', mime: 'image/png', size: 20 * 1024 * 1024 + 1 });
		expect(res.status).toBe(400);
	});

	it('2. rejects a disallowed mime with 400', async () => {
		const res = await post({ filename: 'archive.zip', mime: 'application/zip', size: 1000 });
		expect(res.status).toBe(400);
	});

	it('3. returns 200 with a presigned PUT url for a valid image/png', async () => {
		const res = await post({ filename: 'photo.png', mime: 'image/png', size: 1000 });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; r2_key: string; url: string };
		expect(typeof body.id).toBe('string');
		expect(typeof body.r2_key).toBe('string');
		expect(typeof body.url).toBe('string');
		expect(body.url.length).toBeGreaterThan(0);
		expect(body.url).toContain(body.r2_key);
		expect(hasExpiry(body.url)).toBe(true);
	});
});

describe('POST /issues/:issue_number/attachments/:id/confirm', () => {
	it('4. writes the attachments row', async () => {
		const reqRes = await post({ filename: 'photo.png', mime: 'image/png', size: 1000 });
		const requested = (await reqRes.json()) as { id: string; r2_key: string };

		const res = await SELF.fetch(`${base}/${requested.id}/confirm`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
			body: JSON.stringify({ r2_key: requested.r2_key, filename: 'photo.png', mime: 'image/png', size: 1000 }),
		});
		expect(res.status).toBe(200);

		const row = await env.DB.prepare('SELECT * FROM attachments WHERE id = ?').bind(requested.id).first();
		expect(row).not.toBeNull();
		expect(row!.issue_id).toBe(ISSUE_ID);
		expect(row!.uploader_id).toBe(USER_ID);
		expect(row!.r2_key).toBe(requested.r2_key);
	});
});

describe('GET /issues/:issue_number/attachments/:id', () => {
	it('5. returns 200 with a presigned GET url after confirm', async () => {
		const reqRes = await post({ filename: 'photo.png', mime: 'image/png', size: 1000 });
		const requested = (await reqRes.json()) as { id: string; r2_key: string };
		await SELF.fetch(`${base}/${requested.id}/confirm`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
			body: JSON.stringify({ r2_key: requested.r2_key, filename: 'photo.png', mime: 'image/png', size: 1000 }),
		});

		const res = await SELF.fetch(`${base}/${requested.id}`, { headers: { cookie: AUTH_COOKIE } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { url: string };
		expect(typeof body.url).toBe('string');
		expect(body.url.length).toBeGreaterThan(0);
		expect(body.url).toContain(requested.r2_key);
		expect(hasExpiry(body.url)).toBe(true);
	});
});
