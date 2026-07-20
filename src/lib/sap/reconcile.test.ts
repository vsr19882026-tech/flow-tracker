import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { reconcileOutbound, reconcileInbound } from './reconcile';

// Reconciliation is the queue safety net: re-enqueue stuck outbox rows, and poll
// SAP for changes since a watermark. The queue sends are spied; the SAP poll is a
// mocked fetch.

const NOW = 10_000_000;
const GRACE_MS = 5 * 60 * 1000;

function makeEnv(overrides: { outbound?: () => void; inbound?: () => void } = {}) {
	return {
		DB: env.DB,
		CACHE: env.CACHE,
		SAP_API_BASE: 'https://sap.example',
		SAP_OUTBOUND: { send: vi.fn(overrides.outbound) },
		SAP_INBOUND: { send: vi.fn(overrides.inbound) },
		SAP_TOKEN_URL: 'https://sap.example/token',
		SAP_CLIENT_ID: 'id',
		SAP_CLIENT_SECRET: 'secret',
	} as unknown as Env;
}

beforeEach(async () => {
	const db = env.DB;
	for (const t of ['sap_outbox', 'sync_state']) {
		await db.exec(`DROP TABLE IF EXISTS ${t}`);
	}
	await db
		.prepare(
			`CREATE TABLE sap_outbox (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, issue_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)`,
		)
		.run();
	await db.prepare(`CREATE TABLE sync_state (key TEXT PRIMARY KEY, watermark TEXT)`).run();

	// getSapToken reads a cached token so reconcileInbound's only fetch is the poll.
	await env.CACHE.put('sap:token', 'cached-token', { expirationTtl: 3600 });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('reconcileOutbound', () => {
	it('1. re-enqueues a pending row older than the grace window, skipping fresh and sent rows', async () => {
		await env.DB.batch([
			// stuck: pending + older than grace -> re-enqueued
			env.DB.prepare(`INSERT INTO sap_outbox (id, seq, issue_id, event_type, payload, status, created_at) VALUES ('issue-1:1',1,'issue-1','created','{}','pending',?)`).bind(NOW - GRACE_MS - 1000),
			// fresh: pending but within grace -> skipped
			env.DB.prepare(`INSERT INTO sap_outbox (id, seq, issue_id, event_type, payload, status, created_at) VALUES ('issue-2:1',1,'issue-2','created','{}','pending',?)`).bind(NOW - 1000),
			// already sent -> skipped
			env.DB.prepare(`INSERT INTO sap_outbox (id, seq, issue_id, event_type, payload, status, created_at) VALUES ('issue-3:1',1,'issue-3','created','{}','sent',?)`).bind(NOW - GRACE_MS - 1000),
		]);
		const testEnv = makeEnv();

		const count = await reconcileOutbound(testEnv, NOW);

		expect(count).toBe(1);
		expect(testEnv.SAP_OUTBOUND.send).toHaveBeenCalledTimes(1);
		expect(testEnv.SAP_OUTBOUND.send).toHaveBeenCalledWith({ outboxId: 'issue-1:1', issueId: 'issue-1' });
	});
});

describe('reconcileInbound', () => {
	it('2. enqueues a changed case from the SAP poll and advances the watermark', async () => {
		await env.DB.prepare(`INSERT INTO sync_state (key, watermark) VALUES ('inbound_watermark', '100')`).run();
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ cases: [{ case_id: 'CASE-1', status: 'In Process', change_id: 'chg-9' }], watermark: '200' }), { status: 200 }),
		);
		vi.stubGlobal('fetch', fetchMock);
		const testEnv = makeEnv();

		const count = await reconcileInbound(testEnv, NOW);

		expect(count).toBe(1);
		expect(testEnv.SAP_INBOUND.send).toHaveBeenCalledWith({ case_id: 'CASE-1', status: 'In Process', change_id: 'chg-9' });
		// The poll uses the stored watermark.
		expect(fetchMock.mock.calls[0][0]).toContain('changedSince=100');
		const state = await env.DB.prepare("SELECT watermark FROM sync_state WHERE key = 'inbound_watermark'").first<{ watermark: string }>();
		expect(state!.watermark).toBe('200');
	});

	it('3. enqueues nothing and leaves the watermark when no cases changed', async () => {
		await env.DB.prepare(`INSERT INTO sync_state (key, watermark) VALUES ('inbound_watermark', '100')`).run();
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ cases: [] }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const testEnv = makeEnv();

		const count = await reconcileInbound(testEnv, NOW);

		expect(count).toBe(0);
		expect(testEnv.SAP_INBOUND.send).not.toHaveBeenCalled();
		const state = await env.DB.prepare("SELECT watermark FROM sync_state WHERE key = 'inbound_watermark'").first<{ watermark: string }>();
		expect(state!.watermark).toBe('100');
	});
});
