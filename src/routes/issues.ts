import { Hono } from 'hono';
import { writeGuard, readGuard, projectIdFromBody, projectIdFromIssueNumber, noProject } from '../lib/authz';
import { appendOutbox, outboxId } from '../lib/sap/outbox';
import { FIELD_REGISTRY } from '../lib/layout/registry';

// Same shape the session middleware in index.ts sets via c.set('user', ...).
type Variables = {
	user: { id: string; email: string; role: string } | null;
};

const issues = new Hono<{ Bindings: Env; Variables: Variables }>();

// POST /issues — create an issue for the signed-in user. writeGuard has already
// authorized the write against the body's project_id (canWrite).
issues.post('/', writeGuard(projectIdFromBody), async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	// Malformed JSON throws and propagates (see app.onError) — the happy path
	// assumes a JSON body, per the project's no-try/catch rule.
	const body = (await c.req.json()) as { title?: unknown; project_id?: unknown };
	// Validation reads ONLY from the field registry, never from a layout.
	const titleError = FIELD_REGISTRY.title.validate(body.title);
	if (titleError) {
		return c.json({ error: titleError }, 400);
	}
	const title = (body.title as string).trim();

	// An issue may optionally belong to a project. Authorization to write in that
	// project is writeGuard's job; here we confirm the project exists (404) and
	// read whether it opts into SAP sync.
	let projectId: string | null = null;
	let projectSynced = false;
	if (typeof body.project_id === 'string') {
		const project = await c.env.DB.prepare('SELECT id, sap_synced FROM projects WHERE id = ?')
			.bind(body.project_id)
			.first<{ id: string; sap_synced: number }>();
		if (!project) {
			return c.json({ error: 'Not found' }, 404);
		}
		projectId = body.project_id;
		projectSynced = !!project.sap_synced;
	}

	const id = crypto.randomUUID();
	const status = 'open';
	const now = Date.now();

	// issue_number auto-increments from the current max; RETURNING hands back the
	// value the subquery resolved to, in a single round-trip.
	const insert = c.env.DB.prepare(
		`INSERT INTO issues (id, reporter_id, title, status, project_id, issue_number, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(issue_number), 0) + 1 FROM issues), ?, ?)
		 RETURNING issue_number`,
	).bind(id, user.id, title, status, projectId, now, now);

	// A synced project's create is written atomically with its outbox row, then a
	// best-effort queue nudge (the reconcile cron re-enqueues if this throws).
	let issueNumber: number;
	if (projectSynced) {
		const outbox = appendOutbox(c.env.DB, id, 1, 'created', { title, status });
		const [insertResult] = await c.env.DB.batch([insert, outbox]);
		issueNumber = (insertResult.results[0] as { issue_number: number }).issue_number;
		await Promise.resolve()
			.then(() => c.env.SAP_OUTBOUND.send({ outboxId: outboxId(id, 1), issueId: id }))
			.then(() => {}, () => {});
	} else {
		const row = await insert.first<{ issue_number: number }>();
		issueNumber = row!.issue_number;
	}

	return c.json({ id, issue_number: issueNumber, title, status, project_id: projectId });
});

// GET /issues — list all issues, newest issue_number first. The list spans
// projects, so readGuard runs with no single project (any signed-in user reads).
issues.get('/', readGuard(noProject), async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const { results } = await c.env.DB.prepare('SELECT * FROM issues ORDER BY issue_number DESC').all();
	return c.json(results);
});

// GET /issues/:issue_number — read a single issue by its number. readGuard
// authorizes against the issue's own project_id (canRead).
issues.get('/:issue_number', readGuard(projectIdFromIssueNumber), async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const issueNumber = Number(c.req.param('issue_number'));
	if (!Number.isInteger(issueNumber)) {
		return c.json({ error: 'Not found' }, 404);
	}

	const row = await c.env.DB.prepare('SELECT * FROM issues WHERE issue_number = ?').bind(issueNumber).first<{ id: string }>();
	if (!row) {
		return c.json({ error: 'Not found' }, 404);
	}

	// Attach the issue's comments, oldest-first. comments.issue_id references the
	// issue's uuid (issues.id), not its issue_number.
	const { results: comments } = await c.env.DB.prepare('SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC')
		.bind(row.id)
		.all();
	return c.json({ ...row, comments });
});

// PATCH /issues/:issue_number — update any of title/description/status/priority.
// writeGuard authorizes the project-level write; the handler still enforces the
// issue-level rule that only the reporter (or an admin) may edit it.
issues.patch('/:issue_number', writeGuard(projectIdFromIssueNumber), async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const issueNumber = Number(c.req.param('issue_number'));
	if (!Number.isInteger(issueNumber)) {
		return c.json({ error: 'Not found' }, 404);
	}

	// Malformed JSON throws and propagates (see app.onError).
	const body = (await c.req.json()) as { title?: unknown; description?: unknown; status?: unknown; priority?: unknown };

	// Validate enum fields via the registry (the single source of field truth), so a
	// bad value is a clean 400 rather than a 500 from the DB CHECK — before any DB.
	if (body.status !== undefined) {
		const e = FIELD_REGISTRY.status.validate(body.status);
		if (e) return c.json({ error: e }, 400);
	}
	if (body.priority !== undefined) {
		const e = FIELD_REGISTRY.priority.validate(body.priority);
		if (e) return c.json({ error: e }, 400);
	}

	// Collect only the provided fields into a dynamic UPDATE set. `changed` mirrors
	// them for the SAP outbox payload.
	const sets: string[] = [];
	const values: unknown[] = [];
	const changed: Record<string, unknown> = {};
	if (typeof body.title === 'string') {
		sets.push('title = ?');
		values.push(body.title);
		changed.title = body.title;
	}
	if (typeof body.description === 'string') {
		sets.push('description = ?');
		values.push(body.description);
		changed.description = body.description;
	}
	if (typeof body.status === 'string') {
		sets.push('status = ?');
		values.push(body.status);
		changed.status = body.status;
	}
	if (typeof body.priority === 'string') {
		sets.push('priority = ?');
		values.push(body.priority);
		changed.priority = body.priority;
	}
	if (sets.length === 0) {
		return c.json({ error: 'no updatable fields provided' }, 400);
	}

	// Load the issue to authorize the change (404 for unknown). id + project_id let
	// the write path decide whether the issue's project opts into SAP sync.
	const issue = await c.env.DB.prepare('SELECT id, reporter_id, project_id FROM issues WHERE issue_number = ?')
		.bind(issueNumber)
		.first<{ id: string; reporter_id: string; project_id: string | null }>();
	if (!issue) {
		return c.json({ error: 'Not found' }, 404);
	}

	// Only the reporter or an admin may update. The session middleware now carries
	// the caller's role, so no extra lookup is needed.
	if (issue.reporter_id !== user.id && user.role !== 'admin') {
		return c.json({ error: 'Forbidden' }, 403);
	}

	sets.push('updated_at = ?');
	values.push(Date.now());
	values.push(issueNumber);

	const update = c.env.DB.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE issue_number = ? RETURNING *`).bind(...values);

	// Only issues in a sap_synced project produce an outbox row; a project-less or
	// non-synced issue takes the unchanged single-statement path.
	let synced = false;
	if (issue.project_id) {
		const project = await c.env.DB.prepare('SELECT sap_synced FROM projects WHERE id = ?')
			.bind(issue.project_id)
			.first<{ sap_synced: number }>();
		synced = !!(project && project.sap_synced);
	}

	if (synced) {
		// seq is the next per-issue outbox sequence.
		const last = await c.env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS last_seq FROM sap_outbox WHERE issue_id = ?')
			.bind(issue.id)
			.first<{ last_seq: number }>();
		const seq = last!.last_seq + 1;
		const outbox = appendOutbox(c.env.DB, issue.id, seq, 'updated', changed);
		const [updateResult] = await c.env.DB.batch([update, outbox]);
		await Promise.resolve()
			.then(() => c.env.SAP_OUTBOUND.send({ outboxId: outboxId(issue.id, seq), issueId: issue.id }))
			.then(() => {}, () => {});
		return c.json(updateResult.results[0]);
	}

	const row = await update.first();
	return c.json(row);
});

export default issues;
