import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';

// The structured-logging middleware emits request.started on entry and
// request.completed on exit for every request, and app.onError emits
// request.errored on an uncaught throw. Each line is JSON with the common
// fields request_id, user_id, route (+ duration_ms/status on exit).

const USER_ID = 'user_log_1';
const SESSION_TOKEN = 'log-session-token';
const AUTH_COOKIE = `better-auth.session=${SESSION_TOKEN}`;

beforeEach(async () => {
	const db = env.DB;
	await db.exec('DROP TABLE IF EXISTS issues');
	await db.exec('DROP TABLE IF EXISTS session');
	await db.exec('DROP TABLE IF EXISTS user');
	await db
		.prepare(
			`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
				emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
				role TEXT NOT NULL DEFAULT 'member')`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE "session" (id TEXT PRIMARY KEY, userId TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
				expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE issues (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
				status TEXT NOT NULL DEFAULT 'open', issue_number INTEGER NOT NULL, created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL, UNIQUE(issue_number))`,
		)
		.run();
	await db
		.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)`)
		.bind(USER_ID, 'Log', 'log@example.com', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
	await db
		.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind('sess_log', USER_ID, SESSION_TOKEN, '2999-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
});

// Collect the JSON objects logged to a given console channel during `fn`. `fn`
// must resolve — an errored request rejects, so wrap it with expect().rejects.
async function capture(channel: 'log' | 'error', fn: () => Promise<unknown>) {
	const spy = vi.spyOn(console, channel).mockImplementation(() => {});
	await fn();
	// log() emits structured objects; keep the ones that carry an event field.
	const lines = spy.mock.calls
		.map((call) => call[0])
		.filter((arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null && 'event' in arg);
	spy.mockRestore();
	return lines;
}

describe('structured request logging', () => {
	it('emits request.started and request.completed with the common fields', async () => {
		const lines = await capture('log', () => SELF.fetch('http://tracker.test/'));
		const started = lines.find((l) => l.event === 'request.started');
		const completed = lines.find((l) => l.event === 'request.completed');

		expect(started).toBeDefined();
		expect(completed).toBeDefined();
		expect(typeof started!.request_id).toBe('string');
		expect(started!.route).toBe('/');
		expect(completed!.route).toBe('/');
		expect(typeof completed!.duration_ms).toBe('number');
		expect(completed!.status).toBe(302); // '/' now redirects by auth state
	});

	it('uses the same request_id for started and completed of one request', async () => {
		const lines = await capture('log', () => SELF.fetch('http://tracker.test/whoami'));
		const started = lines.find((l) => l.event === 'request.started');
		const completed = lines.find((l) => l.event === 'request.completed');
		expect(started!.request_id).toBe(completed!.request_id);
		expect(started!.request_id).not.toBeNull();
	});

	it('populates user_id from the session on an authenticated request', async () => {
		const lines = await capture('log', () => SELF.fetch('http://tracker.test/whoami', { headers: { cookie: AUTH_COOKIE } }));
		const completed = lines.find((l) => l.event === 'request.completed');
		expect(completed!.user_id).toBe(USER_ID);
		expect(completed!.status).toBe(200);
	});

	it('logs user_id null and the real status for an unauthenticated request', async () => {
		const lines = await capture('log', () => SELF.fetch('http://tracker.test/whoami'));
		const completed = lines.find((l) => l.event === 'request.completed');
		expect(completed!.user_id).toBeNull();
		expect(completed!.status).toBe(401);
	});

	it('logs request.errored with error_name and error_message on an uncaught throw', async () => {
		const lines = await capture('error', () =>
			expect(
				SELF.fetch('http://tracker.test/issues', {
					method: 'POST',
					headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
					body: 'not-json{',
				}),
			).rejects.toThrow(/is not valid JSON/),
		);
		const errored = lines.filter((l) => l.event === 'request.errored');
		expect(errored.length).toBe(1);
		expect(errored[0].error_name).toBe('SyntaxError');
		expect(typeof errored[0].error_message).toBe('string');
		expect(errored[0].user_id).toBe(USER_ID);
		expect(typeof errored[0].duration_ms).toBe('number');
	});
});
