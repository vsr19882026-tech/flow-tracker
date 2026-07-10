import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';

// Contract tests for the issues feature, written BEFORE the implementation
// exists (TDD). Until `POST/GET /issues` are wired into the worker, every
// request 404s and all seven cases fail on the missing route — the schema
// setup below must still succeed so failures are never setup errors.

const USER_ID = 'user_test_1';
const USER_EMAIL = 'tester@example.com';
const SESSION_TOKEN = 'test-session-token-abc';
const AUTH_COOKIE = `better-auth.session=${SESSION_TOKEN}`;
// Bare raw token; the session middleware does split('.')[0], so no HMAC needed.

// Apply a clean schema + a seeded authenticated session before each test.
beforeEach(async () => {
	const db = env.DB;
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

	// Seed the authenticated user + a valid (far-future) session.
	await db
		.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`)
		.bind(USER_ID, 'Tester', USER_EMAIL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
	await db
		.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind('sess_1', USER_ID, SESSION_TOKEN, '2999-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
});

describe('POST /issues', () => {
	it('1. returns 401 when no session cookie is sent', async () => {
		const res = await SELF.fetch('http://tracker.test/issues', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title: 'No auth' }),
		});
		expect(res.status).toBe(401);
	});

	it('2. returns 400 when title is missing from the body', async () => {
		const res = await SELF.fetch('http://tracker.test/issues', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
			body: JSON.stringify({ description: 'no title here' }),
		});
		expect(res.status).toBe(400);
	});

	it('3. returns 200 with { id, issue_number, title, status } when valid', async () => {
		const res = await SELF.fetch('http://tracker.test/issues', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
			body: JSON.stringify({ title: 'First issue' }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			id: expect.any(String),
			issue_number: expect.any(Number),
			title: 'First issue',
			status: 'open',
		});
	});

	it('4. inserts a row into D1.issues with reporter_id and issue_number starting at 1', async () => {
		const res = await SELF.fetch('http://tracker.test/issues', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
			body: JSON.stringify({ title: 'Auto number' }),
		});
		expect(res.status).toBe(200);

		const { results } = await env.DB.prepare('SELECT * FROM issues').all();
		expect(results.length).toBe(1);
		expect(results[0].reporter_id).toBe(USER_ID);
		expect(results[0].issue_number).toBe(1);
		expect(results[0].title).toBe('Auto number');
	});
});

describe('GET /issues', () => {
	it('5. returns 401 when no session cookie', async () => {
		const res = await SELF.fetch('http://tracker.test/issues');
		expect(res.status).toBe(401);
	});

	it('6. returns all issues ordered by issue_number desc when authenticated', async () => {
		// Seed two issues directly.
		await env.DB.prepare(
			`INSERT INTO issues (id, reporter_id, title, issue_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		)
			.bind('issue_1', USER_ID, 'Older', 1, 1000, 1000)
			.run();
		await env.DB.prepare(
			`INSERT INTO issues (id, reporter_id, title, issue_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		)
			.bind('issue_2', USER_ID, 'Newer', 2, 2000, 2000)
			.run();

		const res = await SELF.fetch('http://tracker.test/issues', { headers: { cookie: AUTH_COOKIE } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ issue_number: number }>;
		expect(body.map((i) => i.issue_number)).toEqual([2, 1]);
	});

	it('7. returns an empty array when the table is empty', async () => {
		const res = await SELF.fetch('http://tracker.test/issues', { headers: { cookie: AUTH_COOKIE } });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toEqual([]);
	});
});
