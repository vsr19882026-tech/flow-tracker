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
