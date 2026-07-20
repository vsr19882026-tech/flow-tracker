// HMAC-SHA256 verification for the inbound SAP webhook. SAP (or the CPI iflow)
// signs the raw request body with the shared SAP_WEBHOOK_SECRET and sends the hex
// digest as `X-FT-Signature: sha256=<hex>`. We recompute and constant-time compare.

export async function computeHmacSha256(secret: string, body: ArrayBuffer): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, body);
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time compare of two equal-length hex strings. A length mismatch is an
// immediate false (the lengths themselves are not secret).
export function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

// True iff the `sha256=<hex>` header matches HMAC-SHA256(body, secret).
export async function verifyWebhookSignature(secret: string, body: ArrayBuffer, header: string | undefined): Promise<boolean> {
	if (!header || !header.startsWith('sha256=')) return false;
	const provided = header.slice('sha256='.length);
	const expected = await computeHmacSha256(secret, body);
	return timingSafeEqualHex(expected, provided);
}
