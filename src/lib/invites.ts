// Parse a pasted blob of email addresses (the admin bulk-invite textarea) into a
// clean list: split on commas and any whitespace (spaces, tabs, newlines), trim,
// lowercase, drop anything that isn't email-shaped, and de-duplicate.
export function parseInviteEmails(raw: string): string[] {
	const seen = new Set<string>();
	for (const token of raw.split(/[\s,]+/)) {
		const email = token.trim().toLowerCase();
		if (email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
			seen.add(email);
		}
	}
	return [...seen];
}

// Mark any pending invite for this email as accepted, stamping consumed_at with
// the current epoch ms. Idempotent: the `consumed_at IS NULL` guard means a
// second sign-in leaves the original timestamp untouched. Email match is
// case-insensitive (invites are stored lowercased, but be defensive). Returns
// the number of rows stamped.
export async function consumeInvite(db: D1Database, email: string): Promise<number> {
	const res = await db
		.prepare(`UPDATE invites SET consumed_at = ? WHERE lower(email) = lower(?) AND consumed_at IS NULL`)
		.bind(Date.now(), email)
		.run();
	return res.meta.changes ?? 0;
}
