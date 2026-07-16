// Streaming CSV / JSON export for compliance. Never buffers the whole result:
// the response body is a ReadableStream that pages through D1 and encodes rows
// as it goes, so memory stays bounded regardless of row count. Refuses (413)
// rather than stream a result larger than the cap.

export const ROW_CAP = 100_000;
const PAGE = 1_000;

type ExportConfig = {
	table: string;
	columns: string[];
	dateCol: string;
	dateKind: 'epoch' | 'iso';
};

// Column sets are hardcoded per type (never user input) so the SELECT list and
// table name interpolated below can't be injected. Only `since` is bound.
const CONFIGS: Record<string, ExportConfig> = {
	issues: {
		table: 'issues',
		columns: ['issue_number', 'id', 'title', 'description', 'status', 'priority', 'reporter_id', 'project_id', 'created_at', 'updated_at'],
		dateCol: 'created_at',
		dateKind: 'epoch',
	},
	audit: {
		table: 'audit_log',
		columns: ['id', 'actor_id', 'action', 'target_type', 'target_id', 'diff', 'ip', 'user_agent', 'created_at'],
		dateCol: 'created_at',
		dateKind: 'epoch',
	},
	users: {
		table: '"user"',
		columns: ['id', 'email', 'name', 'role', 'emailVerified', 'createdAt', 'updatedAt'],
		dateCol: 'createdAt',
		dateKind: 'iso',
	},
};

// RFC 4180: quote a field only if it contains a comma, quote, CR or LF; escape
// embedded quotes by doubling them.
function csvField(value: unknown): string {
	const s = value === null || value === undefined ? '' : String(value);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function isValidSince(since: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(since) && !Number.isNaN(Date.parse(since));
}

function errorResponse(message: string, status: number): Response {
	return new Response(JSON.stringify({ error: message }), { status, headers: { 'content-type': 'application/json' } });
}

export type ExportOptions = { type: string; format: string; since?: string; bom?: boolean; cap?: number };

export async function buildExport(db: D1Database, opts: ExportOptions): Promise<Response> {
	const cap = opts.cap ?? ROW_CAP;
	const cfg = CONFIGS[opts.type];
	if (!cfg) {
		return errorResponse('type must be one of issues, audit, users', 400);
	}
	const format = opts.format === 'json' ? 'json' : opts.format === 'csv' ? 'csv' : null;
	if (!format) {
		return errorResponse('format must be csv or json', 400);
	}
	const hasSince = opts.since !== undefined && opts.since !== '';
	if (hasSince && !isValidSince(opts.since!)) {
		return errorResponse('since must be a YYYY-MM-DD date', 400);
	}

	const sinceVal: unknown = hasSince ? (cfg.dateKind === 'epoch' ? Date.parse(opts.since!) : opts.since!) : null;
	const where = hasSince ? `WHERE ${cfg.dateCol} >= ?` : '';
	const binds = hasSince ? [sinceVal] : [];

	// Count first: refuse an over-cap export up front, with headers unsent, so we
	// never start streaming a body we would have to abort.
	const countRow = await db.prepare(`SELECT COUNT(*) AS n FROM ${cfg.table} ${where}`).bind(...binds).first<{ n: number }>();
	const total = countRow?.n ?? 0;
	if (total > cap) {
		return errorResponse(`export of ${total} rows exceeds the ${cap}-row cap`, 413);
	}

	const cols = cfg.columns.join(', ');
	const enc = new TextEncoder();
	let offset = 0;
	let jsonFirst = true;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			if (format === 'csv') {
				if (opts.bom) controller.enqueue(new Uint8Array([0xef, 0xbb, 0xbf])); // UTF-8 BOM
				controller.enqueue(enc.encode(cfg.columns.map(csvField).join(',') + '\r\n'));
			} else {
				controller.enqueue(enc.encode('['));
			}
		},
		async pull(controller) {
			const { results } = await db
				.prepare(`SELECT ${cols} FROM ${cfg.table} ${where} ORDER BY ${cfg.dateCol} LIMIT ${PAGE} OFFSET ${offset}`)
				.bind(...binds)
				.all<Record<string, unknown>>();

			if (results.length === 0) {
				if (format === 'json') controller.enqueue(enc.encode(']'));
				controller.close();
				return;
			}
			offset += results.length;

			if (format === 'csv') {
				let chunk = '';
				for (const row of results) {
					chunk += cfg.columns.map((col) => csvField(row[col])).join(',') + '\r\n';
				}
				controller.enqueue(enc.encode(chunk));
			} else {
				let chunk = '';
				for (const row of results) {
					const obj: Record<string, unknown> = {};
					for (const col of cfg.columns) obj[col] = row[col];
					chunk += (jsonFirst ? '' : ',') + JSON.stringify(obj);
					jsonFirst = false;
				}
				controller.enqueue(enc.encode(chunk));
			}
		},
	});

	const filename = `${opts.type}-${hasSince ? opts.since : 'all'}.${format}`;
	return new Response(stream, {
		headers: {
			'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
			'content-disposition': `attachment; filename="${filename}"`,
		},
	});
}
