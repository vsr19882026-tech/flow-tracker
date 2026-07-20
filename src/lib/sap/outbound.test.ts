import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { processOutboundMessage } from './outbound';

// The outbound queue consumer drains sap_outbox to SAP. These tests seed the DB,
// mock the SAP fetch, and assert on the row/link state, ack/retry, and the result.

const SAP_API_BASE = 'https://sap.example';

function makeEnv(): Env {
	return {
		DB: env.DB,
		CACHE: env.CACHE,
		SAP_API_BASE,
		SAP_TOKEN_URL: 'https://sap.example/token',
		SAP_CLIENT_ID: 'id',
		SAP_CLIENT_SECRET: 'secret',
	} as unknown as Env;
}

function makeMsg(attempts = 1) {
	return { body: { outboxId: 'issue-1:1', issueId: 'issue-1' }, attempts, ack: vi.fn(), retry: vi.fn() };
}

beforeEach(async () => {
	const db = env.DB;
	for (const t of ['sap_links', 'sap_outbox', 'sap_status_map', 'sap_field_map', 'issues']) {
		await db.exec(`DROP TABLE IF EXISTS ${t}`);
	}
	await db
		.prepare(
			`CREATE TABLE issues (id TEXT PRIMARY KEY, reporter_id TEXT, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL, priority TEXT, issue_number INTEGER NOT NULL, project_id TEXT, created_at INTEGER, updated_at INTEGER)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE sap_outbox (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, issue_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE sap_links (issue_id TEXT PRIMARY KEY, sap_case_id TEXT, external_ref TEXT, last_seq_sent INTEGER, last_change_id TEXT, updated_at INTEGER)`,
		)
		.run();
	await db
		.prepare(`CREATE TABLE sap_field_map (flow_field TEXT NOT NULL, sap_field TEXT NOT NULL, direction TEXT NOT NULL, transform TEXT, active INTEGER NOT NULL DEFAULT 1)`)
		.run();
	await db.prepare(`CREATE TABLE sap_status_map (flow_status TEXT NOT NULL, sap_status TEXT NOT NULL, direction TEXT NOT NULL)`).run();

	await db.batch([
		db.prepare(`INSERT INTO sap_field_map (flow_field, sap_field, direction, transform, active) VALUES ('title','subject','both',NULL,1)`),
		db.prepare(`INSERT INTO sap_field_map (flow_field, sap_field, direction, transform, active) VALUES ('description','description','both',NULL,1)`),
		db.prepare(`INSERT INTO sap_field_map (flow_field, sap_field, direction, transform, active) VALUES ('status','status','both',NULL,1)`),
		db.prepare(`INSERT INTO sap_field_map (flow_field, sap_field, direction, transform, active) VALUES ('issue_number','externalReference','outbound',NULL,1)`),
		db.prepare(`INSERT INTO sap_status_map (flow_status, sap_status, direction) VALUES ('open','New','both')`),
		db.prepare(`INSERT INTO sap_status_map (flow_status, sap_status, direction) VALUES ('in_progress','In Process','both')`),
		db.prepare(`INSERT INTO sap_status_map (flow_status, sap_status, direction) VALUES ('done','Completed','both')`),
	]);

	await db
		.prepare(
			`INSERT INTO issues (id, reporter_id, title, description, status, priority, issue_number, created_at, updated_at) VALUES ('issue-1','u1','Login broken','repro','open','medium',7,1000,1000)`,
		)
		.run();
	await db
		.prepare(`INSERT INTO sap_outbox (id, seq, issue_id, event_type, payload, status, created_at) VALUES ('issue-1:1',1,'issue-1','created','{}','pending',1000)`)
		.run();

	// Cache the SAP token so getSapToken does not fetch; the only fetch is the PUT.
	await env.CACHE.put('sap:token', 'cached-token', { expirationTtl: 3600 });
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('outbound consumer', () => {
	it('1. a pending event PUTs ft-id-seq, upserts sap_links, marks the row sent', async () => {
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ caseId: 'CASE-100' }), { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const msg = makeMsg();

		const result = await processOutboundMessage(makeEnv(), msg);

		expect(result.outcome).toBe('sent');
		expect(msg.ack).toHaveBeenCalledTimes(1);
		expect(msg.retry).not.toHaveBeenCalled();

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe('https://sap.example/cases');
		expect(init.method).toBe('PUT');
		const body = JSON.parse(init.body as string) as Record<string, unknown>;
		expect(body.externalReference).toBe('ft-issue-1-1');
		expect(body.subject).toBe('Login broken');
		expect(body.status).toBe('New');

		const row = await env.DB.prepare("SELECT status FROM sap_outbox WHERE id = 'issue-1:1'").first<{ status: string }>();
		expect(row!.status).toBe('sent');

		const link = await env.DB.prepare("SELECT * FROM sap_links WHERE issue_id = 'issue-1'").first<{
			sap_case_id: string;
			external_ref: string;
			last_seq_sent: number;
		}>();
		expect(link!.sap_case_id).toBe('CASE-100');
		expect(link!.external_ref).toBe('ft-issue-1-1');
		expect(link!.last_seq_sent).toBe(1);
	});

	it('2. an already-sent event redelivered makes no SAP call and acks', async () => {
		await env.DB.prepare("UPDATE sap_outbox SET status = 'sent' WHERE id = 'issue-1:1'").run();
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const msg = makeMsg();

		const result = await processOutboundMessage(makeEnv(), msg);

		expect(result.outcome).toBe('skipped');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(msg.ack).toHaveBeenCalledTimes(1);
	});

	it('3. repeated 5xx retries up to the limit then marks the row dead', async () => {
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('upstream error', { status: 503 }));
		vi.stubGlobal('fetch', fetchMock);

		const outcomes: string[] = [];
		for (let attempts = 1; attempts <= 5; attempts++) {
			const msg = makeMsg(attempts);
			const result = await processOutboundMessage(makeEnv(), msg);
			outcomes.push(result.outcome);
			if (attempts < 5) {
				expect(msg.retry).toHaveBeenCalledTimes(1);
				expect(msg.ack).not.toHaveBeenCalled();
			} else {
				expect(msg.ack).toHaveBeenCalledTimes(1);
				expect(msg.retry).not.toHaveBeenCalled();
			}
		}
		expect(outcomes).toEqual(['retried', 'retried', 'retried', 'retried', 'dead']);

		const row = await env.DB.prepare("SELECT status FROM sap_outbox WHERE id = 'issue-1:1'").first<{ status: string }>();
		expect(row!.status).toBe('dead');
	});

	it('4. a 400 marks the row dead immediately without retrying', async () => {
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('bad request', { status: 400 }));
		vi.stubGlobal('fetch', fetchMock);
		const msg = makeMsg();

		const result = await processOutboundMessage(makeEnv(), msg);

		expect(result.outcome).toBe('dead');
		expect(msg.retry).not.toHaveBeenCalled();
		expect(msg.ack).toHaveBeenCalledTimes(1);
		const row = await env.DB.prepare("SELECT status FROM sap_outbox WHERE id = 'issue-1:1'").first<{ status: string }>();
		expect(row!.status).toBe('dead');
	});

	it('5. an unmapped status marks the row dead with reason unmapped_status', async () => {
		await env.DB.prepare("DELETE FROM sap_status_map WHERE flow_status = 'done'").run();
		await env.DB.prepare("UPDATE issues SET status = 'done' WHERE id = 'issue-1'").run();
		const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('', { status: 200 }));
		vi.stubGlobal('fetch', fetchMock);
		const msg = makeMsg();

		const result = await processOutboundMessage(makeEnv(), msg);

		expect(result.outcome).toBe('dead');
		expect(result.reason).toBe('unmapped_status');
		expect(fetchMock).not.toHaveBeenCalled();
		const row = await env.DB.prepare("SELECT status FROM sap_outbox WHERE id = 'issue-1:1'").first<{ status: string }>();
		expect(row!.status).toBe('dead');
	});
});
