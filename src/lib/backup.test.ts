import { env } from 'cloudflare:test';
import { beforeEach, describe, it, expect } from 'vitest';
import { runBackup, BACKUP_PREFIX, RETAIN_DAYS } from './backup';

// Nightly D1 -> R2 backup: a run dumps the DB to a dated .sql object, and the
// retention pass keeps only the most recent RETAIN_DAYS daily files.

const DAY = 86_400_000;

async function clearBackups(): Promise<void> {
	for (;;) {
		const listed = await env.ATTACHMENTS.list({ prefix: BACKUP_PREFIX });
		if (listed.objects.length === 0) break;
		await env.ATTACHMENTS.delete(listed.objects.map((o) => o.key));
	}
}

beforeEach(async () => {
	await clearBackups();
	await env.DB.exec('DROP TABLE IF EXISTS issues');
	await env.DB
		.prepare(
			`CREATE TABLE issues (id TEXT PRIMARY KEY, title TEXT NOT NULL, issue_number INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
		)
		.run();
	// Two rows, one carrying a single quote to exercise SQL escaping.
	await env.DB.prepare(`INSERT INTO issues (id, title, issue_number, created_at) VALUES ('a', 'first', 1, 100)`).run();
	await env.DB.prepare(`INSERT INTO issues (id, title, issue_number, created_at) VALUES ('b', 'O''Brien bug', 2, 200)`).run();
});

describe('runBackup', () => {
	it('1. writes a dated .sql dump with schema and escaped data to R2', async () => {
		const at = Date.parse('2026-03-15T03:00:00Z');
		const result = await runBackup(env, at);

		expect(result.key).toBe(`${BACKUP_PREFIX}2026-03-15.sql`);

		const obj = await env.ATTACHMENTS.get(result.key);
		expect(obj).not.toBeNull();
		const sql = await obj!.text();

		// Schema (CREATE) precedes data (INSERT), and the seeded rows are present
		// with the inner single quote doubled per SQLite literal rules.
		expect(sql).toContain('CREATE TABLE');
		expect(sql).toContain('INSERT INTO "issues"');
		expect(sql).toContain("'first'");
		expect(sql).toContain("'O''Brien bug'");
		expect(sql.indexOf('CREATE TABLE')).toBeLessThan(sql.indexOf('INSERT INTO'));
	});

	it('2. keeps only the most recent RETAIN_DAYS daily backups', async () => {
		const base = Date.parse('2026-01-01T03:00:00Z');
		// One backup a day for RETAIN_DAYS + 1 consecutive days.
		for (let i = 0; i <= RETAIN_DAYS; i++) {
			await runBackup(env, base + i * DAY);
		}

		const listed = await env.ATTACHMENTS.list({ prefix: BACKUP_PREFIX });
		expect(listed.objects).toHaveLength(RETAIN_DAYS);

		const keys = listed.objects.map((o) => o.key);
		// The oldest (day 0) is pruned; the newest (day RETAIN_DAYS) is kept.
		expect(keys).not.toContain(`${BACKUP_PREFIX}2026-01-01.sql`);
		const newest = new Date(base + RETAIN_DAYS * DAY).toISOString().slice(0, 10);
		expect(keys).toContain(`${BACKUP_PREFIX}${newest}.sql`);
	});
});
