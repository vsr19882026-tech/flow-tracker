import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';

// Browser UI: sign-in page, the /board render, root redirect, and role-gated nav.
// Client-side behaviour (panel, pills, upload) is browser-only; here we assert the
// server-rendered contract the DOM script depends on.

const ADMIN = { id: 'u_admin', email: 'admin@flow.test', role: 'admin', token: 'tok-admin' };
const MEMBER = { id: 'u_member', email: 'member@flow.test', role: 'member', token: 'tok-member' };
const VIEWER = { id: 'u_viewer', email: 'viewer@flow.test', role: 'viewer', token: 'tok-viewer' };

const cookie = (t: string) => `better-auth.session=${t}`;

beforeEach(async () => {
	const db = env.DB;
	await db.exec('DROP TABLE IF EXISTS ui_layouts');
	await db.exec('DROP TABLE IF EXISTS issues');
	await db.exec('DROP TABLE IF EXISTS projects');
	await db.exec('DROP TABLE IF EXISTS session');
	await db.exec('DROP TABLE IF EXISTS "user"');

	await db
		.prepare(
			`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
				emailVerified INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
				role TEXT NOT NULL DEFAULT 'member')`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE "session" (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES "user"(id), token TEXT NOT NULL UNIQUE,
				expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE issues (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
				status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'medium', issue_number INTEGER NOT NULL,
				project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(issue_number))`,
		)
		.run();
	await db
		.prepare(`CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, created_at INTEGER NOT NULL)`)
		.run();
	// The board loads the active layout; with no rows loadActiveLayout falls back
	// to the default, so the table just needs to exist.
	await db.prepare(`CREATE TABLE ui_layouts (id TEXT PRIMARY KEY, version INTEGER NOT NULL, layout_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0)`).run();

	const now = new Date().toISOString();
	for (const u of [ADMIN, MEMBER, VIEWER]) {
		await db
			.prepare(`INSERT INTO "user" (id, name, email, createdAt, updatedAt, role) VALUES (?, ?, ?, ?, ?, ?)`)
			.bind(u.id, u.id, u.email, now, now, u.role)
			.run();
		await db
			.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
			.bind('sess_' + u.id, u.id, u.token, '2999-12-31T23:59:59.999Z', now, now)
			.run();
	}
	// One issue per column so all three render with data.
	const seed: Array<[string, number, string, string]> = [
		['todo-issue', 1, 'open', 'high'],
		['prog-issue', 2, 'in_progress', 'medium'],
		['done-issue', 3, 'done', 'low'],
	];
	for (const [id, n, status, priority] of seed) {
		await db
			.prepare(`INSERT INTO issues (id, reporter_id, title, status, priority, issue_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(id, ADMIN.id, id, status, priority, n, n * 1000, n * 1000)
			.run();
	}
});

describe('GET /sign-in', () => {
	it('1. renders the magic-link form', async () => {
		const res = await SELF.fetch('http://tracker.test/sign-in');
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('Send magic link');
		expect(html).toContain('id="siEmail"');
	});

	it('2. shows the inbox banner when ?sent=1', async () => {
		const res = await SELF.fetch('http://tracker.test/sign-in?sent=1');
		expect(await res.text()).toContain('Check your inbox');
	});
});

describe('GET / redirects by auth state', () => {
	it('3. unauthenticated -> /sign-in', async () => {
		const res = await SELF.fetch('http://tracker.test/', { redirect: 'manual' });
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/sign-in');
	});

	it('4. authenticated -> /board', async () => {
		const res = await SELF.fetch('http://tracker.test/', { headers: { cookie: cookie(ADMIN.token) }, redirect: 'manual' });
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/board');
	});
});

describe('GET /board', () => {
	it('5. unauthenticated -> redirect to /sign-in', async () => {
		const res = await SELF.fetch('http://tracker.test/board', { redirect: 'manual' });
		expect(res.status).toBe(302);
		expect(res.headers.get('location')).toBe('/sign-in');
	});

	it('6. renders three columns with live issue data + nav for an admin', async () => {
		const res = await SELF.fetch('http://tracker.test/board', { headers: { cookie: cookie(ADMIN.token) } });
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('To Do');
		expect(html).toContain('In Progress');
		expect(html).toContain('Done');
		expect(html).toContain('todo-issue'); // a seeded issue title
		expect(html).toContain(ADMIN.email); // nav shows the user
		expect(html).toContain('id="signOut"');
		expect(html).toContain('href="/admin/users"'); // admin link
		expect(html).toContain('id="createBtn"'); // + Create
	});

	it('7. a member sees + Create but no Admin link', async () => {
		const html = await (await SELF.fetch('http://tracker.test/board', { headers: { cookie: cookie(MEMBER.token) } })).text();
		expect(html).toContain('id="createBtn"');
		expect(html).not.toContain('href="/admin/users"');
	});

	it('8. a viewer sees the board but no + Create, and ROLE is viewer', async () => {
		const html = await (await SELF.fetch('http://tracker.test/board', { headers: { cookie: cookie(VIEWER.token) } })).text();
		expect(html).toContain('class="board"');
		expect(html).not.toContain('id="createBtn"'); // no create button
		expect(html).toContain('var ROLE = "viewer"'); // client script hides pills/comment/attach off this
	});
});
