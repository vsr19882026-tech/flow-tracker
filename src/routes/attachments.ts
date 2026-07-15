import { Hono } from 'hono';
import { AwsClient } from 'aws4fetch';

// R2 presigning credentials are Worker secrets (set via `wrangler secret put`),
// not wrangler.toml bindings, so they aren't in the generated Env. Merge them in.
declare global {
	interface Env {
		R2_ACCOUNT_ID: string;
		R2_ACCESS_KEY_ID: string;
		R2_SECRET_ACCESS_KEY: string;
	}
}

// Same shape the session middleware in index.ts sets via c.set('user', ...).
type Variables = {
	user: { id: string; email: string } | null;
};

const attachments = new Hono<{ Bindings: Env; Variables: Variables }>();

// R2 object key prefix / bucket. The bucket name matches wrangler.toml's
// [[r2_buckets]] bucket_name for the ATTACHMENTS binding.
const BUCKET = 'issue-attachments';
const MAX_SIZE = 20 * 1024 * 1024; // 20MB
const PRESIGN_EXPIRY_SECONDS = 600; // 10 minutes

function sizeAllowed(size: unknown): size is number {
	return typeof size === 'number' && Number.isFinite(size) && size > 0 && size <= MAX_SIZE;
}

function mimeAllowed(mime: unknown): mime is string {
	return typeof mime === 'string' && (mime.startsWith('image/') || mime === 'application/pdf' || mime === 'text/plain');
}

// Presign an R2 object URL for a single HTTP method. The R2 binding cannot
// presign; presigning needs the S3-compatible endpoint signed with R2 access
// keys (aws4fetch, signQuery). Returns the signed URL with an X-Amz-Expires TTL.
async function presign(env: Env, r2Key: string, method: 'PUT' | 'GET'): Promise<string> {
	const client = new AwsClient({
		accessKeyId: env.R2_ACCESS_KEY_ID,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY,
		service: 's3',
		region: 'auto',
	});
	const url = new URL(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${r2Key}`);
	url.searchParams.set('X-Amz-Expires', String(PRESIGN_EXPIRY_SECONDS));
	const signed = await client.sign(url.toString(), { method, aws: { signQuery: true } });
	return signed.url;
}

// Resolve the :issue_number path param to the issues.id (uuid); null if unknown.
async function resolveIssueId(env: Env, issueNumberParam: string | undefined): Promise<string | null> {
	const issueNumber = Number(issueNumberParam);
	if (!issueNumberParam || !Number.isInteger(issueNumber)) {
		return null;
	}
	const row = await env.DB.prepare('SELECT id FROM issues WHERE issue_number = ?').bind(issueNumber).first<{ id: string }>();
	return row ? row.id : null;
}

// POST /issues/:issue_number/attachments — request a presigned R2 PUT URL.
// Validates size + mime; does NOT write the DB row (that happens on /confirm).
attachments.post('/', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const issueId = await resolveIssueId(c.env, c.req.param('issue_number'));
	if (!issueId) {
		return c.json({ error: 'Not found' }, 404);
	}

	// Malformed JSON throws and propagates (see app.onError) — happy path only.
	const body = (await c.req.json()) as { filename?: unknown; mime?: unknown; size?: unknown };
	if (!sizeAllowed(body.size)) {
		return c.json({ error: `size must be a positive number ≤ ${MAX_SIZE} bytes` }, 400);
	}
	if (!mimeAllowed(body.mime)) {
		return c.json({ error: 'mime must be image/*, application/pdf, or text/plain' }, 400);
	}
	const filename = typeof body.filename === 'string' && body.filename.trim() ? body.filename.trim() : '';
	if (!filename) {
		return c.json({ error: 'filename is required' }, 400);
	}

	const id = crypto.randomUUID();
	const r2Key = `issues/${issueId}/${id}/${filename}`;
	const url = await presign(c.env, r2Key, 'PUT');

	return c.json({ id, r2_key: r2Key, url });
});

// POST /issues/:issue_number/attachments/:id/confirm — after the client PUTs the
// file, persist the metadata row. Re-validates size + mime, then writes the row.
attachments.post('/:id/confirm', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const issueId = await resolveIssueId(c.env, c.req.param('issue_number'));
	if (!issueId) {
		return c.json({ error: 'Not found' }, 404);
	}

	const id = c.req.param('id');
	const body = (await c.req.json()) as { r2_key?: unknown; filename?: unknown; mime?: unknown; size?: unknown };
	if (!sizeAllowed(body.size)) {
		return c.json({ error: `size must be a positive number ≤ ${MAX_SIZE} bytes` }, 400);
	}
	if (!mimeAllowed(body.mime)) {
		return c.json({ error: 'mime must be image/*, application/pdf, or text/plain' }, 400);
	}
	const r2Key = typeof body.r2_key === 'string' ? body.r2_key : '';
	const filename = typeof body.filename === 'string' ? body.filename : '';
	if (!r2Key || !filename) {
		return c.json({ error: 'r2_key and filename are required' }, 400);
	}

	const row = await c.env.DB.prepare(
		`INSERT INTO attachments (id, issue_id, uploader_id, r2_key, filename, mime, size, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 RETURNING id, issue_id, uploader_id, r2_key, filename, mime, size, created_at`,
	)
		.bind(id, issueId, user.id, r2Key, filename, body.mime, body.size, Date.now())
		.first();

	return c.json(row);
});

// GET /issues/:issue_number/attachments/:id — presigned GET url for the object.
attachments.get('/:id', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}

	const issueId = await resolveIssueId(c.env, c.req.param('issue_number'));
	if (!issueId) {
		return c.json({ error: 'Not found' }, 404);
	}

	const id = c.req.param('id');
	const row = await c.env.DB.prepare('SELECT r2_key FROM attachments WHERE id = ? AND issue_id = ?')
		.bind(id, issueId)
		.first<{ r2_key: string }>();
	if (!row) {
		return c.json({ error: 'Not found' }, 404);
	}

	const url = await presign(c.env, row.r2_key, 'GET');
	return c.json({ url });
});

export default attachments;
