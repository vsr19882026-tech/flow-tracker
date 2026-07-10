import { betterAuth } from 'better-auth';
import { magicLink } from 'better-auth/plugins';
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import { Kysely } from 'kysely';
import { D1Dialect } from 'kysely-d1';
import { sendEmail } from './email';

// Only these addresses may request a magic link. The Cloudflare send_email
// binding also only delivers to verified destinations, but we gate earlier so
// unknown addresses get a clean 403 instead of a downstream send failure.
const ALLOWED_EMAILS = ['vsr19882026@gmail.com'];

/**
 * Reject sign-in requests for addresses not on the allowlist.
 * Returns a 403 Response when blocked, or null when the email is allowed.
 */
export function emailGuard(email: string | undefined): Response | null {
	if (!email || !ALLOWED_EMAILS.includes(email)) {
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
