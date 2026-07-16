import { sendOnboardingEmail } from '../email';

// Send the one-time onboarding email the first time a user signs in. The claim
// IS the D1 write: `UPDATE ... WHERE onboarded_at IS NULL RETURNING email` flips
// the flag and hands back the address in one atomic step, so exactly one sign-in
// ever wins — repeat sign-ins (and concurrent ones) get no row back and send
// nothing. Returns true iff this call claimed onboarding and fired the send.
//
// Claim-first (set the flag, then send): a blocked or failed delivery still
// counts as onboarded, so the welcome is never re-sent. Delivery is best-effort
// — the send_email binding only reaches verified recipients — and a failure here
// must never break sign-in.
export async function sendOnboardingIfNeeded(env: Env, userId: string): Promise<boolean> {
	const row = await env.DB.prepare(`UPDATE "user" SET onboarded_at = ? WHERE id = ? AND onboarded_at IS NULL RETURNING email`)
		.bind(Date.now(), userId)
		.first<{ email: string }>();
	if (!row) return false;
	await sendOnboardingEmail(env, row.email).then(
		() => {},
		() => {},
	);
	return true;
}
