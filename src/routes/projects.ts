import { Hono } from 'hono';

// Same shape the session middleware in index.ts sets via c.set('user', ...).
type Variables = {
	user: { id: string; email: string } | null;
};

const projects = new Hono<{ Bindings: Env; Variables: Variables }>();

// A slug is lowercase letters, digits, and hyphens only. Validated in the app so
// a bad value is a clean 400, never a DB error.
const SLUG_RE = /^[a-z0-9-]+$/;

// POST /projects — create a project owned by the signed-in user.
projects.post('/', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	// Malformed JSON throws and propagates (see app.onError), per no-try/catch.
	const body = (await c.req.json()) as { name?: unknown; slug?: unknown };
	const name = typeof body.name === 'string' ? body.name.trim() : '';
	const slug = typeof body.slug === 'string' ? body.slug : '';
	if (!name) {
		return c.json({ error: 'name is required' }, 400);
	}
	// Validate the slug BEFORE touching the DB.
	if (!SLUG_RE.test(slug)) {
		return c.json({ error: 'slug must match /^[a-z0-9-]+$/' }, 400);
	}

	const id = crypto.randomUUID();
	const createdAt = Date.now();

	// A duplicate slug hits the UNIQUE constraint and throws → propagates to a 500
	// (see app.onError). That is acceptable per the project's no-try/catch rule.
	await c.env.DB.prepare(`INSERT INTO projects (id, owner_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)`)
		.bind(id, user.id, name, slug, createdAt)
		.run();

	return c.json({ id, owner_id: user.id, name, slug, created_at: createdAt });
});

// GET /projects — list only the caller's projects, newest first.
projects.get('/', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const { results } = await c.env.DB.prepare('SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at DESC')
		.bind(user.id)
		.all();
	return c.json(results);
});

// GET /projects/:slug — read a single project by its slug.
projects.get('/:slug', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const row = await c.env.DB.prepare('SELECT * FROM projects WHERE slug = ?').bind(c.req.param('slug')).first();
	if (!row) {
		return c.json({ error: 'Not found' }, 404);
	}
	return c.json(row);
});

export default projects;
