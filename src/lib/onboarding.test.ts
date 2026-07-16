import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { sendOnboardingIfNeeded } from './onboarding';

// One-time onboarding: the first sign-in claims onboarded_at and sends the
// welcome email; every later sign-in is a no-op. The D1 UPDATE...RETURNING is
// the claim, so this is exactly-once regardless of how the send fares.

const USER_ID = 'u_new';

beforeEach(async () => {
	await env.DB.exec('DROP TABLE IF EXISTS "user"');
	await env.DB
		.prepare(
			`CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
				emailVerified INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
				role TEXT NOT NULL DEFAULT 'member', onboarded_at INTEGER)`,
		)
		.run();
	await env.DB
		.prepare(`INSERT INTO "user" (id, name, email, createdAt, updatedAt) VALUES (?, ?, ?, '', '')`)
		.bind(USER_ID, 'New Teammate', 'newbie@shravyalabs.com')
		.run();
});

async function onboardedAt(): Promise<number | null> {
	const row = await env.DB.prepare('SELECT onboarded_at FROM "user" WHERE id = ?').bind(USER_ID).first<{ onboarded_at: number | null }>();
	return row!.onboarded_at;
}

describe('sendOnboardingIfNeeded', () => {
	it('1. first sign-in claims onboarding and stamps onboarded_at', async () => {
		expect(await onboardedAt()).toBeNull();

		const sent = await sendOnboardingIfNeeded(env, USER_ID);
		expect(sent).toBe(true);
		expect(typeof (await onboardedAt())).toBe('number');
	});

	it('2. a later sign-in from the same user is a no-op (no second email)', async () => {
		await sendOnboardingIfNeeded(env, USER_ID);
		const stamped = await onboardedAt();

		const again = await sendOnboardingIfNeeded(env, USER_ID);
		expect(again).toBe(false);
		// The original timestamp is untouched — nothing re-claimed.
		expect(await onboardedAt()).toBe(stamped);
	});

	it('3. an unknown user id claims nothing', async () => {
		expect(await sendOnboardingIfNeeded(env, 'nobody')).toBe(false);
	});
});
