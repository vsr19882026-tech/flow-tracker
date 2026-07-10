import { Hono } from 'hono';
import { createAuth, emailGuard } from './auth';
import issues from './routes/issues';

// BETTER_AUTH_SECRET is a Worker secret (set via `wrangler secret put`), so it
// isn't in the wrangler-generated Env. Merge it into the global Bindings type.
declare global {
	interface Env {
		BETTER_AUTH_SECRET: string;
	}
}

type Variables = {
	user: { id: string; email: string } | null;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Session middleware. Auth routes are public (you can't have a session before
// signing in); every other route gets a session looked up directly from D1.
app.use('*', async (c, next) => {
	if (c.req.path.startsWith('/auth')) {
		return next();
	}

	c.set('user', null);

	const cookie = c.req.header('Cookie') ?? '';
	// Cookie is `__Secure-better-auth.session_token` on HTTPS, `better-auth.session_token`
	// otherwise. The value is `<raw-token>.<hmac-signature>`; the DB stores only the raw token.
	const match = cookie.match(/(?:__Secure-)?better-auth\.session(?:_token)?=([^;]+)/);
	if (match) {
		const rawToken = decodeURIComponent(match[1]).split('.')[0];
		// expiresAt is stored as an ISO date string → compare with datetime('now'), not Date.now().
		const row = await c.env.DB.prepare(
			`SELECT u.id, u.email
			   FROM session s
			   JOIN user u ON u.id = s.userId
			  WHERE s.token = ? AND s.expiresAt > datetime('now')`,
		)
			.bind(rawToken)
			.first<{ id: string; email: string }>();
		if (row) {
			c.set('user', { id: row.id, email: row.email });
		}
	}

	return next();
});

// Better Auth handler. Guard the allowlist BEFORE handing off: clone the raw
// request to read the body (c.req.json() would consume the stream and Better
// Auth would then see an empty body and 404), then pass the ORIGINAL request on.
app.on(['POST', 'GET'], '/auth/*', async (c) => {
	if (c.req.method === 'POST' && c.req.path.includes('/sign-in/magic-link')) {
		let email: string | undefined;
		try {
			const body = (await c.req.raw.clone().json()) as { email?: string };
			email = body.email;
		} catch {
			email = undefined;
		}
		const blocked = emailGuard(email);
		if (blocked) return blocked;
	}

	const auth = createAuth(c.env);
	return auth.handler(c.req.raw);
});

app.get('/', (c) => {
	const user = c.get('user');
	return c.text(user ? `Flow Tracker — signed in as ${user.email}` : 'Flow Tracker');
});

// Session probe: 200 with the user when the session cookie resolves, else 401.
app.get('/whoami', (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}
	return c.json({ user: { id: user.id, email: user.email } });
});

// Issues feature — the session middleware above has already resolved c.get('user').
app.route('/issues', issues);

export default app;
