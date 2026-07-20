import { Hono } from 'hono';
import { verifyWebhookSignature } from '../lib/sap/webhook';

// The inbound SAP webhook. Mounted OUTSIDE the session middleware (see index.ts:
// the session middleware skips /integrations) — it authenticates by HMAC, not a
// session cookie. It does no DB work: verify, enqueue, and return 202 fast, so
// the sap-inbound consumer applies the change out of band.
const sapInbound = new Hono<{ Bindings: Env }>();

sapInbound.post('/inbound', async (c) => {
	// The signature is over the exact raw bytes, so read them before any parse.
	const raw = await c.req.arrayBuffer();
	const valid = await verifyWebhookSignature(c.env.SAP_WEBHOOK_SECRET, raw, c.req.header('X-FT-Signature'));
	if (!valid) {
		console.warn({ event: 'sap.inbound.bad_signature' });
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const change = JSON.parse(new TextDecoder().decode(raw)) as { case_id?: string; status?: string; change_id?: string };
	await c.env.SAP_INBOUND.send({ case_id: change.case_id, status: change.status, change_id: change.change_id });
	return c.json({ accepted: true }, 202);
});

export default sapInbound;
