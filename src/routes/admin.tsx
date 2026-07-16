import { Hono } from 'hono';
import type { FC, Child } from 'hono/jsx';
import { requireAdmin, isValidUserRole, USER_ROLES } from '../lib/authz';
import type { AuthUser } from '../lib/authz';
import { parseInviteEmails } from '../lib/invites';

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
type InviteRow = { email: string; invited_by_email: string; created_at: number };

admin.get('/invites', async (c) => {
	const { results: invites } = await c.env.DB.prepare(
		`SELECT i.email, i.created_at, u.email AS invited_by_email
		   FROM invites i
		   JOIN "user" u ON u.id = i.invited_by
		  ORDER BY i.created_at DESC`,
	).all<InviteRow>();

	return c.html(
		<Layout title="Invites">
			<div class="grid gap-8 md:grid-cols-[1fr_20rem]">
				<div>
					<h2 class="mb-4 text-base font-semibold">{invites.length} pending invites</h2>
					<div class="overflow-x-auto rounded-lg border border-slate-200 bg-white">
						<table class="min-w-full divide-y divide-slate-200">
							<thead class="bg-slate-50">
								<tr>
									<Th>Email</Th>
									<Th>Invited by</Th>
									<Th>Created</Th>
								</tr>
							</thead>
							<tbody class="divide-y divide-slate-100">
								{invites.length === 0 ? (
									<tr>
										<td colspan={3} class="px-3 py-6 text-center text-sm text-slate-400">
											No pending invites.
										</td>
									</tr>
								) : (
									invites.map((i) => (
										<tr>
											<Td>{i.email}</Td>
											<Td>{i.invited_by_email}</Td>
											<Td>{new Date(i.created_at).toISOString().slice(0, 10)}</Td>
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

export default admin;
