import { FIELD_REGISTRY } from './registry';

// Render issue fields from a layout. A layout is presentation only — field order,
// which fields are hidden, label overrides, and section grouping. The field's
// TYPE (from the registry) decides the markup. Under DEFAULT_LAYOUT the output is
// byte-for-byte the pre-refactor create form / detail panel.

export type RenderMode = 'create' | 'detail';
export type LayoutField = { field: string; hidden?: boolean; label?: string; section?: string };
export type Layout = { fields: LayoutField[] };
export type RenderContext = { projects?: { id: string; name: string }[]; canWrite?: boolean };

// The seeded default layout — the arrangement that reproduces today's screens.
// sap_link is present but hidden, so it doesn't appear until a layout unhides it.
export const DEFAULT_LAYOUT: Layout = {
	fields: [{ field: 'project' }, { field: 'title' }, { field: 'description' }, { field: 'status' }, { field: 'sap_link', hidden: true }],
};

function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Per-field UI metadata: default label and the element id used in each mode.
const FIELD_UI: Record<string, { label: string; createId?: string; detailId?: string }> = {
	title: { label: 'Title', createId: 'cTitle', detailId: 'pTitle' },
	description: { label: 'Description', createId: 'cDesc', detailId: 'pDesc' },
	project: { label: 'Project', createId: 'cProject' },
	status: { label: 'Status', detailId: 'pPills' },
	sap_link: { label: 'SAP case' },
	priority: { label: 'Priority', createId: 'cPriority' },
};

// Render one field for a mode, or null when the field has no rendering there
// (e.g. status isn't editable on the create form; project isn't shown in detail).
function renderField(fieldKey: string, mode: RenderMode, label: string, ctx: RenderContext): string | null {
	const def = FIELD_REGISTRY[fieldKey];
	if (!def) return null;
	const ui = FIELD_UI[fieldKey] ?? { label: fieldKey };

	if (mode === 'create') {
		if (def.type === 'text') {
			const req = def.required ? ' <span class="muted">(required)</span>' : '';
			return `<label for="${ui.createId}">${label}${req}</label>\n\t<input type="text" id="${ui.createId}" autocomplete="off">`;
		}
		if (def.type === 'textarea') {
			return `<label for="${ui.createId}">${label}</label>\n\t<textarea id="${ui.createId}" rows="4"></textarea>`;
		}
		if (def.type === 'select' && fieldKey === 'project') {
			const options = (ctx.projects ?? []).map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
			return `<label for="${ui.createId}">${label}</label>\n\t<select id="${ui.createId}"><option value="">(none)</option>${options}</select>`;
		}
		return null;
	}

	// detail mode
	if (def.type === 'text') return `<h2 id="${ui.detailId}"></h2>`;
	if (def.type === 'textarea') return `<div class="desc" id="${ui.detailId}"></div>`;
	if (def.type === 'status') {
		if (!ctx.canWrite) return '';
		return (
			`<div class="section"><h3>Status</h3><div class="pills" id="${ui.detailId}">` +
			'<button class="pill" data-for="open">To Do</button>' +
			'<button class="pill" data-for="in_progress">In Progress</button>' +
			'<button class="pill" data-for="done">Done</button></div></div>'
		);
	}
	return null;
}

// Iterate the layout order, skip hidden fields, apply label overrides and section
// grouping, and render each field via its registry type. Create fields are joined
// on newlines (matching the modal markup); detail fields are concatenated.
export function renderFields(layout: Layout, mode: RenderMode, ctx: RenderContext = {}): string {
	const sep = mode === 'create' ? '\n\t' : '';
	const out: string[] = [];
	let sectionName: string | null = null;
	let sectionParts: string[] = [];

	const flush = () => {
		if (sectionName !== null) {
			out.push(`<div class="section"><h3>${escapeHtml(sectionName)}</h3>${sectionParts.join(sep)}</div>`);
			sectionName = null;
			sectionParts = [];
		}
	};

	for (const lf of layout.fields) {
		if (lf.hidden) continue;
		const label = lf.label ?? FIELD_UI[lf.field]?.label ?? lf.field;
		const rendered = renderField(lf.field, mode, label, ctx);
		if (rendered === null) continue;
		if (lf.section) {
			if (lf.section !== sectionName) {
				flush();
				sectionName = lf.section;
			}
			sectionParts.push(rendered);
		} else {
			flush();
			out.push(rendered);
		}
	}
	flush();
	return out.join(sep);
}
