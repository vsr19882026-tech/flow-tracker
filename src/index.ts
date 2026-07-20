import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createAuth, emailGuard } from './auth';
import { checkMagicLinkRateLimit } from './rate-limit';
import { log } from './log';
import { audit } from './middleware/audit';
import { runBackup } from './lib/backup';
import { processOutboundMessage } from './lib/sap/outbound';
import type { OutboundMessage } from './lib/sap/outbound';
import { processInboundMessage } from './lib/sap/inbound';
import type { InboundMessage } from './lib/sap/inbound';
import sapInbound from './routes/sap-inbound';
import issues from './routes/issues';
import attachments from './routes/attachments';
import comments from './routes/comments';
import projects from './routes/projects';
import admin from './routes/admin';
import ui from './routes/ui';

// Secrets set via `wrangler secret put` aren't in wrangler.toml, so they're not
// in the wrangler-generated Env — merge them into the global Bindings type.
// The SAP_* secrets back the SAP Cloud ALM ITSM sync; they stay unset until the
// real-SAP path is activated (sync runs against mock SAP until then), so at
// runtime they may be undefined and callers must guard before use.
declare global {
	interface Env {
		BETTER_AUTH_SECRET: string;
		SAP_TOKEN_URL: string;
		SAP_CLIENT_ID: string;
		SAP_CLIENT_SECRET: string;
		SAP_API_BASE: string;
		SAP_WEBHOOK_SECRET: string;
	}
}

type Variables = {
	user: { id: string; email: string; role: string } | null;
	requestId: string;
	logStart: number;
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Structured request logging (outermost, so it times and tags everything).
// Assign a request id, stamp the start, and emit request.started on entry and
// request.completed on exit with duration + status. An uncaught throw skips the
// completed line and is logged as request.errored by app.onError below.
app.use('*', async (c, next) => {
	c.set('requestId', crypto.randomUUID());
	const start = Date.now();
	c.set('logStart', start);
	log(c, 'info', 'request.started', { method: c.req.method });
	await next();
	log(c, 'info', 'request.completed', { method: c.req.method, duration_ms: Date.now() - start, status: c.res.status });
});

// Session middleware. Auth routes are public (you can't have a session before
// signing in); every other route gets a session looked up directly from D1.
app.use('*', async (c, next) => {
	// /auth is public (no session before sign-in); /integrations is machine-to-
	// machine (the SAP webhook authenticates by HMAC, not a session cookie).
	if (c.req.path.startsWith('/auth') || c.req.path.startsWith('/integrations')) {
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
			`SELECT u.id, u.email, u.role
			   FROM session s
			   JOIN user u ON u.id = s.userId
			  WHERE s.token = ? AND s.expiresAt > datetime('now')`,
		)
			.bind(rawToken)
			.first<{ id: string; email: string; role: string }>();
		if (row) {
			c.set('user', { id: row.id, email: row.email, role: row.role });
		}
	}

	return next();
});

// Audit middleware — after auth (needs the resolved user), before the handlers.
// Records one audit_log row per write; reads pass straight through.
app.use('*', audit);

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
		// Log every attempt (email + IP) so sign-in volume per email is queryable in
		// Workers Logs — this is what the abuse query in docs/logs-queries.md counts.
		log(c, 'info', 'magic_link.requested', { email: email?.toLowerCase() ?? 'unknown', ip });
		const rl = await checkMagicLinkRateLimit(c.env.CACHE, email ?? 'unknown', ip);
		if (rl.limited) {
			// Workers Logs: surface the email + IP + count on every throttled hit.
			log(c, 'warn', 'magic_link_rate_limited', { scope: rl.scope, email: rl.email, ip: rl.ip, count: rl.count });
			return c.json({ error: 'Too many requests. Try again later.' }, 429, { 'Retry-After': String(rl.retryAfter) });
		}

		const blocked = emailGuard(email);
		if (blocked) return blocked;
	}

	const auth = createAuth(c.env);
	return auth.handler(c.req.raw);
});

// Inbound SAP webhook — HMAC-authenticated, outside the session middleware.
app.route('/integrations/sap', sapInbound);

// Root redirects by auth state: signed-in users land on the board, everyone
// else on the sign-in page. The browser UI lives in the `ui` router below.
app.get('/', (c) => {
	return c.redirect(c.get('user') ? '/board' : '/sign-in');
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

// Attachments feature — mounted under the issue path so :issue_number is in scope.
app.route('/issues/:issue_number/attachments', attachments);

// Admin UI — server-rendered pages under /admin, gated by requireAdmin inside.
app.route('/admin', admin);

// Browser UI — server-rendered sign-in page and Jira-style board at /sign-in
// and /board. Mounted at root so its paths sit alongside the JSON API.
app.route('/', ui);

// Surface unhandled errors instead of silently turning them into a 500 body.
// Log the method + path + message to Workers Logs, then rethrow so the runtime
// records an exception outcome — that is what `wrangler tail --status error`
// (and the /tail command) filters on. The client still gets a 500.
//
// The rethrow re-enters onError at each Hono mounted-app / middleware boundary
// it bubbles through, so tag the error and log only the first time we see it.
app.onError((err, c) => {
	// HTTPException (e.g. requireAdmin's 403) is a deliberate, expected response —
	// return it directly rather than logging it as an error and rethrowing.
	if (err instanceof HTTPException) {
		return err.getResponse();
	}
	const tagged = err as Error & { logged?: boolean };
	if (!tagged.logged) {
		tagged.logged = true;
		const start = (c.get('logStart') as number | undefined) ?? Date.now();
		log(c, 'error', 'request.errored', {
			method: c.req.method,
			duration_ms: Date.now() - start,
			error_name: err.name,
			error_message: err.message,
		});
	}
	throw err;
});

// The Worker exports both the HTTP handler (the Hono app) and a scheduled
// handler for the nightly-backup Cron Trigger (0 3 * * *, see wrangler.toml).
// The cron handler has no request context, so it logs a plain structured line
// rather than going through `log()` (which reads from a Hono Context).
export default {
	fetch: app.fetch,
	async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		const result = await runBackup(env, event.scheduledTime);
		console.log({
			level: 'info',
			event: 'backup.completed',
			cron: event.cron,
			key: result.key,
			bytes: result.bytes,
			pruned: result.deleted.length,
		});
	},
	// Queue consumer. Branch on the source queue; the inbound consumer lands later.
	async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext): Promise<void> {
		if (batch.queue === 'sap-outbound') {
			for (const msg of batch.messages) {
				await processOutboundMessage(env, msg as unknown as OutboundMessage);
			}
		} else if (batch.queue === 'sap-inbound') {
			for (const msg of batch.messages) {
				await processInboundMessage(env, msg as unknown as InboundMessage);
			}
		}
	},
} satisfies ExportedHandler<Env>;
