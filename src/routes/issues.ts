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

	const row = await c.env.DB.prepare('SELECT * FROM issues WHERE issue_number = ?').bind(issueNumber).first();
	if (!row) {
		return c.json({ error: 'Not found' }, 404);
	}
	return c.json(row);
});

const VALID_STATUSES = ['open', 'in_progress', 'done'];

// PATCH /issues/:issue_number — change an issue's status.
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
	const body = (await c.req.json()) as { status?: unknown };
	// Validate against the same set as the DB CHECK constraint, so a bad value is
	// a clean 400 rather than a 500 from the constraint.
	if (typeof body.status !== 'string' || !VALID_STATUSES.includes(body.status)) {
		return c.json({ error: "status must be one of 'open', 'in_progress', 'done'" }, 400);
	}

	const row = await c.env.DB.prepare(
		`UPDATE issues SET status = ?, updated_at = ? WHERE issue_number = ?
		 RETURNING id, issue_number, title, status`,
	)
		.bind(body.status, Date.now(), issueNumber)
		.first<{ id: string; issue_number: number; title: string; status: string }>();

	if (!row) {
		return c.json({ error: 'Not found' }, 404);
	}
	return c.json(row);
});

export default issues;
