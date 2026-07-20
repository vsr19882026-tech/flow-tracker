import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { toSapCase, fromSapCase, UNMAPPED_STATUS } from './mapper';
import type { FieldMapRow, StatusMapRow } from './mapper';

// The mapper is driven by the sap_field_map / sap_status_map rows. These tests
// seed those tables with the same default mapping migration 0010 ships, read it
// back, and exercise the mapper against the real seeded config.

beforeEach(async () => {
	const db = env.DB;
	await db.exec('DROP TABLE IF EXISTS sap_field_map');
	await db.exec('DROP TABLE IF EXISTS sap_status_map');
	await db
		.prepare(
			`CREATE TABLE sap_field_map (flow_field TEXT NOT NULL, sap_field TEXT NOT NULL, direction TEXT NOT NULL, transform TEXT, active INTEGER NOT NULL DEFAULT 1)`,
		)
		.run();
	await db.prepare(`CREATE TABLE sap_status_map (flow_status TEXT NOT NULL, sap_status TEXT NOT NULL, direction TEXT NOT NULL)`).run();

	await db.batch([
		db.prepare(`INSERT INTO sap_field_map (flow_field, sap_field, direction, transform, active) VALUES ('title','subject','both',NULL,1)`),
		db.prepare(
			`INSERT INTO sap_field_map (flow_field, sap_field, direction, transform, active) VALUES ('description','description','both',NULL,1)`,
		),
		db.prepare(`INSERT INTO sap_field_map (flow_field, sap_field, direction, transform, active) VALUES ('status','status','both',NULL,1)`),
		db.prepare(
			`INSERT INTO sap_field_map (flow_field, sap_field, direction, transform, active) VALUES ('issue_number','externalReference','outbound',NULL,1)`,
		),
		db.prepare(`INSERT INTO sap_status_map (flow_status, sap_status, direction) VALUES ('open','New','both')`),
		db.prepare(`INSERT INTO sap_status_map (flow_status, sap_status, direction) VALUES ('in_progress','In Process','both')`),
		db.prepare(`INSERT INTO sap_status_map (flow_status, sap_status, direction) VALUES ('done','Completed','both')`),
	]);
});

async function loadMaps(): Promise<{ fieldMap: FieldMapRow[]; statusMap: StatusMapRow[] }> {
	const fieldMap = (await env.DB.prepare('SELECT * FROM sap_field_map').all<FieldMapRow>()).results;
	const statusMap = (await env.DB.prepare('SELECT * FROM sap_status_map').all<StatusMapRow>()).results;
	return { fieldMap, statusMap };
}

describe('mapper', () => {
	it('2. toSapCase applies the seeded field + status map', async () => {
		const { fieldMap, statusMap } = await loadMaps();
		const issue = { title: 'Login is broken', description: 'Steps to reproduce', status: 'open', issue_number: 42 };

		const payload = toSapCase(issue, fieldMap, statusMap);

		expect(payload.subject).toBe('Login is broken');
		expect(payload.description).toBe('Steps to reproduce');
		expect(payload.status).toBe('New'); // 'open' translated through the status map
		expect(payload.externalReference).toBe(42);
	});

	it('3. fromSapCase returns the sentinel for an unmapped status', async () => {
		const { statusMap } = await loadMaps();

		expect(fromSapCase({ status: 'In Process' }, statusMap)).toBe('in_progress');
		expect(fromSapCase({ status: 'Escalated to L3' }, statusMap)).toBe(UNMAPPED_STATUS);
	});
});
