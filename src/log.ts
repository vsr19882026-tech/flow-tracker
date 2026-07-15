import type { Context } from 'hono';

export type LogLevel = 'info' | 'warn' | 'error';

// Single structured-logging entry point for the whole app. Emits one JSON line
// per event, carrying the common request fields — request_id, user_id, route —
// pulled straight from the Hono context, merged with any event-specific fields.
// `wrangler tail --format pretty` and Workers Logs render each line as JSON.
//
// The entry is logged as an OBJECT (not a JSON string) so Workers Logs captures
// each key as a queryable field — that is what the percentile/group-by/filter
// queries in docs/logs-queries.md rely on. `wrangler tail` renders it too.
//
// The level picks the console channel so severity survives into Workers Logs:
// error → console.error (also lets app.onError's exception outcome line up),
// warn → console.warn, everything else → console.log.
export function log(c: Context, level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
	const user = c.get('user') as { id: string } | null | undefined;
	const entry = {
		level,
		event,
		request_id: (c.get('requestId') as string | undefined) ?? null,
		user_id: user?.id ?? null,
		route: c.req.path,
		...fields,
	};
	const channel = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
	channel(entry);
}
