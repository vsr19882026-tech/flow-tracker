import { Hono } from 'hono';

// Same shape the session middleware in index.ts sets via c.set('user', ...).
type Variables = {
	user: { id: string; email: string } | null;
};

const issues = new Hono<{ Bindings: Env; Variables: Variables }>();

// POST /issues — create an issue for the signed-in user.
issues.post('/', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	// Malformed JSON throws and propagates (see app.onError) — the happy path
	// assumes a JSON body, per the project's no-try/catch rule.
	const body = (await c.req.json()) as { title?: unknown };
	const title = typeof body.title === 'string' ? body.title.trim() : '';
	if (!title) {
		return c.json({ error: 'title is required' }, 400);
	}

	const id = crypto.randomUUID();
	const status = 'open';
	const now = Date.now();

	// issue_number auto-increments from the current max; RETURNING hands back the
	// value the subquery resolved to, in a single round-trip.
	const row = await c.env.DB.prepare(
		`INSERT INTO issues (id, reporter_id, title, status, issue_number, created_at, updated_at)
		 VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(issue_number), 0) + 1 FROM issues), ?, ?)
		 RETURNING issue_number`,
	)
		.bind(id, user.id, title, status, now, now)
		.first<{ issue_number: number }>();

	return c.json({ id, issue_number: row!.issue_number, title, status });
});

// GET /issues — list all issues, newest issue_number first.
issues.get('/', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const { results } = await c.env.DB.prepare('SELECT * FROM issues ORDER BY issue_number DESC').all();
	return c.json(results);
});

// GET /issues/:issue_number — read a single issue by its number.
issues.get('/:issue_number', async (c) => {
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

const VALID_STATUSES = ['open', 'in_progress', 'done'];
const VALID_PRIORITIES = ['low', 'medium', 'high'];

// PATCH /issues/:issue_number — update any of title/description/status/priority.
issues.patch('/:issue_number', async (c) => {
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

	// Validate enum fields against the same sets as the DB CHECK constraints, so a
	// bad value is a clean 400 rather than a 500 from the constraint — before any DB.
	if (body.status !== undefined && (typeof body.status !== 'string' || !VALID_STATUSES.includes(body.status))) {
		return c.json({ error: "status must be one of 'open', 'in_progress', 'done'" }, 400);
	}
	if (body.priority !== undefined && (typeof body.priority !== 'string' || !VALID_PRIORITIES.includes(body.priority))) {
		return c.json({ error: "priority must be one of 'low', 'medium', 'high'" }, 400);
	}

	// Collect only the provided fields into a dynamic UPDATE set.
	const sets: string[] = [];
	const values: unknown[] = [];
	if (typeof body.title === 'string') {
		sets.push('title = ?');
		values.push(body.title);
	}
	if (typeof body.description === 'string') {
		sets.push('description = ?');
		values.push(body.description);
	}
	if (typeof body.status === 'string') {
		sets.push('status = ?');
		values.push(body.status);
	}
	if (typeof body.priority === 'string') {
		sets.push('priority = ?');
		values.push(body.priority);
	}
	if (sets.length === 0) {
		return c.json({ error: 'no updatable fields provided' }, 400);
	}

	// Load the issue to authorize the change (404 for unknown).
	const issue = await c.env.DB.prepare('SELECT reporter_id FROM issues WHERE issue_number = ?')
		.bind(issueNumber)
		.first<{ reporter_id: string }>();
	if (!issue) {
		return c.json({ error: 'Not found' }, 404);
	}

	// Only the reporter or an admin may update. Role lives on the Better Auth
	// "user" table; the shared middleware exposes just {id,email}, so read it here.
	const userRow = await c.env.DB.prepare('SELECT role FROM "user" WHERE id = ?').bind(user.id).first<{ role: string }>();
	if (issue.reporter_id !== user.id && userRow?.role !== 'admin') {
		return c.json({ error: 'Forbidden' }, 403);
	}

	sets.push('updated_at = ?');
	values.push(Date.now());
	values.push(issueNumber);

	const row = await c.env.DB.prepare(`UPDATE issues SET ${sets.join(', ')} WHERE issue_number = ? RETURNING *`)
		.bind(...values)
		.first();
	return c.json(row);
});

export default issues;
