import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';

// Layout Studio: GET editor (admin-only), POST save (registry-validated, new
// active version), POST revert (reactivate the previous version).

const ADMIN_ID = 'la_admin';
const ADMIN_TOKEN = 'la-admin-token';
const ADMIN_COOKIE = `better-auth.session=${ADMIN_TOKEN}`;
const MEMBER_TOKEN = 'la-member-token';
const MEMBER_COOKIE = `better-auth.session=${MEMBER_TOKEN}`;

async function seedUser(id: string, role: string, token: string): Promise<void> {
	await env.DB.prepare(`INSERT INTO "user" (id, name, email, emailVerified, role, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?, ?)`)
		.bind(id, id, `${id}@example.com`, role, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
	await env.DB.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind(`sess_${id}_${token}`, id, token, '2999-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
}

// The registry-valid field set, reordered/edited per test.
function baseFields() {
	return [
		{ key: 'project', order: 0, visible: true, label: 'Project', section: '' },
		{ key: 'title', order: 1, visible: true, label: 'Title', section: '' },
		{ key: 'description', order: 2, visible: true, label: 'Description', section: '' },
		{ key: 'status', order: 3, visible: true, label: 'Status', section: '' },
	];
}

async function save(fields: unknown, cookie = ADMIN_COOKIE): Promise<Response> {
	return SELF.fetch('http://tracker.test/admin/layout', {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify({ fields }),
	});
}

async function activeVersion(): Promise<number | null> {
	const row = await env.DB.prepare('SELECT version FROM ui_layouts WHERE active = 1 ORDER BY version DESC LIMIT 1').first<{ version: number }>();
	return row ? row.version : null;
}

beforeEach(async () => {
	const db = env.DB;
	for (const t of ['ui_layouts', 'issues', 'projects', 'session', 'user']) {
		await db.exec(`DROP TABLE IF EXISTS ${t}`);
	}
	await db
		.prepare(`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, role TEXT NOT NULL DEFAULT 'member', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`)
		.run();
	await db
		.prepare(`CREATE TABLE "session" (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES "user"(id), token TEXT NOT NULL UNIQUE, expiresAt TEXT NOT NULL, ipAddress TEXT, userAgent TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`)
		.run();
	await db.prepare(`CREATE TABLE ui_layouts (id TEXT PRIMARY KEY, version INTEGER NOT NULL, layout_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 0)`).run();
	await db
		.prepare(`CREATE TABLE issues (id TEXT PRIMARY KEY, reporter_id TEXT, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'open', priority TEXT, issue_number INTEGER NOT NULL, project_id TEXT, created_at INTEGER, updated_at INTEGER)`)
		.run();
	await db.prepare(`CREATE TABLE projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, created_at INTEGER, sap_synced INTEGER NOT NULL DEFAULT 0)`).run();

	await seedUser(ADMIN_ID, 'admin', ADMIN_TOKEN);
	await seedUser('la_member', 'member', MEMBER_TOKEN);
});

describe('Layout Studio', () => {
	it('1. an admin GET renders 200 with draggable rows', async () => {
		const res = await SELF.fetch('http://tracker.test/admin/layout', { headers: { cookie: ADMIN_COOKIE } });
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('id="lfList"');
		expect(html).toContain('class="lf-row'); // a draggable row
		expect(html).toContain('data-key="title"');
		expect(html).toContain('sortablejs'); // SortableJS CDN
	});

	it('2. a non-admin GET is 403', async () => {
		const res = await SELF.fetch('http://tracker.test/admin/layout', { headers: { cookie: MEMBER_COOKIE } });
		expect(res.status).toBe(403);
		await res.text();
	});

	it('3. saving a reordered layout creates a new active version the detail render reflects', async () => {
		// Put description before title.
		const fields = [
			{ key: 'description', order: 0, visible: true, label: 'Description', section: '' },
			{ key: 'title', order: 1, visible: true, label: 'Title', section: '' },
			{ key: 'status', order: 2, visible: true, label: 'Status', section: '' },
		];
		const res = await save(fields);
		expect(res.status).toBe(200);
		expect(await activeVersion()).toBe(1);

		// The board detail skeleton renders description (pDesc) before title (pTitle).
		const board = await SELF.fetch('http://tracker.test/board', { headers: { cookie: ADMIN_COOKIE } });
		const html = await board.text();
		expect(html.indexOf('pDesc')).toBeLessThan(html.indexOf('pTitle'));
	});

	it('4. hiding a required field (status) is rejected and leaves the active layout unchanged', async () => {
		await save(baseFields()); // v1 active
		const hidden = baseFields().map((f) => (f.key === 'status' ? { ...f, visible: false } : f));
		const res = await save(hidden);
		expect(res.status).toBe(400);
		expect(await activeVersion()).toBe(1); // unchanged
	});

	it('5. an unknown key is rejected and leaves the active layout unchanged', async () => {
		await save(baseFields()); // v1
		const res = await save([...baseFields(), { key: 'not_a_field', order: 9, visible: true, label: 'X', section: '' }]);
		expect(res.status).toBe(400);
		expect(await activeVersion()).toBe(1);
	});

	it('6. revert reactivates the previous version', async () => {
		await save(baseFields()); // v1
		await save(baseFields().map((f) => ({ ...f, label: f.label + '!' }))); // v2 active
		expect(await activeVersion()).toBe(2);

		const res = await SELF.fetch('http://tracker.test/admin/layout/revert', { method: 'POST', headers: { cookie: ADMIN_COOKIE } });
		expect(res.status).toBe(200);
		await res.text();
		expect(await activeVersion()).toBe(1);
	});

	it('7. reverting the only version clears the active flag (back to the default)', async () => {
		await save(baseFields()); // v1, the first custom layout
		const res = await SELF.fetch('http://tracker.test/admin/layout/revert', { method: 'POST', headers: { cookie: ADMIN_COOKIE } });
		expect(res.status).toBe(200);
		await res.text();
		expect(await activeVersion()).toBeNull(); // no active row → renderFields uses DEFAULT_LAYOUT
	});
});
