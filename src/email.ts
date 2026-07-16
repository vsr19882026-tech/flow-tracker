import { EmailMessage } from 'cloudflare:email';
import { createMimeMessage } from 'mimetext';

// Sender must live on a domain verified in Cloudflare Email Routing.
const FROM_ADDR = 'noreply@shravyalabs.com';
const FROM_NAME = 'Flow Tracker';

/**
 * Send a transactional email via the Cloudflare `send_email` binding (EMAIL).
 *
 * Gotcha: the binding only delivers to *verified* destination addresses. For
 * flow-tracker only `vsr19882026@gmail.com` is currently verified, so magic
 * links to any other address fail with E_RECIPIENT_NOT_ALLOWED.
 */
export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<void> {
	const msg = createMimeMessage();
	msg.setSender({ name: FROM_NAME, addr: FROM_ADDR });
	msg.setRecipient(to);
	msg.setSubject(subject);
	msg.addMessage({ contentType: 'text/html', data: html });

	const message = new EmailMessage(FROM_ADDR, to, msg.asRaw());
	await env.EMAIL.send(message);
}

const SIGN_IN_URL = 'https://tracker.shravyalabs.com';

/**
 * Send a bulk-invite email inviting a teammate to sign in to Flow Tracker.
 *
 * Same delivery caveat as sendEmail: the send_email binding only reaches
 * verified recipients, so a real teammate address fails with
 * E_RECIPIENT_NOT_ALLOWED. Callers treat the send as best-effort — a failed
 * delivery must not roll back the invite row.
 */
export async function sendInviteEmail(env: Env, to: string): Promise<void> {
	await sendEmail(
		env,
		to,
		"You're invited to Flow Tracker",
		`<p>You've been invited to Flow Tracker.</p>` +
			`<p>Sign in with your work email at <a href="${SIGN_IN_URL}">${SIGN_IN_URL}</a> — ` +
			`request a magic link and you're in.</p>`,
	);
}
