// Nightly D1 -> R2 backup. The cron handler in index.ts calls runBackup once a
// day (0 3 * * *). It dumps the whole database to a single SQL file — schema
// (the CREATE statements from sqlite_master) followed by data (INSERT
// statements, read in chunks of 1000 rows so a large table is never loaded all
// at once) — and writes it to R2 under backups/issues-prod/<YYYY-MM-DD>.sql. It
// then prunes backups older than the retention window so storage stays bounded.
//
// A database backup is intentionally COMPLETE: it contains every table,
// including the auth tables (sessions, accounts) and their tokens. That is
// required to restore a working database — this is a backup, not application
// logging, so the audit-log redaction rules do not apply. R2 encrypts objects
// at rest, and the bucket is private.

export const BACKUP_PREFIX = 'backups/issues-prod/';
export const RETAIN_DAYS = 30;
const CHUNK = 1000;

function ymd(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD
}

// A SQLite literal for a D1 column value. D1 returns null / number / string
// (and ArrayBuffer for BLOB columns). Strings are single-quoted with inner
// quotes doubled; blobs become X'..' hex literals.
function sqlLiteral(v: unknown): string {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'number' || typeof v === 'bigint') return String(v);
	if (v instanceof ArrayBuffer) {
		const hex = [...new Uint8Array(v)].map((b) => b.toString(16).padStart(2, '0')).join('');
		return `X'${hex}'`;
	}
	return `'${String(v).replace(/'/g, "''")}'`;
}

// Quote an identifier (table/column) with inner double-quotes doubled.
function ident(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

type SchemaObj = { type: string; name: string; sql: string };

// Build a full SQL dump of the database: all schema objects, then table data.
async function dumpDatabase(db: D1Database): Promise<string> {
	const { results: schema } = await db
		.prepare(
			`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL
			 ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
		)
		.all<SchemaObj>();

	// Skip SQLite/D1 internal objects (sqlite_*, _cf_*); the engine recreates them.
	const objs = schema.filter((o) => !o.name.startsWith('sqlite_') && !o.name.startsWith('_cf_'));

	const parts: string[] = ['PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;'];
	for (const o of objs) parts.push(o.sql.trim() + ';');

	for (const o of objs) {
		if (o.type !== 'table') continue;
		let offset = 0;
		for (;;) {
			const { results } = await db
				.prepare(`SELECT * FROM ${ident(o.name)} LIMIT ${CHUNK} OFFSET ${offset}`)
				.all<Record<string, unknown>>();
			if (results.length === 0) break;
			for (const row of results) {
				const cols = Object.keys(row);
				const colList = cols.map(ident).join(', ');
				const valList = cols.map((c) => sqlLiteral(row[c])).join(', ');
				parts.push(`INSERT INTO ${ident(o.name)} (${colList}) VALUES (${valList});`);
			}
			offset += results.length;
			if (results.length < CHUNK) break;
		}
	}
	parts.push('COMMIT;');
	return parts.join('\n') + '\n';
}

export type BackupResult = { key: string; bytes: number; deleted: string[] };

// Dump the DB, upload it under today's key, then prune old backups.
export async function runBackup(env: Env, atMs: number): Promise<BackupResult> {
	const key = `${BACKUP_PREFIX}${ymd(atMs)}.sql`;

	const sql = await dumpDatabase(env.DB);
	await env.ATTACHMENTS.put(key, sql, { httpMetadata: { contentType: 'application/sql; charset=utf-8' } });

	// Retention: delete any backup whose date is RETAIN_DAYS or more before this
	// run. Keys are dated and YYYY-MM-DD sorts chronologically, so compare the
	// key's date against the cutoff. Running one backup a day, this leaves the
	// most recent RETAIN_DAYS files.
	const cutoff = ymd(atMs - RETAIN_DAYS * 86_400_000);
	const deleted: string[] = [];
	let cursor: string | undefined;
	for (;;) {
		const listed = await env.ATTACHMENTS.list({ prefix: BACKUP_PREFIX, cursor });
		for (const obj of listed.objects) {
			const m = obj.key.match(/(\d{4}-\d{2}-\d{2})\.sql$/);
			if (m && m[1] <= cutoff) {
				await env.ATTACHMENTS.delete(obj.key);
				deleted.push(obj.key);
			}
		}
		if (!listed.truncated) break;
		cursor = listed.cursor;
	}

	return { key, bytes: sql.length, deleted };
}
