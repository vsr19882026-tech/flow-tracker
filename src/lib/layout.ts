// Shared HTML shell for the browser UI: a Jira-style navy top nav, the "+ Create"
// modal, and the design-token stylesheet used across every server-rendered page.
// Plain template strings (no JSX, no client framework) — interactivity is vanilla
// JS injected per page.

import { renderFields, DEFAULT_LAYOUT } from './layout/render';
import type { Layout } from './layout/render';

export type NavUser = { email: string; role: string };
export type ProjectOption = { id: string; name: string };

// Escape untrusted text before interpolating into HTML.
export function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Jira palette + shared component styles. Kept in one place so every page shares
// the same tokens.
const STYLES = `
:root {
	--nav: #172B4D; --blue: #0052CC; --page: #F4F5F7; --panel: #FFFFFF;
	--border: #DFE1E6; --text: #172B4D; --muted: #6B778C;
	--todo: #0052CC; --progress: #FFAB00; --done: #36B37E;
	--p-high: #FF5630; --p-medium: #FF8B00; --p-low: #6B778C;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--text);
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; }
a { color: var(--blue); text-decoration: none; }
a:hover { text-decoration: underline; }

.topnav { background: var(--nav); color: #fff; display: flex; align-items: center;
	justify-content: space-between; padding: 0 16px; height: 56px; }
.nav-left, .nav-right { display: flex; align-items: center; gap: 16px; }
.brand { color: #fff; font-weight: 700; font-size: 16px; }
.brand:hover { text-decoration: none; }
.nav-link { color: #DEEBFF; }
.nav-email { color: #B3BAC5; font-size: 13px; }

.btn { border: none; border-radius: 3px; padding: 6px 12px; font-size: 14px; font-weight: 500;
	cursor: pointer; font-family: inherit; }
.btn-primary { background: var(--blue); color: #fff; }
.btn-primary:hover { background: #0747A6; }
.btn-subtle { background: transparent; color: var(--muted); }
.btn-subtle:hover { background: rgba(9,30,66,0.06); }

main { padding: 24px; }

/* Board */
.board { display: flex; gap: 16px; align-items: flex-start; }
.column { background: #EBECF0; border-radius: 6px; width: 300px; flex: 0 0 300px; padding: 8px; }
.col-head { display: flex; align-items: center; justify-content: space-between;
	padding: 8px; border-top: 3px solid var(--muted); border-radius: 3px 3px 0 0; font-weight: 600; text-transform: uppercase; font-size: 12px; letter-spacing: .04em; }
.column[data-status="open"] .col-head { border-top-color: var(--todo); }
.column[data-status="in_progress"] .col-head { border-top-color: var(--progress); }
.column[data-status="done"] .col-head { border-top-color: var(--done); }
.count { background: rgba(9,30,66,0.08); color: var(--muted); border-radius: 10px; padding: 1px 8px; font-size: 12px; }
.cards { display: flex; flex-direction: column; gap: 8px; min-height: 24px; padding: 8px 4px; }

.card { background: var(--panel); border: 1px solid var(--border); border-radius: 4px; padding: 10px 12px;
	cursor: pointer; box-shadow: 0 1px 0 rgba(9,30,66,0.10); transition: box-shadow .12s ease; }
.card:hover { box-shadow: 0 3px 8px rgba(9,30,66,0.18); }
.card-title { margin: 0 0 8px; font-size: 14px; line-height: 1.3; }
.card-meta { display: flex; align-items: center; justify-content: space-between; }
.card-num { color: var(--muted); font-size: 12px; }

.badge { border-radius: 3px; padding: 1px 6px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: #fff; }
.badge.high { background: var(--p-high); }
.badge.medium { background: var(--p-medium); }
.badge.low { background: var(--p-low); color: #fff; }

/* Overlay + slide-in panel */
.overlay { position: fixed; inset: 0; background: rgba(9,30,66,0.54); opacity: 0; visibility: hidden;
	transition: opacity .2s ease, visibility .2s ease; z-index: 30; }
.overlay.open { opacity: 1; visibility: visible; }
.panel { position: fixed; top: 0; right: 0; height: 100%; width: 600px; max-width: 92vw; background: var(--panel);
	box-shadow: -4px 0 16px rgba(9,30,66,0.25); transform: translateX(100%); transition: transform .2s ease;
	z-index: 40; overflow-y: auto; padding: 20px 24px; }
.panel.open { transform: translateX(0); }
.panel-close { float: right; font-size: 20px; line-height: 1; }
.panel h2 { margin: 0 0 4px; font-size: 20px; }
.panel .desc { color: var(--text); white-space: pre-wrap; margin: 8px 0 20px; }
.section { border-top: 1px solid var(--border); padding-top: 16px; margin-top: 16px; }
.section h3 { font-size: 12px; text-transform: uppercase; color: var(--muted); letter-spacing: .04em; margin: 0 0 10px; }

.pills { display: flex; gap: 8px; }
.pill { border: 1px solid var(--border); background: #fff; color: var(--muted); border-radius: 16px;
	padding: 5px 14px; cursor: pointer; font-size: 13px; font-family: inherit; }
.pill[data-for="open"].active { background: var(--todo); border-color: var(--todo); color: #fff; }
.pill[data-for="in_progress"].active { background: var(--progress); border-color: var(--progress); color: #172B4D; }
.pill[data-for="done"].active { background: var(--done); border-color: var(--done); color: #fff; }

.att-row, .comment { display: flex; justify-content: space-between; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.att-row .sz, .comment .when { color: var(--muted); font-size: 12px; white-space: nowrap; }
.comment { display: block; }
.comment .body { white-space: pre-wrap; }
input[type=text], textarea, select { width: 100%; border: 1px solid var(--border); border-radius: 3px; padding: 8px;
	font-family: inherit; font-size: 14px; background: #FAFBFC; }
input[type=text]:focus, textarea:focus, select:focus { outline: none; border-color: var(--blue); background: #fff; }
label { display: block; font-size: 12px; color: var(--muted); margin: 12px 0 4px; font-weight: 600; }
.row-actions { margin-top: 10px; display: flex; gap: 8px; align-items: center; }
.muted { color: var(--muted); }

/* Modal (create) */
.modal-card { position: fixed; top: 10%; left: 50%; transform: translateX(-50%); width: 520px; max-width: 92vw;
	background: #fff; border-radius: 6px; padding: 20px 24px; z-index: 40; box-shadow: 0 8px 24px rgba(9,30,66,0.3); }
.modal-card h2 { margin: 0 0 8px; font-size: 18px; }
.hidden { display: none !important; }
.banner { padding: 10px 14px; border-radius: 3px; margin-bottom: 16px; }
.banner.ok { background: #E3FCEF; color: #006644; border: 1px solid #ABF5D1; }
.banner.err { background: #FFEBE6; color: #BF2600; border: 1px solid #FFBDAD; }
`;

// The "+ Create" modal markup. The field block (project/title/description) renders
// through the field registry under the default layout — byte-for-byte the prior
// hand-written markup.
function createModal(projects: ProjectOption[], activeLayout: Layout): string {
	return `
<div id="createOverlay" class="overlay"></div>
<div id="createModal" class="modal-card hidden" role="dialog" aria-modal="true">
	<h2>Create issue</h2>
	<div id="createErr" class="banner err hidden"></div>
	${renderFields(activeLayout, 'create', { projects })}
	<div class="row-actions" style="justify-content:flex-end;margin-top:16px">
		<button class="btn btn-subtle" id="cCancel">Cancel</button>
		<button class="btn btn-primary" id="cSubmit">Create</button>
	</div>
</div>`;
}

// Nav-level script: sign-out, and (when allowed) the create modal.
function navScript(canCreate: boolean): string {
	return `
document.getElementById('signOut').addEventListener('click', async (e) => {
	e.preventDefault();
	await fetch('/auth/sign-out', { method: 'POST' });
	location.href = '/sign-in';
});
${
	canCreate
		? `
(function () {
	const overlay = document.getElementById('createOverlay');
	const modal = document.getElementById('createModal');
	const err = document.getElementById('createErr');
	function open() { overlay.classList.add('open'); modal.classList.remove('hidden'); document.getElementById('cTitle').focus(); }
	function close() { overlay.classList.remove('open'); modal.classList.add('hidden'); err.classList.add('hidden'); }
	document.getElementById('createBtn').addEventListener('click', open);
	document.getElementById('cCancel').addEventListener('click', close);
	overlay.addEventListener('click', close);
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) close(); });
	document.getElementById('cSubmit').addEventListener('click', async () => {
		const title = document.getElementById('cTitle').value.trim();
		if (!title) { err.textContent = 'Title is required'; err.classList.remove('hidden'); return; }
		const project_id = document.getElementById('cProject').value || undefined;
		const description = document.getElementById('cDesc').value;
		const res = await fetch('/issues', { method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ title, description, project_id }) });
		if (res.ok) { location.reload(); }
		else { const b = await res.json().then((v) => v, () => ({})); err.textContent = b.error || 'Could not create issue'; err.classList.remove('hidden'); }
	});
})();`
		: ''
}`;
}

// Render a full authenticated page: nav + body + optional per-page script.
export function layout(opts: { title: string; user: NavUser; projects?: ProjectOption[]; activeLayout?: Layout; body: string; script?: string }): string {
	const canCreate = opts.user.role !== 'viewer';
	const isAdmin = opts.user.role === 'admin';
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${escapeHtml(opts.title)}</title>
	<style>${STYLES}</style>
</head>
<body>
	<nav class="topnav">
		<div class="nav-left">
			<a class="brand" href="/board">Flow Tracker</a>
			${canCreate ? '<button id="createBtn" class="btn btn-primary">+ Create</button>' : ''}
		</div>
		<div class="nav-right">
			${isAdmin ? '<a class="nav-link" href="/admin/users">Admin</a>' : ''}
			<span class="nav-email">${escapeHtml(opts.user.email)}</span>
			<a class="nav-link" id="signOut" href="#">Sign out</a>
		</div>
	</nav>
	<main>${opts.body}</main>
	${canCreate ? createModal(opts.projects ?? [], opts.activeLayout ?? DEFAULT_LAYOUT) : ''}
	<script>${navScript(canCreate)}</script>
	${opts.script ? `<script>${opts.script}</script>` : ''}
</body>
</html>`;
}
