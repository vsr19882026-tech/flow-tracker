import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, it, expect, vi } from 'vitest';

// app.onError rethrows so the runtime records an exception outcome (needed for
// `wrangler tail --status error`). Because the rethrow bubbles through Hono's
// mounted sub-app and middleware boundaries, a naive onError logs once per
// boundary — several times for a single thrown error. This asserts it logs
// exactly once.

const USER_ID = 'user_err_1';
const SESSION_TOKEN = 'err-session-token';
const AUTH_COOKIE = `better-auth.session=${SESSION_TOKEN}`;

beforeEach(async () => {
	const db = env.DB;
	await db.exec('DROP TABLE IF EXISTS issues');
	await db.exec('DROP TABLE IF EXISTS session');
	await db.exec('DROP TABLE IF EXISTS user');
	await db
		.prepare(
			`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
				emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`,
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
		.bind(USER_ID, 'Err', 'err@example.com', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
	await db
		.prepare(`INSERT INTO "session" (id, userId, token, expiresAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`)
		.bind('sess_err', USER_ID, SESSION_TOKEN, '2999-12-31T23:59:59.999Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
		.run();
});

describe('unhandled error handling', () => {
	it('logs an unhandled_error event exactly once per thrown error', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		// Authenticated POST with a malformed JSON body → JSON.parse throws. onError
		// rethrows, so the invocation surfaces as an exception (the fetch rejects).
		await expect(
			SELF.fetch('http://tracker.test/issues', {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie: AUTH_COOKIE },
				body: 'not-json{',
			}),
		).rejects.toThrow(/is not valid JSON/);
		const unhandled = spy.mock.calls.filter((call) => typeof call[0] === 'string' && call[0].includes('unhandled_error'));
		expect(unhandled.length).toBe(1);
		spy.mockRestore();
	});
});
