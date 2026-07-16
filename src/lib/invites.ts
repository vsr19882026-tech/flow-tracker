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
