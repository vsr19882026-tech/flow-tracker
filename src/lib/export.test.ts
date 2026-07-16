import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { buildExport } from './export';

// Export helper: CSV (RFC 4180) + JSON streaming, and the 100k-row cap (413).

beforeEach(async () => {
	await env.DB.exec('DROP TABLE IF EXISTS issues');
	await env.DB
		.prepare(
			`CREATE TABLE issues (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
				status TEXT NOT NULL DEFAULT 'open', priority TEXT NOT NULL DEFAULT 'medium', issue_number INTEGER NOT NULL,
				project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(issue_number))`,
		)
		.run();
	// Three issues; #2's title carries a comma AND a quote to exercise RFC 4180.
	const rows: Array<[number, string, string]> = [
		[1, 'plain-1', 'First issue'],
		[2, 'special-2', 'Title, with "quotes" and, commas'],
		[3, 'plain-3', 'Third issue'],
	];
	for (const [n, id, title] of rows) {
		await env.DB.prepare(
			`INSERT INTO issues (id, reporter_id, title, status, priority, issue_number, created_at, updated_at) VALUES (?, 'u1', ?, 'open', 'medium', ?, ?, ?)`,
		)
			.bind(id, title, n, n * 1000, n * 1000)
			.run();
	}
});

describe('buildExport', () => {
	it('1. CSV is RFC 4180: header row, CRLF, and quoted/escaped fields', async () => {
		const res = await buildExport(env.DB, { type: 'issues', format: 'csv' });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/csv');
		expect(res.headers.get('content-disposition')).toBe('attachment; filename="issues-all.csv"');

		const text = await res.text();
		const lines = text.split('\r\n').filter(Boolean);
		expect(lines[0]).toBe('issue_number,id,title,description,status,priority,reporter_id,project_id,created_at,updated_at');
		expect(lines).toHaveLength(4); // header + 3 rows
		// Comma + quote field is wrapped in quotes, inner quotes doubled.
		expect(text).toContain('"Title, with ""quotes"" and, commas"');
	});

	it('2. JSON is a valid array of row objects', async () => {
		const res = await buildExport(env.DB, { type: 'issues', format: 'json' });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');

		const parsed = JSON.parse(await res.text()) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(3);
		expect(parsed[0]).toMatchObject({ issue_number: 1, id: 'plain-1', title: 'First issue' });
		expect(parsed[1].title).toBe('Title, with "quotes" and, commas'); // exact, unescaped in JSON
	});

	it('3. returns 413 when the projected row count exceeds the cap', async () => {
		// 3 rows seeded, cap of 2 → over cap. (The route uses the 100k default.)
		const res = await buildExport(env.DB, { type: 'issues', format: 'csv', cap: 2 });
		expect(res.status).toBe(413);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('exceeds');
	});
});
