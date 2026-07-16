import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import { Kysely } from 'kysely';
import { D1Dialect } from 'kysely-d1';
import { sendEmail } from './email';
import { consumeInvite } from './lib/invites';

// Individual addresses that may request a magic link, regardless of domain.
// Keeps the project owner (a gmail address) on the allowlist.
const ALLOWED_EMAILS = ['vsr19882026@gmail.com'];

// Any address at one of these domains may request a magic link. Teammates sign
// in with their @shravyalabs.com address; the zone's Email Routing catch-all
// delivers the magic link. Compared against the exact host after the last '@',
// so a lookalike like evil-shravyalabs.com or shravyalabs.com.evil.com fails.
const ALLOWED_DOMAINS = ['shravyalabs.com'];

/**
 * Reject sign-in requests for addresses that are neither on the allowlist nor
 * at an allowed domain. Returns a 403 Response when blocked, or null when the
 * email is allowed. Matching is case-insensitive and ignores surrounding
 * whitespace, mirroring how the rate limiter normalizes the address.
 */
export function emailGuard(email: string | undefined): Response | null {
	const normalized = email?.trim().toLowerCase() ?? '';
	const at = normalized.lastIndexOf('@');
	const domain = at === -1 ? '' : normalized.slice(at + 1);
	const allowed =
		normalized.length > 0 &&
		(ALLOWED_EMAILS.includes(normalized) || (domain.length > 0 && ALLOWED_DOMAINS.includes(domain)));

	if (!allowed) {
		return new Response(JSON.stringify({ error: 'Email not allowed' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	return null;
}

/**
 * Build a Better Auth instance for a single request.
 *
 * Per-request factory: the D1 binding and secret live on `env`, which only
 * exists inside the fetch handler. Instantiating at module scope would capture
 * an undefined binding (better-auth issue #207).
 */
export function createAuth(env: Env) {
	// D1 is SQLite-compatible; drive it through Kysely's D1 dialect.
	const db = new Kysely({ dialect: new D1Dialect({ database: env.DB }) });

	return betterAuth({
		baseURL: 'https://tracker.shravyalabs.com',
		basePath: '/auth', // routes resolve as /auth/... not the default /api/auth/...
		secret: env.BETTER_AUTH_SECRET,
		database: kyselyAdapter(db, { type: 'sqlite' }),
		// When a first-time invitee signs in, Better Auth creates their user row;
		// stamp their pending invite as consumed at that moment. Best-effort: a
		// failure here must never break sign-in, so swallow it (no try/catch) —
		// the invite simply stays pending.
		databaseHooks: {
			user: {
				create: {
					after: async (user) => {
						await consumeInvite(env.DB, user.email).then(
							() => {},
							() => {},
						);
					},
				},
			},
		},
		plugins: [
			magicLink({
				sendMagicLink: async ({ email, url }) => {
					await sendEmail(
						env,
						email,
						'Sign in to Flow Tracker',
						`<p>Click to sign in to Flow Tracker:</p><p><a href="${url}">${url}</a></p>` +
							`<p>This link expires shortly. If you didn't request it, ignore this email.</p>`,
					);
				},
			}),
		],
	});
}
