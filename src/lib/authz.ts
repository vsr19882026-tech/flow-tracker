import { HTTPException } from 'hono/http-exception';
import type { Context, MiddlewareHandler } from 'hono';

// The three global user roles. user.role has no DB CHECK (see 0005_rbac.sql), so
// the app owns this invariant: an unrecognized role is treated as least-privileged.
export const USER_ROLES = ['admin', 'member', 'viewer'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function isValidUserRole(role: string): role is UserRole {
	return (USER_ROLES as readonly string[]).includes(role);
}

// The signed-in user as resolved by the session middleware in index.ts.
export type AuthUser = { id: string; email: string; role: string };

async function projectRole(db: D1Database, projectId: string, userId: string): Promise<string | null> {
	const row = await db
		.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
		.bind(projectId, userId)
		.first<{ role: string }>();
	return row ? row.role : null;
}

/**
 * May the user write in this project?
 * - admin writes anywhere.
 * - a project owner/editor writes within that project.
 * - an unscoped write (project_id null — legacy S1 issues with no project) is
 *   allowed for any non-viewer; viewers are read-only everywhere.
 */
export async function canWrite(user: AuthUser, projectId: string | null, db: D1Database): Promise<boolean> {
	if (user.role === 'admin') return true;
	if (projectId === null) return user.role !== 'viewer';
	const role = await projectRole(db, projectId, user.id);
	return role === 'owner' || role === 'editor';
}

/**
 * May the user read in this project?
 * - admin reads anywhere.
 * - any project member (owner/editor/viewer) reads within that project.
 * - a project with no member rows yet, or an unscoped issue (project_id null),
 *   is readable by any signed-in user (legacy S1 issues predate memberships).
 */
export async function canRead(user: AuthUser, projectId: string | null, db: D1Database): Promise<boolean> {
	if (user.role === 'admin') return true;
	if (projectId === null) return true;
	if ((await projectRole(db, projectId, user.id)) !== null) return true;
	const anyMember = await db.prepare('SELECT 1 FROM project_members WHERE project_id = ? LIMIT 1').bind(projectId).first();
	return anyMember === null;
}

/**
 * Gate an admin-only route. Throws a 403 that app.onError turns into a clean
 * response (it passes HTTPException through). Wired into admin routes in a later step.
 */
export function requireAdmin(user: AuthUser): void {
	if (user.role !== 'admin') {
		throw new HTTPException(403, { message: 'Admin only' });
	}
}

// ---- middleware ----
// RBAC is enforced in middleware, not route handlers, so the check is identical
// on every route and Step 3's audit log can wrap it. Each factory takes a
// resolver that derives the request's project_id (from the body, a path param,
// or the parent issue), then gates on canWrite / canRead.
export type ResolveProjectId = (c: Context) => Promise<string | null>;

export function writeGuard(resolve: ResolveProjectId): MiddlewareHandler {
	return async (c, next) => {
		const user = c.get('user') as AuthUser | null;
		if (!user) return c.json({ error: 'Unauthorized' }, 401);
		const projectId = await resolve(c);
		if (!(await canWrite(user, projectId, c.env.DB))) {
			return c.json({ error: 'Forbidden' }, 403);
		}
		return next();
	};
}

export function readGuard(resolve: ResolveProjectId): MiddlewareHandler {
	return async (c, next) => {
		const user = c.get('user') as AuthUser | null;
		if (!user) return c.json({ error: 'Unauthorized' }, 401);
		const projectId = await resolve(c);
		if (!(await canRead(user, projectId, c.env.DB))) {
			return c.json({ error: 'Forbidden' }, 403);
		}
		return next();
	};
}

// Resolvers shared by the issue + comment routes.
// The issue's project_id, keyed off the :issue_number path param (null if the
// issue does not exist or is unscoped).
export const projectIdFromIssueNumber: ResolveProjectId = async (c) => {
	const issueNumber = Number(c.req.param('issue_number'));
	if (!Number.isInteger(issueNumber)) return null;
	// c is a bare Context here (untyped env), so cast the row rather than using a
	// typed .first<T>() call, which TS rejects on an untyped receiver.
	const row = (await c.env.DB.prepare('SELECT project_id FROM issues WHERE issue_number = ?')
		.bind(issueNumber)
		.first()) as { project_id: string | null } | null;
	return row ? row.project_id : null;
};

// The project_id supplied in a JSON body (POST /issues). Hono caches the parsed
// body, so the handler's own c.req.json() re-reads it without a second parse.
export const projectIdFromBody: ResolveProjectId = async (c) => {
	const body = (await c.req.json()) as { project_id?: unknown };
	return typeof body.project_id === 'string' ? body.project_id : null;
};

// The list endpoints have no single project; canRead's null path lets any
// signed-in user read (per-project filtering of the list is out of scope here).
export const noProject: ResolveProjectId = async () => null;
