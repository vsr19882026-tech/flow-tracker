import { Hono } from 'hono';
import { layout, escapeHtml } from '../lib/layout';
import type { ProjectOption } from '../lib/layout';
import { renderFields, DEFAULT_LAYOUT } from '../lib/layout/render';

// Server-rendered browser UI: a sign-in page and a Jira-style board. No client
// framework — interactivity is vanilla JS injected as a page script. All data is
// fetched from the same-origin JSON API the curl users already use, so the
// session cookie is sent automatically.

type Variables = { user: { id: string; email: string; role: string } | null };
const ui = new Hono<{ Bindings: Env; Variables: Variables }>();

const COLUMNS = [
	{ key: 'open', label: 'To Do' },
	{ key: 'in_progress', label: 'In Progress' },
	{ key: 'done', label: 'Done' },
];

type IssueRow = { issue_number: number; title: string; status: string; priority?: string | null };

function priorityOf(p: unknown): string {
	return p === 'high' || p === 'low' ? p : 'medium';
}

// One board card (server-rendered). Client JS moves these between columns.
function cardHtml(issue: IssueRow): string {
	const pr = priorityOf(issue.priority);
	return (
		`<div class="card" data-number="${escapeHtml(issue.issue_number)}" data-status="${escapeHtml(issue.status)}">` +
		`<p class="card-title">${escapeHtml(issue.title)}</p>` +
		`<div class="card-meta"><span class="card-num">#${escapeHtml(issue.issue_number)}</span>` +
		`<span class="badge ${pr}">${pr}</span></div></div>`
	);
}

// ---- GET /sign-in ----
ui.get('/sign-in', (c) => {
	const sent = c.req.query('sent') === '1';
	const banner = sent ? '<div class="banner ok">Check your inbox — a magic link is on its way.</div>' : '';
	return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Sign in · Flow Tracker</title>
	<style>
		:root { --nav:#172B4D; --blue:#0052CC; --page:#F4F5F7; --border:#DFE1E6; --text:#172B4D; --muted:#6B778C; }
		* { box-sizing:border-box; }
		body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:var(--page);
			color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; font-size:14px; }
		.card { background:#fff; border:1px solid var(--border); border-radius:6px; padding:32px; width:400px; max-width:92vw;
			box-shadow:0 1px 4px rgba(9,30,66,0.12); }
		h1 { color:var(--nav); font-size:20px; margin:0 0 4px; }
		p.sub { color:var(--muted); margin:0 0 20px; }
		label { display:block; font-size:12px; color:var(--muted); font-weight:600; margin-bottom:4px; }
		input { width:100%; border:1px solid var(--border); border-radius:3px; padding:10px; font-size:14px; background:#FAFBFC; font-family:inherit; }
		input:focus { outline:none; border-color:var(--blue); background:#fff; }
		button { width:100%; margin-top:16px; border:none; border-radius:3px; background:var(--blue); color:#fff;
			padding:10px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit; }
		button:hover { background:#0747A6; }
		.banner { padding:10px 14px; border-radius:3px; margin-bottom:16px; }
		.banner.ok { background:#E3FCEF; color:#006644; border:1px solid #ABF5D1; }
		.banner.err { background:#FFEBE6; color:#BF2600; border:1px solid #FFBDAD; }
		.hidden { display:none; }
	</style>
</head>
<body>
	<div class="card">
		<h1>Flow Tracker</h1>
		<p class="sub">Sign in with your work email.</p>
		${banner}
		<div id="siErr" class="banner err hidden"></div>
		<form id="siForm">
			<label for="siEmail">Email</label>
			<input type="email" id="siEmail" autocomplete="email" required placeholder="you@company.com">
			<button type="submit">Send magic link</button>
		</form>
	</div>
	<script>
		document.getElementById('siForm').addEventListener('submit', async function (e) {
			e.preventDefault();
			var email = document.getElementById('siEmail').value.trim();
			var err = document.getElementById('siErr');
			err.classList.add('hidden');
			var res = await fetch('/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email }) });
			if (res.ok) { location.href = '/sign-in?sent=1'; }
			else { var b = await res.json().then(function (v) { return v; }, function () { return {}; }); err.textContent = b.error || 'Could not send magic link'; err.classList.remove('hidden'); }
		});
	</script>
</body>
</html>`);
});

// ---- GET /board ----
ui.get('/board', async (c) => {
	const user = c.get('user');
	if (!user) {
		return c.redirect('/sign-in');
	}

	const { results } = await c.env.DB.prepare('SELECT * FROM issues ORDER BY issue_number DESC').all<IssueRow>();
	const { results: projects } = await c.env.DB.prepare('SELECT id, name FROM projects WHERE owner_id = ? ORDER BY created_at DESC')
		.bind(user.id)
		.all<ProjectOption>();

	const columns = COLUMNS.map((col) => {
		const list = results.filter((i) => i.status === col.key);
		return (
			`<div class="column" data-status="${col.key}">` +
			`<div class="col-head"><span>${col.label}</span><span class="count">${list.length}</span></div>` +
			`<div class="cards" data-status="${col.key}">${list.map(cardHtml).join('')}</div></div>`
		);
	}).join('');

	const body =
		`<div class="board">${columns}</div>` +
		`<div id="panelOverlay" class="overlay"></div>` +
		`<aside id="panel" class="panel" aria-hidden="true"></aside>`;

	return c.html(layout({ title: 'Board · Flow Tracker', user, projects, body, script: boardScript(user.role) }));
});

// Vanilla-JS board behaviour: slide-in detail panel, status pills, attachments,
// comments, and deep-linking via ?issue=N. Written without backticks or ${} so it
// embeds cleanly in this template literal; the only server value is ROLE.
function boardScript(role: string): string {
	return `
var ROLE = ${JSON.stringify(role)};
var CAN_WRITE = ROLE !== 'viewer';
var overlay = document.getElementById('panelOverlay');
var panel = document.getElementById('panel');
var curNum = null, curStatus = null;

function fmtSize(n){ if(n>=1048576) return (n/1048576).toFixed(1)+' MB'; if(n>=1024) return (n/1024).toFixed(1)+' KB'; return n+' B'; }
function fmtWhen(v){ var ms = typeof v === 'number' ? v : Date.parse(v); return new Date(ms).toLocaleString(); }

var SKELETON =
	'<a href="#" class="panel-close" id="pClose">\\u00d7</a>' +
	'<div class="card-num" id="pNum"></div>' +
	${JSON.stringify(renderFields(DEFAULT_LAYOUT, 'detail', { canWrite: role !== 'viewer' }))} +
	'<div class="section"><h3>Attachments</h3><div id="pAtts"></div>' +
	(CAN_WRITE ? '<div class="row-actions"><input type="file" id="pFile"><button class="btn btn-subtle" id="pAttach">Attach file</button><span class="muted" id="pProg"></span></div>' : '') +
	'</div>' +
	'<div class="section"><h3>Comments</h3><div id="pComments"></div>' +
	(CAN_WRITE ? '<form id="pCForm"><textarea id="pCBody" rows="3" placeholder="Add a comment"></textarea><div style="margin-top:8px"><button class="btn btn-primary" type="submit">Comment</button></div></form>' : '') +
	'</div>';

function openPanel(number){
	curNum = number;
	overlay.classList.add('open');
	panel.classList.add('open');
	panel.setAttribute('aria-hidden','false');
	history.replaceState(null, '', '/board?issue=' + number);
	panel.innerHTML = '<div class="muted">Loading…</div>';
	fetch('/issues/' + number).then(function(r){ return r.ok ? r.json() : null; }).then(function(issue){ if(issue) renderPanel(issue); else panel.innerHTML = '<div class="muted">Could not load issue.</div>'; });
}
function closePanel(){
	overlay.classList.remove('open');
	panel.classList.remove('open');
	panel.setAttribute('aria-hidden','true');
	curNum = null;
	history.replaceState(null, '', '/board');
}

function moveCard(number, target){
	var card = document.querySelector('.card[data-number="' + number + '"]');
	if(!card) return;
	card.setAttribute('data-status', target);
	document.querySelector('.cards[data-status="' + target + '"]').appendChild(card);
	document.querySelectorAll('.column').forEach(function(col){ col.querySelector('.count').textContent = col.querySelectorAll('.card').length; });
}

function attRow(number, a){
	var row = document.createElement('div'); row.className = 'att-row';
	var link = document.createElement('a'); link.href = '#'; link.textContent = a.filename;
	link.addEventListener('click', function(e){ e.preventDefault();
		fetch('/issues/' + number + '/attachments/' + a.id).then(function(r){ return r.json(); }).then(function(d){ if(d && d.url) window.open(d.url, '_blank'); });
	});
	var sz = document.createElement('span'); sz.className = 'sz'; sz.textContent = fmtSize(a.size);
	row.appendChild(link); row.appendChild(sz); return row;
}
function loadAttachments(number){
	fetch('/issues/' + number + '/attachments').then(function(r){ return r.json(); }).then(function(list){
		var box = document.getElementById('pAtts'); box.innerHTML = '';
		if(!Array.isArray(list) || list.length === 0){ box.innerHTML = '<div class="muted">No attachments</div>'; return; }
		list.forEach(function(a){ box.appendChild(attRow(number, a)); });
	});
}
function setupUpload(number){
	var fileInput = document.getElementById('pFile'), btn = document.getElementById('pAttach'), prog = document.getElementById('pProg');
	btn.addEventListener('click', function(){
		var f = fileInput.files && fileInput.files[0];
		if(!f){ prog.textContent = 'Choose a file first'; return; }
		prog.textContent = '0%';
		fetch('/issues/' + number + '/attachments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filename: f.name, mime: f.type, size: f.size }) })
			.then(function(r){ if(!r.ok) return r.json().then(function(b){ throw new Error(b.error || 'Upload rejected'); }); return r.json(); })
			.then(function(pre){
				var xhr = new XMLHttpRequest();
				xhr.open('PUT', pre.url, true);
				if(f.type) xhr.setRequestHeader('Content-Type', f.type);
				xhr.upload.onprogress = function(e){ if(e.lengthComputable) prog.textContent = Math.round(e.loaded / e.total * 100) + '%'; };
				xhr.onload = function(){
					if(xhr.status === 200){
						prog.textContent = 'Saving…';
						fetch('/issues/' + number + '/attachments/' + pre.id + '/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ r2_key: pre.r2_key, filename: f.name, mime: f.type, size: f.size }) })
							.then(function(r){ return r.json(); }).then(function(){ prog.textContent = ''; fileInput.value = ''; loadAttachments(number); });
					} else { prog.textContent = 'Upload failed (' + xhr.status + ')'; }
				};
				xhr.onerror = function(){ prog.textContent = 'Upload error'; };
				xhr.send(f);
			}, function(err){ prog.textContent = err.message || 'Upload failed'; });
	});
}

function appendComment(box, c){
	var ph = box.querySelector('.muted'); if(ph) box.innerHTML = '';
	var div = document.createElement('div'); div.className = 'comment';
	var b = document.createElement('div'); b.className = 'body'; b.textContent = c.body;
	var w = document.createElement('div'); w.className = 'when'; w.textContent = fmtWhen(c.created_at);
	div.appendChild(b); div.appendChild(w); box.appendChild(div);
}
function renderComments(list){
	var box = document.getElementById('pComments'); box.innerHTML = '';
	if(!list || list.length === 0){ box.innerHTML = '<div class="muted">No comments yet</div>'; return; }
	list.forEach(function(c){ appendComment(box, c); });
}
function setupComment(number){
	document.getElementById('pCForm').addEventListener('submit', function(e){ e.preventDefault();
		var ta = document.getElementById('pCBody'); var body = ta.value.trim(); if(!body) return;
		fetch('/issues/' + number + '/comments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: body }) })
			.then(function(r){ return r.ok ? r.json() : null; }).then(function(row){ if(!row) return; appendComment(document.getElementById('pComments'), row); ta.value = ''; });
	});
}

function renderPanel(issue){
	curStatus = issue.status;
	panel.innerHTML = SKELETON;
	panel.querySelector('#pClose').addEventListener('click', function(e){ e.preventDefault(); closePanel(); });
	document.getElementById('pNum').textContent = '#' + issue.issue_number;
	document.getElementById('pTitle').textContent = issue.title;
	document.getElementById('pDesc').textContent = issue.description || 'No description.';
	if(CAN_WRITE){
		var pills = panel.querySelectorAll('#pPills .pill');
		pills.forEach(function(p){
			if(p.getAttribute('data-for') === curStatus) p.classList.add('active');
			p.addEventListener('click', function(){
				var target = p.getAttribute('data-for');
				if(target === curStatus) return;
				fetch('/issues/' + issue.issue_number, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: target }) })
					.then(function(r){ if(!r.ok){ alert('Could not update status'); return null; } return r.json(); })
					.then(function(row){ if(!row) return; curStatus = target;
						pills.forEach(function(q){ q.classList.toggle('active', q.getAttribute('data-for') === target); });
						moveCard(issue.issue_number, target); });
			});
		});
		setupUpload(issue.issue_number);
		setupComment(issue.issue_number);
	}
	loadAttachments(issue.issue_number);
	renderComments(issue.comments || []);
}

document.querySelector('.board').addEventListener('click', function(e){
	var card = e.target.closest('.card'); if(!card) return;
	openPanel(Number(card.getAttribute('data-number')));
});
overlay.addEventListener('click', closePanel);
document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && panel.classList.contains('open')) closePanel(); });

var q = new URLSearchParams(location.search).get('issue');
if(q) openPanel(Number(q));
`;
}

export default ui;
