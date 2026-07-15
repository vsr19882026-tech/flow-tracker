import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';

// Contract tests for the comments feature, written BEFORE the implementation
// exists (TDD). Comments hang off an issue via its :issue_number, but persist
// against the issue's uuid (comments.issue_id → issues.id). The schema setup
// below must always succeed so a red test is a missing route, not a setup error.

const USER_ID = 'user_test_1';
const USER_EMAIL = 'tester@example.com';
const SESSION_TOKEN = 'test-session-token-abc';
const AUTH_COOKIE = `better-auth.session=${SESSION_TOKEN}`;
// Bare raw token; the session middleware does split('.')[0], so no HMAC needed.

const ISSUE_ID = 'issue_uuid_1';
const ISSUE_NUMBER = 1;

// Apply a clean schema + a seeded authenticated session + one issue before each test.
beforeEach(async () => {
	const db = env.DB;
	await db.exec('DROP TABLE IF EXISTS comments');
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
			`CREATE TABLE comments (
				id TEXT PRIMARY KEY,
				issue_id TEXT NOT NULL REFERENCES issues(id),
				author_id TEXT NOT NULL REFERENCES "user"(id),
				body TEXT NOT NULL,
				created_at INTEGER NOT NULL
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

	// Seed one issue: number 1, uuid ISSUE_ID. Comments resolve number → uuid.
	await db
		.prepare(
			`INSERT INTO issues (id, reporter_id, title, status, issue_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(ISSUE_ID, USER_ID, 'Host issue', 'open', ISSUE_NUMBER, 1000, 1000)
		.run();
});

describe('POST /issues/:issue_number/comments', () => {
	it('1. returns 401 when no session cookie is sent', async () => {
		const res = await SELF.fetch(`http://tracker.test/issues/${ISSUE_NUMBER}/comments`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ body: 'unauthenticated' }),
		});
		expect(res.status).toBe(401);
	});

	it('2. returns 400 when the body exceeds 4000 characters', async () => {
		const res = await SELF.fetch(`http://tracker.test/issues/${ISSUE_NUMBER}/comments`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
			body: JSON.stringify({ body: 'x'.repeat(4001) }),
		});
		expect(res.status).toBe(400);
	});

	it('3. returns 200 and persists the comment against the issue uuid when valid', async () => {
		const res = await SELF.fetch(`http://tracker.test/issues/${ISSUE_NUMBER}/comments`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
			body: JSON.stringify({ body: 'First comment' }),
		});
		expect(res.status).toBe(200);
		const created = (await res.json()) as Record<string, unknown>;
		expect(created).toMatchObject({
			id: expect.any(String),
			issue_id: ISSUE_ID,
			author_id: USER_ID,
			body: 'First comment',
		});

		const { results } = await env.DB.prepare('SELECT * FROM comments').all();
		expect(results.length).toBe(1);
		expect(results[0].issue_id).toBe(ISSUE_ID);
		expect(results[0].author_id).toBe(USER_ID);
		expect(results[0].body).toBe('First comment');
	});
});

describe('GET /issues/:issue_number/comments', () => {
	it('4. returns the issue comments ordered created_at ascending (oldest first)', async () => {
		await env.DB.prepare(`INSERT INTO comments (id, issue_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)`)
			.bind('comment_newer', ISSUE_ID, USER_ID, 'Newer', 2000)
			.run();
		await env.DB.prepare(`INSERT INTO comments (id, issue_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)`)
			.bind('comment_older', ISSUE_ID, USER_ID, 'Older', 1000)
			.run();

		const res = await SELF.fetch(`http://tracker.test/issues/${ISSUE_NUMBER}/comments`, {
			headers: { cookie: AUTH_COOKIE },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ body: string; created_at: number }>;
		expect(body.map((c) => c.body)).toEqual(['Older', 'Newer']);
	});
});
