import { Hono } from 'hono';

// Same shape the session middleware in index.ts sets via c.set('user', ...).
type Variables = {
	user: { id: string; email: string } | null;
};

// Mounted at /issues/:issue_number/comments, so :issue_number is on every path.
const comments = new Hono<{ Bindings: Env; Variables: Variables }>();

const MAX_BODY_LENGTH = 4000;

// Resolve the :issue_number path param to the issue's uuid. comments.issue_id
// references issues.id (the uuid), not the human-facing issue_number.
async function resolveIssueId(c: {
	env: Env;
	req: { param: (name: string) => string | undefined };
}): Promise<string | null> {
	const issueNumber = Number(c.req.param('issue_number'));
	if (!Number.isInteger(issueNumber)) {
		return null;
	}
	const row = await c.env.DB.prepare('SELECT id FROM issues WHERE issue_number = ?')
		.bind(issueNumber)
		.first<{ id: string }>();
	return row ? row.id : null;
}

// POST /issues/:issue_number/comments — add a comment to an issue.
comments.post('/', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const issueId = await resolveIssueId(c);
	if (!issueId) {
		return c.json({ error: 'Not found' }, 404);
	}

	// Malformed JSON throws and propagates (see app.onError) — the happy path
	// assumes a JSON body, per the project's no-try/catch rule.
	const parsed = (await c.req.json()) as { body?: unknown };
	const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
	if (!body || body.length > MAX_BODY_LENGTH) {
		return c.json({ error: `body is required and must be at most ${MAX_BODY_LENGTH} characters` }, 400);
	}

	const id = crypto.randomUUID();
	const createdAt = Date.now();

	await c.env.DB.prepare(`INSERT INTO comments (id, issue_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(id, issueId, user.id, body, createdAt)
		.run();

	return c.json({ id, issue_id: issueId, author_id: user.id, body, created_at: createdAt });
});

// GET /issues/:issue_number/comments — list the issue's comments, oldest first.
comments.get('/', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const issueId = await resolveIssueId(c);
	if (!issueId) {
		return c.json({ error: 'Not found' }, 404);
	}

	const { results } = await c.env.DB.prepare('SELECT * FROM comments WHERE issue_id = ? ORDER BY created_at ASC')
		.bind(issueId)
		.all();
	return c.json(results);
});

export default comments;
