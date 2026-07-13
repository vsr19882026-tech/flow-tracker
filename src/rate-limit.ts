// Magic-link rate limiting, backed by the CACHE KV namespace.
//
// Fixed hourly windows: the window bucket (`floor(now / 1h)`) is part of the KV
// key, so a new hour is a fresh key and the count resets naturally; the TTL then
// reaps the old key. Per email: 5/hour. Per IP: 30/hour.
//
// NOTE: KV is eventually consistent (a write can take up to ~60s to be globally
// visible, and read-after-write in the same request is not guaranteed). That
// makes this a best-effort limiter, not a strict counter — under a burst from
// many colocations a few extra requests can slip through the small
// false-negative window. That is acceptable here; a Durable Object would be the
// tool for strict counting.

export const RATE_LIMIT_WINDOW_MS = 3_600_000; // 1 hour
export const MAGIC_LINK_EMAIL_LIMIT = 5;
export const MAGIC_LINK_IP_LIMIT = 30;

export interface RateLimitResult {
	limited: boolean;
	scope: 'email' | 'ip' | 'ok';
	email: string;
	ip: string;
	count: number;
	retryAfter: number; // seconds until the window resets (0 when not limited)
}

// Seconds remaining in the current window.
function secondsUntilReset(now: number): number {
	return Math.ceil((RATE_LIMIT_WINDOW_MS - (now % RATE_LIMIT_WINDOW_MS)) / 1000);
}

// Read-then-write a single counter. Returns the post-increment count, or the
// unchanged count when the limit is already reached (no increment past the cap).
async function hit(
	kv: KVNamespace,
	prefix: string,
	id: string,
	limit: number,
	now: number,
): Promise<{ limited: boolean; count: number }> {
	const bucket = Math.floor(now / RATE_LIMIT_WINDOW_MS);
	const key = `rl:${prefix}:${id}:${bucket}`;
	const count = Number(await kv.get(key)) || 0;
	if (count >= limit) {
		return { limited: true, count };
	}
	const next = count + 1;
	await kv.put(key, String(next), { expirationTtl: RATE_LIMIT_WINDOW_MS / 1000 });
	return { limited: false, count: next };
}

// Check (and record) an attempt against both the per-email and per-IP limits.
// Email is checked first; if it is over the limit, the IP counter is left
// untouched. Email is lower-cased so casing cannot be used to bypass the limit.
export async function checkMagicLinkRateLimit(
	kv: KVNamespace,
	email: string,
	ip: string,
	now: number = Date.now(),
): Promise<RateLimitResult> {
	const normalizedEmail = email.toLowerCase();

	const byEmail = await hit(kv, 'email', normalizedEmail, MAGIC_LINK_EMAIL_LIMIT, now);
	if (byEmail.limited) {
		return { limited: true, scope: 'email', email: normalizedEmail, ip, count: byEmail.count, retryAfter: secondsUntilReset(now) };
	}

	const byIp = await hit(kv, 'ip', ip, MAGIC_LINK_IP_LIMIT, now);
	if (byIp.limited) {
		return { limited: true, scope: 'ip', email: normalizedEmail, ip, count: byIp.count, retryAfter: secondsUntilReset(now) };
	}

	return { limited: false, scope: 'ok', email: normalizedEmail, ip, count: byEmail.count, retryAfter: 0 };
}
