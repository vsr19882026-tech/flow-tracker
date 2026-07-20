import { Hono } from 'hono';
import type { FC, Child } from 'hono/jsx';
import { requireAdmin, isValidUserRole, USER_ROLES } from '../lib/authz';
import type { AuthUser } from '../lib/authz';
import { parseInviteEmails } from '../lib/invites';
import { sendInviteEmail } from '../email';
import { buildExport } from '../lib/export';
import { replayOutbox } from '../lib/sap/replay';
import { FIELD_REGISTRY } from '../lib/layout/registry';
import { fieldLabel } from '../lib/layout/render';
import { loadActiveLayout } from '../lib/layout/store';
import { loadSapMode, setSapMode } from '../lib/sap/target';
import type { SapMode } from '../lib/sap/target';

type Variables = { user: AuthUser | null };

const admin = new Hono<{ Bindings: Env; Variables: Variables }>();

// Gate the whole /admin section: must be signed in AND an admin. requireAdmin
// throws HTTPException(403), which app.onError turns into a clean 403 response.
admin.use('*', async (c, next) => {
	const user = c.get('user');
	if (!user) {
		return c.json({ error: 'Unauthorized' }, 401);
	}
	requireAdmin(user);
	return next();
});

// ---- shared layout ----
const NAV = [
	['/admin/users', 'Users'],
	['/admin/invites', 'Invites'],
	['/admin/projects', 'Projects'],
	['/admin/audit', 'Audit'],
	['/admin/integrations/sap', 'SAP'],
	['/admin/layout', 'Layout'],
] as const;

const Layout: FC<{ title: string; children?: Child }> = (props) => (
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<title>{props.title} · Flow Tracker admin</title>
			<script src="https://cdn.tailwindcss.com"></script>
		</head>
		<body class="bg-slate-50 text-slate-800 antialiased">
			<div class="max-w-5xl mx-auto px-6 py-8">
				<header class="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4 mb-8">
					<div>
						<h1 class="text-lg font-semibold tracking-tight">Flow Tracker · Admin</h1>
						<p class="text-sm text-slate-500">{props.title}</p>
					</div>
					<nav class="flex gap-1 text-sm">
						{NAV.map(([href, label]) => (
							<a href={href} class="rounded-md px-3 py-1.5 text-slate-600 hover:bg-slate-200 hover:text-slate-900">
								{label}
							</a>
						))}
					</nav>
				</header>
				{props.children}
			</div>
		</body>
	</html>
);

const Th: FC<{ children?: Child }> = (props) => (
	<th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">{props.children}</th>
);
const Td: FC<{ children?: Child }> = (props) => <td class="px-3 py-2 align-middle text-sm">{props.children}</td>;

// ---- GET /admin/users ----
type UserRow = { id: string; email: string; role: string; last_seen_at: string | null };

admin.get('/users', async (c) => {
	const { results: users } = await c.env.DB.prepare(
		`SELECT u.id, u.email, u.role,
		        (SELECT MAX(s.createdAt) FROM session s WHERE s.userId = u.id) AS last_seen_at
		   FROM "user" u
		  ORDER BY u.createdAt DESC`,
	).all<UserRow>();

	// createdAt is stored as an ISO string, so compare against an ISO cutoff.
	const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
	const signups = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE createdAt > ?`).bind(weekAgo).first<{ n: number }>();

	return c.html(
		<Layout title="Users">
			<div class="mb-4 flex items-baseline justify-between">
				<h2 class="text-base font-semibold">{users.length} users</h2>
				<span class="rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-700">{signups?.n ?? 0} signups this week</span>
			</div>
			<div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
				<table class="min-w-full divide-y divide-slate-200">
					<thead class="bg-slate-50">
						<tr>
							<Th>Email</Th>
							<Th>Role</Th>
							<Th>Last seen</Th>
							<Th>Change role</Th>
						</tr>
					</thead>
					<tbody class="divide-y divide-slate-100">
						{users.map((u) => (
							<tr>
								<Td>{u.email}</Td>
								<Td>
									<span class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{u.role}</span>
								</Td>
								<Td>{u.last_seen_at ? u.last_seen_at.slice(0, 10) : '—'}</Td>
								<Td>
									<form method="post" action={`/admin/users/${u.id}/role`} class="flex items-center gap-2">
										<select name="role" class="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
											{USER_ROLES.map((r) => (
												<option value={r} selected={r === u.role}>
													{r}
												</option>
											))}
										</select>
										<button type="submit" class="rounded-md bg-slate-800 px-3 py-1 text-sm font-medium text-white hover:bg-slate-700">
											Update
										</button>
									</form>
								</Td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</Layout>,
	);
});

// ---- POST /admin/users/:id/role ----
admin.post('/users/:id/role', async (c) => {
	const id = c.req.param('id');
	const body = await c.req.parseBody();
	const role = String(body.role ?? '');
	if (!isValidUserRole(role)) {
		return c.json({ error: 'role must be admin, member, or viewer' }, 400);
	}
	await c.env.DB.prepare('UPDATE "user" SET role = ?, updatedAt = ? WHERE id = ?').bind(role, new Date().toISOString(), id).run();
	return c.redirect('/admin/users');
});

// ---- GET /admin/invites ----
type InviteRow = { email: string; invited_by_email: string; created_at: number; consumed_at: number | null };

admin.get('/invites', async (c) => {
	const { results: invites } = await c.env.DB.prepare(
		`SELECT i.email, i.created_at, i.consumed_at, u.email AS invited_by_email
		   FROM invites i
		   JOIN "user" u ON u.id = i.invited_by
		  ORDER BY i.created_at DESC`,
	).all<InviteRow>();

	const pending = invites.filter((i) => i.consumed_at === null).length;

	return c.html(
		<Layout title="Invites">
			<div class="grid gap-8 md:grid-cols-[1fr_20rem]">
				<div>
					<h2 class="mb-4 text-base font-semibold">
						{invites.length} invites · {pending} pending
					</h2>
					<div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
						<table class="min-w-full divide-y divide-slate-200">
							<thead class="bg-slate-50">
								<tr>
									<Th>Email</Th>
									<Th>Invited by</Th>
									<Th>Created</Th>
									<Th>Status</Th>
								</tr>
							</thead>
							<tbody class="divide-y divide-slate-100">
								{invites.length === 0 ? (
									<tr>
										<td colspan={4} class="px-3 py-6 text-center text-sm text-slate-400">
											No pending invites.
										</td>
									</tr>
								) : (
									invites.map((i) => (
										<tr>
											<Td>{i.email}</Td>
											<Td>{i.invited_by_email}</Td>
											<Td>{new Date(i.created_at).toISOString().slice(0, 10)}</Td>
											<Td>
												{i.consumed_at === null ? (
													<span class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">Pending</span>
												) : (
													<span class="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
														Accepted {new Date(i.consumed_at).toISOString().slice(0, 10)}
													</span>
												)}
											</Td>
										</tr>
									))
								)}
							</tbody>
						</table>
					</div>
				</div>
				<form method="post" action="/admin/invites" class="rounded-lg border border-slate-200 bg-white p-4">
					<h2 class="mb-2 text-base font-semibold">Bulk invite</h2>
					<p class="mb-3 text-sm text-slate-500">Paste emails separated by commas, spaces, or newlines.</p>
					<textarea
						name="emails"
						rows={6}
						placeholder="a@northwind.dev, b@northwind.dev"
						class="w-full rounded-md border border-slate-300 p-2 text-sm"
					></textarea>
					<button type="submit" class="mt-3 w-full rounded-md bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700">
						Send invites
					</button>
				</form>
			</div>
		</Layout>,
	);
});

// ---- POST /admin/invites ----
admin.post('/invites', async (c) => {
	const user = c.get('user')!;
	const body = await c.req.parseBody();
	const emails = parseInviteEmails(String(body.emails ?? ''));
	const now = Date.now();
	if (emails.length > 0) {
		await c.env.DB.batch(
			emails.map((email) =>
				c.env.DB.prepare('INSERT INTO invites (id, email, invited_by, created_at) VALUES (?, ?, ?, ?)').bind(
					crypto.randomUUID(),
					email,
					user.id,
					now,
				),
			),
		);
		// Fire the invite emails via the Email Worker. Best-effort per address:
		// delivery to an unverified recipient fails (send_email only reaches
		// verified addresses), and a failed send must not roll back the invite
		// rows already written — so swallow per-address errors (no try/catch).
		await Promise.all(emails.map((email) => sendInviteEmail(c.env, email).then(() => {}, () => {})));
	}
	return c.redirect('/admin/invites');
});

// ---- GET /admin/projects ----
type ProjectRow = { id: string; name: string; slug: string; owner_email: string; member_count: number; issue_count: number };

admin.get('/projects', async (c) => {
	const { results: projects } = await c.env.DB.prepare(
		`SELECT p.id, p.name, p.slug, u.email AS owner_email,
		        (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS member_count,
		        (SELECT COUNT(*) FROM issues i WHERE i.project_id = p.id) AS issue_count
		   FROM projects p
		   JOIN "user" u ON u.id = p.owner_id
		  ORDER BY p.created_at DESC`,
	).all<ProjectRow>();

	return c.html(
		<Layout title="Projects">
			<h2 class="mb-4 text-base font-semibold">{projects.length} projects</h2>
			<div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
				<table class="min-w-full divide-y divide-slate-200">
					<thead class="bg-slate-50">
						<tr>
							<Th>Project</Th>
							<Th>Owner</Th>
							<Th>Members</Th>
							<Th>Issues</Th>
						</tr>
					</thead>
					<tbody class="divide-y divide-slate-100">
						{projects.map((p) => (
							<tr>
								<Td>
									<span class="font-medium">{p.name}</span> <span class="text-slate-400">/{p.slug}</span>
								</Td>
								<Td>{p.owner_email}</Td>
								<Td>{p.member_count}</Td>
								<Td>{p.issue_count}</Td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</Layout>,
	);
});

// ---- GET /admin/audit ----
type AuditRow = { actor_id: string; action: string; target_type: string; target_id: string; diff: string | null; created_at: number };
const PAGE_SIZE = 50;

admin.get('/audit', async (c) => {
	const actor = c.req.query('actor')?.trim() ?? '';
	const action = c.req.query('action')?.trim() ?? '';
	const from = c.req.query('from')?.trim() ?? '';
	const to = c.req.query('to')?.trim() ?? '';
	const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);

	// Build the WHERE clause from whichever filters were supplied.
	const conditions: string[] = [];
	const binds: unknown[] = [];
	if (actor) {
		conditions.push('actor_id = ?');
		binds.push(actor);
	}
	if (action) {
		conditions.push('action LIKE ?');
		binds.push(`%${action}%`);
	}
	if (from && !Number.isNaN(Date.parse(from))) {
		conditions.push('created_at >= ?');
		binds.push(Date.parse(from));
	}
	if (to && !Number.isNaN(Date.parse(to))) {
		// Inclusive of the whole `to` day.
		conditions.push('created_at < ?');
		binds.push(Date.parse(to) + 24 * 60 * 60 * 1000);
	}
	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

	const { results: rows } = await c.env.DB.prepare(
		`SELECT actor_id, action, target_type, target_id, diff, created_at
		   FROM audit_log ${where}
		  ORDER BY created_at DESC
		  LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
	)
		.bind(...binds)
		.all<AuditRow>();

	const qs = (p: number) =>
		`?${new URLSearchParams({ actor, action, from, to, page: String(p) }).toString()}`;

	return c.html(
		<Layout title="Audit log">
			<form method="get" class="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4">
				<label class="text-sm">
					<span class="block text-xs font-medium text-slate-500">Actor id</span>
					<input name="actor" value={actor} class="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm" />
				</label>
				<label class="text-sm">
					<span class="block text-xs font-medium text-slate-500">Action contains</span>
					<input name="action" value={action} placeholder="POST /issues" class="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm" />
				</label>
				<label class="text-sm">
					<span class="block text-xs font-medium text-slate-500">From</span>
					<input type="date" name="from" value={from} class="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm" />
				</label>
				<label class="text-sm">
					<span class="block text-xs font-medium text-slate-500">To</span>
					<input type="date" name="to" value={to} class="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm" />
				</label>
				<button type="submit" class="rounded-md bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700">Filter</button>
				<a href="/admin/audit" class="rounded-md px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100">Reset</a>
			</form>

			<div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
				<table class="min-w-full divide-y divide-slate-200">
					<thead class="bg-slate-50">
						<tr>
							<Th>When</Th>
							<Th>Actor</Th>
							<Th>Action</Th>
							<Th>Target</Th>
							<Th>Diff</Th>
						</tr>
					</thead>
					<tbody class="divide-y divide-slate-100">
						{rows.length === 0 ? (
							<tr>
								<td colspan={5} class="px-3 py-6 text-center text-sm text-slate-400">
									No audit entries match.
								</td>
							</tr>
						) : (
							rows.map((r) => (
								<tr>
									<Td>{new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19)}</Td>
									<Td>{r.actor_id}</Td>
									<Td>
										<span class="font-mono text-xs">{r.action}</span>
									</Td>
									<Td>
										{r.target_type}
										{r.target_id ? ` #${r.target_id}` : ''}
									</Td>
									<Td>
										<span class="font-mono text-xs text-slate-500">{r.diff ?? ''}</span>
									</Td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>

			<div class="mt-4 flex items-center justify-between text-sm">
				<span class="text-slate-500">Page {page}</span>
				<div class="flex gap-2">
					{page > 1 ? (
						<a href={qs(page - 1)} class="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-100">
							← Prev
						</a>
					) : null}
					{rows.length === PAGE_SIZE ? (
						<a href={qs(page + 1)} class="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-100">
							Next →
						</a>
					) : null}
				</div>
			</div>
		</Layout>,
	);
});

// ---- GET /admin/export ----
// Streaming CSV/JSON export for compliance. Admin-only (this whole sub-app is
// gated by requireAdmin). The streaming + capping lives in src/lib/export.ts.
admin.get('/export', (c) => {
	const bom = c.req.query('bom');
	return buildExport(c.env.DB, {
		type: c.req.query('type') ?? '',
		format: c.req.query('format') ?? 'csv',
		since: c.req.query('since'),
		bom: bom === '1' || bom === 'true',
	});
});

// ---- SAP integration tab ----
type DlqRow = { id: string; issue_id: string; event_type: string; created_at: number };
type FieldMapRow = { flow_field: string; sap_field: string; direction: string; active: number };
type StatusMapRow = { flow_status: string; sap_status: string; direction: string };
type StateRow = { key: string; watermark: string | null };

const MAP_DIRECTIONS = ['outbound', 'inbound', 'both'] as const;

const DirSelect: FC<{ name: string; value: string }> = (props) => (
	<select name={props.name} class="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
		{MAP_DIRECTIONS.map((d) => (
			<option value={d} selected={d === props.value}>
				{d}
			</option>
		))}
	</select>
);

// ---- GET /admin/integrations/sap ----
admin.get('/integrations/sap', async (c) => {
	const db = c.env.DB;
	const { mode, mockBase } = await loadSapMode(c.env);
	const linked = await db.prepare('SELECT COUNT(*) AS n FROM sap_links').first<{ n: number }>();
	const dead = await db.prepare("SELECT COUNT(*) AS n FROM sap_outbox WHERE status = 'dead'").first<{ n: number }>();
	const { results: state } = await db.prepare('SELECT key, watermark FROM sync_state ORDER BY key').all<StateRow>();
	const { results: dlq } = await db
		.prepare("SELECT id, issue_id, event_type, created_at FROM sap_outbox WHERE status = 'dead' ORDER BY created_at DESC")
		.all<DlqRow>();
	const { results: fieldMap } = await db.prepare('SELECT flow_field, sap_field, direction, active FROM sap_field_map ORDER BY flow_field').all<FieldMapRow>();
	const { results: statusMap } = await db.prepare('SELECT flow_status, sap_status, direction FROM sap_status_map ORDER BY flow_status').all<StatusMapRow>();

	return c.html(
		<Layout title="SAP integration">
			<div class="mb-6 flex flex-wrap gap-3">
				<span class="rounded-full bg-emerald-100 px-3 py-1 text-sm font-medium text-emerald-700">{linked?.n ?? 0} linked issues</span>
				<span class="rounded-full bg-rose-100 px-3 py-1 text-sm font-medium text-rose-700">{dead?.n ?? 0} dead (DLQ)</span>
				<span class="rounded-full bg-slate-200 px-3 py-1 text-sm font-medium text-slate-700">mode: {mode}</span>
			</div>

			<h2 class="mb-2 text-base font-semibold">Sync mode</h2>
			<form method="post" action="/admin/integrations/sap/mode" class="mb-8 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-4">
				<label class="text-sm">
					<span class="mb-1 block text-slate-500">Mode</span>
					<select name="mode" class="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
						{(['off', 'mock', 'real'] as const).map((m) => (
							<option value={m} selected={m === mode}>
								{m}
							</option>
						))}
					</select>
				</label>
				<label class="flex-1 text-sm">
					<span class="mb-1 block text-slate-500">Mock base URL (mock mode)</span>
					<input name="mock_base" value={mockBase ?? ''} placeholder="https://mock-sap.example.workers.dev" class="w-full rounded-md border border-slate-300 px-2 py-1 text-sm" />
				</label>
				<button type="submit" class="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
					Save mode
				</button>
			</form>

			<h2 class="mb-2 text-base font-semibold">Sync state</h2>
			<div class="mb-8 overflow-x-auto rounded-lg border border-slate-200 bg-white">
				<table class="min-w-full divide-y divide-slate-200">
					<thead class="bg-slate-50">
						<tr>
							<Th>Key</Th>
							<Th>Watermark</Th>
						</tr>
					</thead>
					<tbody class="divide-y divide-slate-100">
						{state.length === 0 ? (
							<tr>
								<Td>—</Td>
								<Td>no sync yet</Td>
							</tr>
						) : (
							state.map((s) => (
								<tr>
									<Td>{s.key}</Td>
									<Td>{s.watermark ?? '—'}</Td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>

			<h2 class="mb-2 text-base font-semibold">Dead-letter queue</h2>
			<div class="mb-8 overflow-x-auto rounded-lg border border-slate-200 bg-white">
				<table class="min-w-full divide-y divide-slate-200">
					<thead class="bg-slate-50">
						<tr>
							<Th>Outbox id</Th>
							<Th>Issue</Th>
							<Th>Event</Th>
							<Th>Replay</Th>
						</tr>
					</thead>
					<tbody class="divide-y divide-slate-100">
						{dlq.length === 0 ? (
							<tr>
								<Td>—</Td>
								<Td>nothing dead</Td>
								<Td>—</Td>
								<Td>—</Td>
							</tr>
						) : (
							dlq.map((d) => (
								<tr>
									<Td>{d.id}</Td>
									<Td>{d.issue_id}</Td>
									<Td>{d.event_type}</Td>
									<Td>
										<form method="post" action="/admin/integrations/sap/replay">
											<input type="hidden" name="outboxId" value={d.id} />
											<button type="submit" class="rounded-md bg-slate-800 px-3 py-1 text-sm font-medium text-white hover:bg-slate-700">
												Replay
											</button>
										</form>
									</Td>
								</tr>
							))
						)}
					</tbody>
				</table>
			</div>

			<h2 class="mb-2 text-base font-semibold">Field &amp; status mappings</h2>
			<form method="post" action="/admin/integrations/sap/mappings" class="space-y-6">
				<div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
					<table class="min-w-full divide-y divide-slate-200">
						<thead class="bg-slate-50">
							<tr>
								<Th>Flow field</Th>
								<Th>SAP field</Th>
								<Th>Direction</Th>
								<Th>Active</Th>
							</tr>
						</thead>
						<tbody class="divide-y divide-slate-100">
							{fieldMap.map((f) => (
								<tr>
									<Td>
										<input name="ff" value={f.flow_field} class="rounded-md border border-slate-300 px-2 py-1 text-sm" />
									</Td>
									<Td>
										<input name="fs" value={f.sap_field} class="rounded-md border border-slate-300 px-2 py-1 text-sm" />
									</Td>
									<Td>
										<DirSelect name="fd" value={f.direction} />
									</Td>
									<Td>
										<select name="fa" class="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
											<option value="1" selected={f.active === 1}>
												yes
											</option>
											<option value="0" selected={f.active !== 1}>
												no
											</option>
										</select>
									</Td>
								</tr>
							))}
						</tbody>
					</table>
				</div>

				<div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
					<table class="min-w-full divide-y divide-slate-200">
						<thead class="bg-slate-50">
							<tr>
								<Th>Flow status</Th>
								<Th>SAP status</Th>
								<Th>Direction</Th>
							</tr>
						</thead>
						<tbody class="divide-y divide-slate-100">
							{statusMap.map((s) => (
								<tr>
									<Td>
										<input name="sf" value={s.flow_status} class="rounded-md border border-slate-300 px-2 py-1 text-sm" />
									</Td>
									<Td>
										<input name="ss" value={s.sap_status} class="rounded-md border border-slate-300 px-2 py-1 text-sm" />
									</Td>
									<Td>
										<DirSelect name="sd" value={s.direction} />
									</Td>
								</tr>
							))}
						</tbody>
					</table>
				</div>

				<button type="submit" class="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
					Save mappings
				</button>
			</form>
		</Layout>,
	);
});

// ---- POST /admin/integrations/sap/mappings ----
// Full-replace upsert of both maps from the edited tables. Validates directions
// before touching the DB so a bad value is a clean 400, not a broken map.
admin.post('/integrations/sap/mappings', async (c) => {
	const body = await c.req.parseBody({ all: true });
	const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === undefined ? [] : [String(v)]);
	const ff = arr(body.ff);
	const fs = arr(body.fs);
	const fd = arr(body.fd);
	const fa = arr(body.fa);
	const sf = arr(body.sf);
	const ss = arr(body.ss);
	const sd = arr(body.sd);

	const validDir = (d: string): boolean => (MAP_DIRECTIONS as readonly string[]).includes(d);
	if (!fd.every(validDir) || !sd.every(validDir)) {
		return c.json({ error: 'direction must be outbound, inbound, or both' }, 400);
	}

	const stmts = [c.env.DB.prepare('DELETE FROM sap_field_map'), c.env.DB.prepare('DELETE FROM sap_status_map')];
	for (let i = 0; i < ff.length; i++) {
		if (!ff[i] || !fs[i]) continue;
		stmts.push(
			c.env.DB.prepare('INSERT INTO sap_field_map (flow_field, sap_field, direction, transform, active) VALUES (?, ?, ?, NULL, ?)').bind(
				ff[i],
				fs[i],
				fd[i] ?? 'both',
				fa[i] === '1' ? 1 : 0,
			),
		);
	}
	for (let i = 0; i < sf.length; i++) {
		if (!sf[i] || !ss[i]) continue;
		stmts.push(c.env.DB.prepare('INSERT INTO sap_status_map (flow_status, sap_status, direction) VALUES (?, ?, ?)').bind(sf[i], ss[i], sd[i] ?? 'both'));
	}
	await c.env.DB.batch(stmts);
	return c.redirect('/admin/integrations/sap');
});

// ---- POST /admin/integrations/sap/mode ----
admin.post('/integrations/sap/mode', async (c) => {
	const body = await c.req.parseBody();
	const mode = String(body.mode ?? '');
	if (mode !== 'off' && mode !== 'mock' && mode !== 'real') {
		return c.json({ error: 'mode must be off, mock, or real' }, 400);
	}
	const raw = typeof body.mock_base === 'string' ? body.mock_base.trim() : '';
	await setSapMode(c.env, mode as SapMode, raw !== '' ? raw : null);
	return c.redirect('/admin/integrations/sap');
});

// ---- POST /admin/integrations/sap/replay ----
admin.post('/integrations/sap/replay', async (c) => {
	const body = await c.req.parseBody();
	const outboxId = typeof body.outboxId === 'string' ? body.outboxId : '';
	if (!outboxId) {
		return c.json({ error: 'outboxId is required' }, 400);
	}
	const replayed = await replayOutbox(c.env, outboxId);
	if (!replayed) {
		return c.json({ error: 'Not found' }, 404);
	}
	return c.redirect('/admin/integrations/sap');
});

// ---- Layout Studio ----
// Client script: SortableJS reorder + Save/Revert via fetch. No build step.
const LAYOUT_STUDIO_SCRIPT = `(function(){
	var list = document.getElementById('lfList');
	if (window.Sortable) Sortable.create(list, { handle: '.handle', animation: 150 });
	function collect(){
		var fields = [];
		list.querySelectorAll('.lf-row').forEach(function(row, i){
			fields.push({ key: row.getAttribute('data-key'), order: i, visible: row.querySelector('.lf-visible').checked, label: row.querySelector('.lf-label').value, section: '' });
		});
		return fields;
	}
	document.getElementById('lfSave').addEventListener('click', function(){
		fetch('/admin/layout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fields: collect() }) })
			.then(function(r){ if (r.ok) { location.reload(); } else { r.json().then(function(e){ alert(e.error || 'Save failed'); }); } });
	});
	var revert = document.getElementById('lfRevert');
	if (revert) revert.addEventListener('click', function(){
		fetch('/admin/layout/revert', { method: 'POST' })
			.then(function(r){ if (r.ok) { location.reload(); } else { r.json().then(function(e){ alert(e.error || 'Revert failed'); }); } });
	});
})();`;

type StudioRow = { key: string; label: string; visible: boolean };

// ---- GET /admin/layout ----
admin.get('/layout', async (c) => {
	const active = await loadActiveLayout(c.env.DB);
	const inLayout = new Set(active.fields.map((f) => f.field));
	const rows: StudioRow[] = [
		...active.fields.filter((f) => f.field in FIELD_REGISTRY).map((f) => ({ key: f.field, label: f.label ?? fieldLabel(f.field), visible: !f.hidden })),
		...Object.keys(FIELD_REGISTRY)
			.filter((k) => !inLayout.has(k))
			.map((k) => ({ key: k, label: fieldLabel(k), visible: true })),
	];

	return c.html(
		<Layout title="Layout Studio">
			<p class="mb-4 text-sm text-slate-500">Drag to reorder, toggle visibility, and rename field labels. Title and status must stay visible.</p>
			<div id="lfList" class="mb-6 space-y-2">
				{rows.map((r) => {
					const required = FIELD_REGISTRY[r.key].required;
					return (
						<div class="lf-row flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2" data-key={r.key}>
							<span class="handle cursor-grab select-none text-slate-400">⠿</span>
							<span class="w-32 font-mono text-sm">
								{r.key}
								{required ? <span class="ml-1 text-xs text-rose-600">(required)</span> : ''}
							</span>
							<input class="lf-label flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm" value={r.label} />
							<label class="flex items-center gap-1 text-sm text-slate-600">
								<input type="checkbox" class="lf-visible" checked={r.visible} /> visible
							</label>
						</div>
					);
				})}
			</div>
			<div class="flex gap-2">
				<button id="lfSave" type="button" class="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700">
					Save layout
				</button>
				<button id="lfRevert" type="button" class="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100">
					Revert to previous
				</button>
			</div>
			<script src="https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js"></script>
			<script dangerouslySetInnerHTML={{ __html: LAYOUT_STUDIO_SCRIPT }}></script>
		</Layout>,
	);
});

// ---- POST /admin/layout ----
// Validate the submitted layout against the registry, then save it as a new
// active version. Any failure leaves the active layout unchanged (400 before write).
admin.post('/layout', async (c) => {
	const user = c.get('user') as AuthUser;
	const body = (await c.req.json()) as { fields?: Array<{ key?: unknown; order?: unknown; visible?: unknown; label?: unknown; section?: unknown }> };
	const fields = Array.isArray(body.fields) ? body.fields : [];

	// Every key exists in the registry.
	for (const f of fields) {
		if (typeof f.key !== 'string' || !(f.key in FIELD_REGISTRY)) {
			return c.json({ error: `unknown field: ${String(f.key)}` }, 400);
		}
	}
	// No duplicate keys.
	const keys = fields.map((f) => f.key as string);
	if (new Set(keys).size !== keys.length) {
		return c.json({ error: 'duplicate field keys' }, 400);
	}
	// Orders are unique.
	const orders = fields.map((f) => f.order);
	if (new Set(orders).size !== orders.length) {
		return c.json({ error: 'orders must be unique' }, 400);
	}
	// Required fields (title, status) are present and visible.
	for (const [key, def] of Object.entries(FIELD_REGISTRY)) {
		if (!def.required) continue;
		const f = fields.find((ff) => ff.key === key);
		if (!f || f.visible === false) {
			return c.json({ error: `${key} is required and must stay visible` }, 400);
		}
	}

	const layoutFields = [...fields]
		.sort((a, b) => Number(a.order) - Number(b.order))
		.map((f) => {
			const lf: Record<string, unknown> = { field: f.key };
			if (f.visible === false) lf.hidden = true;
			if (typeof f.label === 'string' && f.label.trim() !== '') lf.label = f.label;
			if (typeof f.section === 'string' && f.section.trim() !== '') lf.section = f.section;
			return lf;
		});

	const maxV = await c.env.DB.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM ui_layouts').first<{ v: number }>();
	const version = (maxV?.v ?? 0) + 1;
	await c.env.DB.batch([
		c.env.DB.prepare('UPDATE ui_layouts SET active = 0 WHERE active = 1'),
		c.env.DB.prepare('INSERT INTO ui_layouts (id, version, layout_json, created_by, created_at, active) VALUES (?, ?, ?, ?, ?, 1)').bind(
			crypto.randomUUID(),
			version,
			JSON.stringify({ fields: layoutFields }),
			user.id,
			Date.now(),
		),
	]);
	return c.json({ ok: true, version });
});

// ---- POST /admin/layout/revert ----
admin.post('/layout/revert', async (c) => {
	const current = await c.env.DB.prepare('SELECT version FROM ui_layouts WHERE active = 1 ORDER BY version DESC LIMIT 1').first<{ version: number }>();
	if (!current) {
		return c.json({ error: 'no active layout to revert' }, 400);
	}
	const prev = await c.env.DB.prepare('SELECT id FROM ui_layouts WHERE version < ? ORDER BY version DESC LIMIT 1').bind(current.version).first<{ id: string }>();
	if (prev) {
		await c.env.DB.batch([
			c.env.DB.prepare('UPDATE ui_layouts SET active = 0 WHERE active = 1'),
			c.env.DB.prepare('UPDATE ui_layouts SET active = 1 WHERE id = ?').bind(prev.id),
		]);
	} else {
		// No earlier version — revert to the built-in default by clearing the active
		// flag (loadActiveLayout then falls back to DEFAULT_LAYOUT).
		await c.env.DB.prepare('UPDATE ui_layouts SET active = 0 WHERE active = 1').run();
	}
	return c.json({ ok: true });
});

export default admin;
