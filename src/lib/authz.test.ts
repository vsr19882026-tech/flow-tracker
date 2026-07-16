import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { canWrite, canRead, requireAdmin } from './authz';

// RBAC unit tests. canWrite/canRead read only project_members, so the schema
// here is just that table. Each test seeds a caller's project position (or none)
// and asserts the authorization decision.

const PROJECT = 'proj_1';

beforeEach(async () => {
	await env.DB.exec('DROP TABLE IF EXISTS project_members');
	await env.DB
		.prepare(
			`CREATE TABLE project_members (
				project_id TEXT NOT NULL,
				user_id TEXT NOT NULL,
				role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
				PRIMARY KEY (project_id, user_id)
			)`,
		)
		.run();
});

// A caller with a global role and (optionally) a seeded position in PROJECT.
async function caller(globalRole: string, projectPosition: 'owner' | 'editor' | 'viewer' | null) {
	const id = `u_${globalRole}_${projectPosition ?? 'none'}`;
	if (projectPosition) {
		await env.DB.prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)')
			.bind(PROJECT, id, projectPosition)
			.run();
	}
	return { id, email: `${id}@test`, role: globalRole };
}

// The write matrix: global role (admin/member/viewer) x project position
// (owner/editor/non-member). Only project members (or admins) may write.
describe('canWrite matrix — global role x project position', () => {
	it('1. admin + owner → true', async () => {
		expect(await canWrite(await caller('admin', 'owner'), PROJECT, env.DB)).toBe(true);
	});
	it('2. admin + editor → true', async () => {
		expect(await canWrite(await caller('admin', 'editor'), PROJECT, env.DB)).toBe(true);
	});
	it('3. admin + non-member → true (admin overrides project membership)', async () => {
		expect(await canWrite(await caller('admin', null), PROJECT, env.DB)).toBe(true);
	});
	it('4. member + owner → true', async () => {
		expect(await canWrite(await caller('member', 'owner'), PROJECT, env.DB)).toBe(true);
	});
	it('5. member + editor → true', async () => {
		expect(await canWrite(await caller('member', 'editor'), PROJECT, env.DB)).toBe(true);
	});
	it('6. member + non-member → false', async () => {
		expect(await canWrite(await caller('member', null), PROJECT, env.DB)).toBe(false);
	});
	it('7. viewer + owner → true (project role wins for members)', async () => {
		expect(await canWrite(await caller('viewer', 'owner'), PROJECT, env.DB)).toBe(true);
	});
	it('8. viewer + editor → true', async () => {
		expect(await canWrite(await caller('viewer', 'editor'), PROJECT, env.DB)).toBe(true);
	});
	it('9. viewer + non-member → false', async () => {
		expect(await canWrite(await caller('viewer', null), PROJECT, env.DB)).toBe(false);
	});
});

describe('canRead', () => {
	it('a project viewer may read', async () => {
		expect(await canRead(await caller('member', 'viewer'), PROJECT, env.DB)).toBe(true);
	});
	it('a non-member may NOT read a project that has members', async () => {
		await caller('member', 'owner'); // give the project at least one member
		expect(await canRead(await caller('viewer', null), PROJECT, env.DB)).toBe(false);
	});
	it('an admin may read any project', async () => {
		await caller('member', 'owner');
		expect(await canRead(await caller('admin', null), PROJECT, env.DB)).toBe(true);
	});
	it('any signed-in user may read a project with no members yet (legacy)', async () => {
		expect(await canRead(await caller('viewer', null), 'proj_empty', env.DB)).toBe(true);
	});
	it('any signed-in user may read/write an unscoped resource (project_id null)', async () => {
		expect(await canRead(await caller('viewer', null), null, env.DB)).toBe(true);
		expect(await canWrite(await caller('member', null), null, env.DB)).toBe(true);
		expect(await canWrite(await caller('viewer', null), null, env.DB)).toBe(false);
	});
});

describe('requireAdmin', () => {
	it('does not throw for an admin', () => {
		expect(() => requireAdmin({ id: 'a', email: 'a@t', role: 'admin' })).not.toThrow();
	});
	it('throws a 403 for a non-admin', async () => {
		// Capture the synchronous throw via a promise so no try/catch is needed.
		const err = await Promise.resolve()
			.then(() => requireAdmin({ id: 'm', email: 'm@t', role: 'member' }))
			.then(() => null, (e) => e);
		expect((err as { status: number }).status).toBe(403);
	});
});
