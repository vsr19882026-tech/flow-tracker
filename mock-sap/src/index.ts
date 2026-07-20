// Mock SAP Cloud ALM ITSM — a standalone Worker that stands in for a real SAP
// tenant so the whole Flow Tracker integration can run without one. It:
//   POST /oauth/token       → a fake bearer token + expires_in
//   PUT  /cases             → echoes a case_id derived from externalReference
//                             (so re-PUT of the same change is idempotent)
//   GET  /trigger-status    → POSTs a signed webhook to Flow Tracker's inbound URL
//
// Point Flow Tracker's SAP mode at this Worker's URL and share SAP_WEBHOOK_SECRET.

type Env = {
	SAP_WEBHOOK_SECRET: string;
	FT_INBOUND_URL: string;
};

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Deterministic case id from the externalReference, so PUTting the same change
// twice returns the same case (idempotent upsert).
function caseIdFor(externalReference: string): string {
	return `MOCK-${externalReference}`;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (req.method === 'POST' && url.pathname === '/oauth/token') {
			return Response.json({ access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 });
		}

		// Inbound reconcile poll — no server-driven changes, so always empty. (Status
		// changes are pushed via /trigger-status instead.)
		if (req.method === 'GET' && url.pathname === '/cases') {
			return Response.json({ cases: [] });
		}

		if (req.method === 'PUT' && url.pathname === '/cases') {
			const body = (await req.json()) as { externalReference?: string; status?: string; subject?: string };
			const externalReference = body.externalReference ?? 'unknown';
			return Response.json({ caseId: caseIdFor(externalReference), externalReference, status: body.status ?? 'New', subject: body.subject });
		}

		if (req.method === 'GET' && url.pathname === '/trigger-status') {
			const caseId = url.searchParams.get('case_id') ?? '';
			const status = url.searchParams.get('status') ?? '';
			// A monotonic-ish change id from the request; unique per trigger.
			const changeId = `chg-${url.searchParams.get('change_id') ?? Math.floor(Date.now())}`;
			const payload = JSON.stringify({ case_id: caseId, status, change_id: changeId });
			const signature = 'sha256=' + (await hmacSha256Hex(env.SAP_WEBHOOK_SECRET, payload));
			const res = await fetch(env.FT_INBOUND_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'X-FT-Signature': signature },
				body: payload,
			});
			return Response.json({ sent: true, ft_status: res.status, case_id: caseId, status, change_id: changeId });
		}

		return new Response('mock-sap: not found', { status: 404 });
	},
};
