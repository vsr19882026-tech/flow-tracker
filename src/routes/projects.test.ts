import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';

// Contract tests for the projects feature + the project_id link on issues,
// written BEFORE the implementation exists (TDD). The schema setup below must
// always succeed, so a red run fails on behaviour (missing route / wrong status),
// never on a setup error.

const USER_ID = 'user_test_1';
const USER_EMAIL = 'tester@example.com';
const SESSION_TOKEN = 'test-session-token-abc';
const AUTH_COOKIE = `better-auth.session=${SESSION_TOKEN}`;
// Bare raw token; the session middleware does split('.')[0], so no HMAC needed.

// A second owner, used to prove ownership scoping (list + issue 403).
const OTHER_USER_ID = 'user_test_2';
const OTHER_USER_EMAIL = 'other@example.com';

// Apply a clean schema + a seeded authenticated session before each test.
beforeEach(async () => {
	const db = env.DB;
	await db.exec('DROP TABLE IF EXISTS issues');
	await db.exec('DROP TABLE IF EXISTS projects');
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
			`CREATE TABLE projects (
				id TEXT PRIMARY KEY,
				owner_id TEXT NOT NULL REFERENCES "user"(id),
				name TEXT NOT NULL,
				slug TEXT NOT NULL UNIQUE,
				created_at INTEGER NOT NULL
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
				project_id TEXT REFERENCES projects(id),
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
		.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`)
		.bind(OTHER_USER_ID, 'Other', OTHER_USER_EMAIL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
	await db
		.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind('sess_1', USER_ID, SESSION_TOKEN, '2999-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
});

// Seed a project directly, owned by the given user.
async function seedProject(id: string, ownerId: string, name: string, slug: string, createdAt = 1000) {
	await env.DB.prepare(`INSERT INTO projects (id, owner_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(id, ownerId, name, slug, createdAt)
		.run();
}

describe('POST /projects', () => {
	it('1. returns 401 when no session cookie is sent', async () => {
		const res = await SELF.fetch('http://tracker.test/projects', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'No auth', slug: 'no-auth' }),
		});
		expect(res.status).toBe(401);
	});

	it('2. returns 400 when slug does not match /^[a-z0-9-]+$/', async () => {
		const res = await SELF.fetch('http://tracker.test/projects', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
			body: JSON.stringify({ name: 'Bad slug', slug: 'Not A Slug!' }),
		});
		expect(res.status).toBe(400);
	});

	it('3. returns 200 with the created project and inserts a row into D1', async () => {
		const res = await SELF.fetch('http://tracker.test/projects', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
			body: JSON.stringify({ name: 'First project', slug: 'first-project' }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({
			id: expect.any(String),
			owner_id: USER_ID,
			name: 'First project',
			slug: 'first-project',
		});

		const { results } = await env.DB.prepare('SELECT * FROM projects').all();
		expect(results.length).toBe(1);
		expect(results[0].owner_id).toBe(USER_ID);
		expect(results[0].slug).toBe('first-project');
	});
});

describe('GET /projects', () => {
	it('4. returns only the caller\'s projects, excluding other owners', async () => {
		await seedProject('proj_mine', USER_ID, 'Mine', 'mine', 2000);
		await seedProject('proj_theirs', OTHER_USER_ID, 'Theirs', 'theirs', 3000);

		const res = await SELF.fetch('http://tracker.test/projects', { headers: { cookie: AUTH_COOKIE } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ id: string }>;
		expect(body.map((p) => p.id)).toEqual(['proj_mine']);
	});
});

describe('GET /projects/:slug', () => {
	it('5. returns 200 with the project when the slug exists', async () => {
		await seedProject('proj_mine', USER_ID, 'Mine', 'mine');
		const res = await SELF.fetch('http://tracker.test/projects/mine', { headers: { cookie: AUTH_COOKIE } });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ id: 'proj_mine', slug: 'mine', owner_id: USER_ID });
	});

	it('6. returns 404 when the slug does not exist', async () => {
		const res = await SELF.fetch('http://tracker.test/projects/nope', { headers: { cookie: AUTH_COOKIE } });
		expect(res.status).toBe(404);
	});
});

describe('POST /issues with project_id', () => {
	it('7. returns 200 and stores project_id when the caller owns the project', async () => {
		await seedProject('proj_mine', USER_ID, 'Mine', 'mine');
		const res = await SELF.fetch('http://tracker.test/issues', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
			body: JSON.stringify({ title: 'Scoped issue', project_id: 'proj_mine' }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.project_id).toBe('proj_mine');

		const row = await env.DB.prepare('SELECT project_id FROM issues WHERE id = ?')
			.bind(body.id)
			.first<{ project_id: string }>();
		expect(row!.project_id).toBe('proj_mine');
	});

	it('8. returns 403 when the project_id is owned by another user', async () => {
		await seedProject('proj_theirs', OTHER_USER_ID, 'Theirs', 'theirs');
		const res = await SELF.fetch('http://tracker.test/issues', {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
			body: JSON.stringify({ title: 'Sneaky issue', project_id: 'proj_theirs' }),
		});
		expect(res.status).toBe(403);
	});
});
