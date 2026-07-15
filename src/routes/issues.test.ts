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
				role TEXT NOT NULL DEFAULT 'member',
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
				priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
				issue_number INTEGER NOT NULL,
				project_id TEXT,
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

describe('PATCH /issues/:issue_number', () => {
	// Seed a single issue with a known number, status, and updated_at.
	async function seedIssue(issueNumber: number, status = 'open', updatedAt = 1000) {
		await env.DB.prepare(
			`INSERT INTO issues (id, reporter_id, title, status, issue_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(`issue_${issueNumber}`, USER_ID, `Issue ${issueNumber}`, status, issueNumber, 1000, updatedAt)
			.run();
	}

	const patch = (n: number | string, body: unknown, auth = true) =>
		SELF.fetch(`http://tracker.test/issues/${n}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json', ...(auth ? { cookie: AUTH_COOKIE } : {}) },
			body: JSON.stringify(body),
		});

	it('1. returns 401 when no session cookie', async () => {
		const res = await patch(1, { status: 'done' }, false);
		expect(res.status).toBe(401);
	});

	it('2. returns 404 when the issue_number does not exist', async () => {
		const res = await patch(999, { status: 'done' });
		expect(res.status).toBe(404);
	});

	it('3. returns 400 when status is missing', async () => {
		await seedIssue(1);
		const res = await patch(1, {});
		expect(res.status).toBe(400);
	});

	it('4. returns 400 when status is not a valid value', async () => {
		await seedIssue(1);
		const res = await patch(1, { status: 'wontfix' });
		expect(res.status).toBe(400);
	});

	it('5. returns 200 with the updated body when moving open -> in_progress', async () => {
		await seedIssue(1, 'open');
		const res = await patch(1, { status: 'in_progress' });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ id: 'issue_1', issue_number: 1, title: 'Issue 1', status: 'in_progress' });
	});

	it('6. persists the status and a new updated_at to D1', async () => {
		await seedIssue(1, 'open', 1000);
		await patch(1, { status: 'done' });
		const row = await env.DB.prepare('SELECT status, updated_at FROM issues WHERE issue_number = 1').first<{
			status: string;
			updated_at: number;
		}>();
		expect(row!.status).toBe('done');
		expect(row!.updated_at).toBeGreaterThan(1000);
	});
});

describe('GET /issues/:issue_number', () => {
	// Seed a single issue with a known number and reporter.
	async function seedIssue(issueNumber: number, status = 'open') {
		await env.DB.prepare(
			`INSERT INTO issues (id, reporter_id, title, status, issue_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(`issue_${issueNumber}`, USER_ID, `Issue ${issueNumber}`, status, issueNumber, 1000, 1000)
			.run();
	}

	const get = (n: number | string, auth = true) =>
		SELF.fetch(`http://tracker.test/issues/${n}`, {
			headers: { ...(auth ? { cookie: AUTH_COOKIE } : {}) },
		});

	it('1. returns 401 when no session cookie', async () => {
		await seedIssue(1);
		const res = await get(1, false);
		expect(res.status).toBe(401);
	});

	it('2. returns 404 when the issue_number does not exist', async () => {
		const res = await get(999);
		expect(res.status).toBe(404);
	});

	it('3. returns 200 with the full issue row when it exists', async () => {
		await seedIssue(1, 'in_progress');
		const res = await get(1);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			id: 'issue_1',
			issue_number: 1,
			title: 'Issue 1',
			status: 'in_progress',
			reporter_id: USER_ID,
		});
	});

	it('4. returns 404 when the issue_number is not numeric', async () => {
		const res = await get('abc');
		expect(res.status).toBe(404);
	});
});

describe('issue detail + rich PATCH', () => {
	const ADMIN_ID = 'user_admin_1';
	const ADMIN_TOKEN = 'admin-session-token';
	const ADMIN_COOKIE = `better-auth.session=${ADMIN_TOKEN}`;
	const OTHER_ID = 'user_other_1';
	const OTHER_TOKEN = 'other-session-token';
	const OTHER_COOKIE = `better-auth.session=${OTHER_TOKEN}`;

	// Seed an extra user with a chosen role plus a far-future session.
	async function seedUser(id: string, email: string, role: string, token: string) {
		await env.DB.prepare(
			`INSERT INTO "user" (id, name, email, emailVerified, role, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?, ?)`,
		)
			.bind(id, id, email, role, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
			.run();
		await env.DB.prepare(
			`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
		)
			.bind(`sess_${id}`, id, token, '2999-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
			.run();
	}

	// Seed an issue owned by USER_ID with a known uuid + number.
	async function seedIssue(uuid: string, issueNumber: number, reporterId = USER_ID) {
		await env.DB.prepare(
			`INSERT INTO issues (id, reporter_id, title, description, status, priority, issue_number, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(uuid, reporterId, `Issue ${issueNumber}`, 'orig desc', 'open', 'medium', issueNumber, 1000, 1000)
			.run();
	}

	const patch = (n: number | string, body: unknown, cookie?: string) =>
		SELF.fetch(`http://tracker.test/issues/${n}`, {
			method: 'PATCH',
			headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
			body: JSON.stringify(body),
		});

	it('1. GET returns the issue plus its comments oldest-first', async () => {
		await seedIssue('issue_uuid_1', 1);
		await env.DB.prepare(`INSERT INTO comments (id, issue_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)`)
			.bind('c_2', 'issue_uuid_1', USER_ID, 'second', 2000)
			.run();
		await env.DB.prepare(`INSERT INTO comments (id, issue_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)`)
			.bind('c_1', 'issue_uuid_1', USER_ID, 'first', 1000)
			.run();

		const res = await SELF.fetch('http://tracker.test/issues/1', { headers: { cookie: AUTH_COOKIE } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; comments: Array<{ id: string; body: string }> };
		expect(body.id).toBe('issue_uuid_1');
		expect(body.comments.map((cm) => cm.body)).toEqual(['first', 'second']);
	});

	it('2. PATCH by the reporter updates title+description+status+priority and persists', async () => {
		await seedIssue('issue_uuid_1', 1);
		const res = await patch(1, { title: 'New title', description: 'New desc', status: 'done', priority: 'high' }, AUTH_COOKIE);
		expect(res.status).toBe(200);

		const row = await env.DB.prepare('SELECT title, description, status, priority FROM issues WHERE issue_number = 1').first<{
			title: string;
			description: string;
			status: string;
			priority: string;
		}>();
		expect(row).toMatchObject({ title: 'New title', description: 'New desc', status: 'done', priority: 'high' });
	});

	it('3. PATCH by an admin who is not the reporter succeeds', async () => {
		await seedIssue('issue_uuid_1', 1);
		await seedUser(ADMIN_ID, 'admin@example.com', 'admin', ADMIN_TOKEN);
		const res = await patch(1, { status: 'in_progress' }, ADMIN_COOKIE);
		expect(res.status).toBe(200);
	});

	it('4. PATCH by a non-reporter non-admin is forbidden', async () => {
		await seedIssue('issue_uuid_1', 1);
		await seedUser(OTHER_ID, 'other@example.com', 'member', OTHER_TOKEN);
		const res = await patch(1, { status: 'in_progress' }, OTHER_COOKIE);
		expect(res.status).toBe(403);
	});

	it('5. PATCH with an invalid priority is a 400', async () => {
		await seedIssue('issue_uuid_1', 1);
		const res = await patch(1, { status: 'open', priority: 'urgent' }, AUTH_COOKIE);
		expect(res.status).toBe(400);
	});

	it('6. PATCH of an unknown issue_number is a 404', async () => {
		const res = await patch(999, { status: 'done' }, AUTH_COOKIE);
		expect(res.status).toBe(404);
	});
});

// ship smoke: no-op comment to exercise /ship (S16 verify)
