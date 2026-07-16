import type { MiddlewareHandler } from 'hono';

// Audit middleware: one audit_log row per write (POST/PATCH/PUT/DELETE). Runs
// after the session middleware (so c.get('user') is resolved) and wraps the
// handler so it can record the outcome. Reads are never audited.
//
// It is BEST-EFFORT: the audit INSERT is swallowed on failure so a logging
// problem can never break the user's request (and so the many route tests that
// don't create an audit_log table are unaffected).

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// Cap the stored diff so full request bodies can't grow D1 without bound.
const MAX_DIFF_BYTES = 4096;

// Body keys whose values must never be logged (case-insensitive substring
// match, so `email`/`emails` and `filename` are both caught).
const SENSITIVE = ['password', 'token', 'secret', 'email', 'content', 'file'];

function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
			const lower = key.toLowerCase();
			out[key] = SENSITIVE.some((s) => lower.includes(s)) ? '<redacted>' : redact(v);
		}
		return out;
	}
	return value;
}

// Parse JSON without throwing (no try/catch): resolve to null on bad input.
async function safeParse(text: string): Promise<unknown> {
	return Promise.resolve()
		.then(() => JSON.parse(text))
		.then(
			(v) => v,
			() => null,
		);
}

function cap(s: string): string {
	return s.length <= MAX_DIFF_BYTES ? s : s.slice(0, MAX_DIFF_BYTES) + '... [truncated]';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isIdSegment = (seg: string) => /^\d+$/.test(seg) || UUID_RE.test(seg);

// Normalize concrete id segments to :id so `action` groups cleanly in reports
// (e.g. PATCH /issues/5 and PATCH /issues/6 both become PATCH /issues/:id).
function normalizePath(path: string): string {
	return path
		.split('/')
		.map((seg) => (seg && isIdSegment(seg) ? ':id' : seg))
		.join('/');
}

// The resource id named in the URL: the last numeric/uuid path segment.
function targetIdFromPath(path: string): string {
	const segs = path.split('/').filter(Boolean);
	for (let i = segs.length - 1; i >= 0; i--) {
		if (isIdSegment(segs[i])) return segs[i];
	}
	return '';
}

function targetType(path: string): string {
	if (path.includes('/comments')) return 'comment';
	if (path.includes('/attachments')) return 'attachment';
	if (path.startsWith('/issues')) return 'issue';
	if (path.startsWith('/projects')) return 'project';
	if (path.startsWith('/admin/users')) return 'user';
	if (path.startsWith('/admin/invites')) return 'invite';
	if (path.startsWith('/admin')) return 'admin';
	if (path.startsWith('/auth')) return 'auth';
	return 'unknown';
}

export const audit: MiddlewareHandler = async (c, next) => {
	const method = c.req.method;
	if (!WRITE_METHODS.has(method)) {
		return next();
	}

	// Capture the request body via a clone so the handler's own read is untouched.
	const rawBody = await c.req.raw.clone().text();

	// Run the handler, capturing a thrown error without try/catch so a 5xx is
	// audited too, then rethrown below to preserve normal error handling.
	let threw = false;
	let error: unknown;
	await next().then(
		() => {},
		(e) => {
			threw = true;
			error = e;
		},
	);

	const status = threw ? 500 : c.res.status;
	const parsed = await safeParse(rawBody);
	const body = parsed === null ? (rawBody ? '<unparseable>' : null) : redact(parsed);

	const diffObj: Record<string, unknown> = { body, status };
	if (threw) {
		diffObj.error = String((error as Error)?.message ?? error).slice(0, 512);
	} else if (status >= 400) {
		diffObj.error = (await c.res.clone().text().then((t) => t, () => '')).slice(0, 512);
	}

	const path = c.req.path;
	let targetId = targetIdFromPath(path);
	if (!targetId && !threw && status >= 200 && status < 300 && (c.res.headers.get('content-type') ?? '').includes('application/json')) {
		const resJson = (await safeParse(await c.res.clone().text().then((t) => t, () => ''))) as Record<string, unknown> | null;
		targetId = String(resJson?.id ?? resJson?.issue_number ?? '');
	}

	const user = c.get('user') as { id: string } | null;

	// Best-effort write: never let an audit failure break the request.
	await c.env.DB.prepare(
		`INSERT INTO audit_log (id, actor_id, action, target_type, target_id, diff, ip, user_agent, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			crypto.randomUUID(),
			user?.id ?? 'anonymous',
			`${method} ${normalizePath(path)}`,
			targetType(path),
			targetId,
			cap(JSON.stringify(diffObj)),
			c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? '',
			c.req.header('user-agent') ?? '',
			Date.now(),
		)
		.run()
		.then(
			() => {},
			() => {},
		);

	if (threw) {
		throw error;
	}
};
