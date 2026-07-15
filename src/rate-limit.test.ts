import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { checkMagicLinkRateLimit, MAGIC_LINK_EMAIL_LIMIT, RATE_LIMIT_WINDOW_MS } from './rate-limit';

// A fixed timestamp comfortably inside one hour bucket. Passing `now` explicitly
// keeps every case deterministic and lets the window-reset case fast-forward
// time without touching the clock.
const T = 1_700_000_000_000;

describe('magic-link rate limit', () => {
	// Case 1 — hits the limit on the 6th attempt for the same email.
	it('allows 5 attempts and limits the 6th for the same email', async () => {
		const email = 'case1@example.com';
		const ip = '10.0.0.1';
		for (let i = 0; i < MAGIC_LINK_EMAIL_LIMIT; i++) {
			const r = await checkMagicLinkRateLimit(env.CACHE, email, ip, T);
			expect(r.limited).toBe(false);
		}
		const sixth = await checkMagicLinkRateLimit(env.CACHE, email, ip, T);
		expect(sixth.limited).toBe(true);
		expect(sixth.scope).toBe('email');
		expect(sixth.retryAfter).toBeGreaterThan(0);
	});

	// Case 2 — different emails do not share a limit.
	it('does not share limits between different emails', async () => {
		const ip = '10.0.0.2';
		for (let i = 0; i < MAGIC_LINK_EMAIL_LIMIT; i++) {
			await checkMagicLinkRateLimit(env.CACHE, 'case2a@example.com', ip, T);
		}
		// The maxed-out email is now limited...
		const maxed = await checkMagicLinkRateLimit(env.CACHE, 'case2a@example.com', ip, T);
		expect(maxed.limited).toBe(true);
		// ...but a different email on the same IP is still allowed.
		const other = await checkMagicLinkRateLimit(env.CACHE, 'case2b@example.com', ip, T);
		expect(other.limited).toBe(false);
	});

	// Case 3 — the limit resets after the hour window.
	it('resets the limit after the hour window', async () => {
		const email = 'case3@example.com';
		const ip = '10.0.0.3';
		for (let i = 0; i < MAGIC_LINK_EMAIL_LIMIT; i++) {
			await checkMagicLinkRateLimit(env.CACHE, email, ip, T);
		}
		expect((await checkMagicLinkRateLimit(env.CACHE, email, ip, T)).limited).toBe(true);
		// One hour later the window has rolled over — attempts are allowed again.
		const nextHour = T + RATE_LIMIT_WINDOW_MS;
		expect((await checkMagicLinkRateLimit(env.CACHE, email, ip, nextHour)).limited).toBe(false);
	});
});

describe('POST /auth/sign-in/magic-link rate limit (route)', () => {
	it('returns 429 with Retry-After on the 6th request from one email', async () => {
		const ip = '203.0.113.9';
		const post = () =>
			SELF.fetch('http://tracker.test/auth/sign-in/magic-link', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
				// A disallowed email: the allowlist guard 403s attempts 1-5 (no email is
				// ever sent), and the rate limit — which runs first — 429s the 6th.
				body: JSON.stringify({ email: 'probe@example.com' }),
			});

		for (let i = 0; i < 5; i++) {
			const r = await post();
			expect(r.status).not.toBe(429);
		}
		const sixth = await post();
		expect(sixth.status).toBe(429);
		expect(sixth.headers.get('Retry-After')).toBeTruthy();
	});

	it('logs a magic_link.requested event with the lowercased email on each attempt', async () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		// A disallowed email is guarded (403) AFTER the attempt is logged, so the
		// attempt log fires regardless of the allowlist outcome.
		await SELF.fetch('http://tracker.test/auth/sign-in/magic-link', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7' },
			body: JSON.stringify({ email: 'Abuse@Example.com' }),
		});
		const requested = spy.mock.calls
			.map((call) => call[0])
			.filter((arg): arg is Record<string, unknown> => typeof arg === 'object' && arg !== null && 'event' in arg)
			.filter((l) => l.event === 'magic_link.requested');
		spy.mockRestore();
		expect(requested.length).toBe(1);
		expect(requested[0].email).toBe('abuse@example.com');
		expect(requested[0].ip).toBe('198.51.100.7');
	});
});
