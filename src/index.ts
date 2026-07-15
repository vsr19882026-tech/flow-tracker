import { Hono } from 'hono';
import { createAuth, emailGuard } from './auth';
import { checkMagicLinkRateLimit } from './rate-limit';
import issues from './routes/issues';
import comments from './routes/comments';
import projects from './routes/projects';

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
		// Rate-limit the endpoint before doing any work (allowlist check, email
		// send). Runs first so abuse is throttled regardless of email validity.
		const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
		const rl = await checkMagicLinkRateLimit(c.env.CACHE, email ?? 'unknown', ip);
		if (rl.limited) {
			// Workers Logs: surface the email + IP + count on every throttled hit.
			console.warn(
				JSON.stringify({ event: 'magic_link_rate_limited', scope: rl.scope, email: rl.email, ip: rl.ip, count: rl.count }),
			);
			return c.json({ error: 'Too many requests. Try again later.' }, 429, { 'Retry-After': String(rl.retryAfter) });
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

// Projects feature — same resolved session; issues can be linked to a project.
app.route('/projects', projects);

// Comments feature — mounted with the :issue_number param so the sub-app can
// read it and resolve the issue's uuid for comments.issue_id.
app.route('/issues/:issue_number/comments', comments);

// Surface unhandled errors instead of silently turning them into a 500 body.
// Log the method + path + message to Workers Logs, then rethrow so the runtime
// records an exception outcome — that is what `wrangler tail --status error`
// (and the /tail command) filters on. The client still gets a 500.
//
// The rethrow re-enters onError at each Hono mounted-app / middleware boundary
// it bubbles through, so tag the error and log only the first time we see it.
app.onError((err, c) => {
	const tagged = err as Error & { logged?: boolean };
	if (!tagged.logged) {
		tagged.logged = true;
		console.error(JSON.stringify({ event: 'unhandled_error', method: c.req.method, path: c.req.path, error: err.message }));
	}
	throw err;
});

export default app;
