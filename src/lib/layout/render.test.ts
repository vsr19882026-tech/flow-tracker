import { describe, it, expect } from 'vitest';
import { renderFields, DEFAULT_LAYOUT } from './render';

// renderFields must reproduce the pre-refactor markup byte-for-byte under the
// default layout, and honor order / hidden / label overrides.

const CREATE_FIELDS =
	'<label for="cProject">Project</label>\n\t' +
	'<select id="cProject"><option value="">(none)</option></select>\n\t' +
	'<label for="cTitle">Title <span class="muted">(required)</span></label>\n\t' +
	'<input type="text" id="cTitle" autocomplete="off">\n\t' +
	'<label for="cDesc">Description</label>\n\t' +
	'<textarea id="cDesc" rows="4"></textarea>';

const DETAIL_FIELDS_WRITE =
	'<h2 id="pTitle"></h2>' +
	'<div class="desc" id="pDesc"></div>' +
	'<div class="section"><h3>Status</h3><div class="pills" id="pPills">' +
	'<button class="pill" data-for="open">To Do</button>' +
	'<button class="pill" data-for="in_progress">In Progress</button>' +
	'<button class="pill" data-for="done">Done</button></div></div>';

describe('renderFields', () => {
	it('1. renders the default create form fields in the same order as before', () => {
		const html = renderFields(DEFAULT_LAYOUT, 'create', { projects: [] });
		// Same fields, same order: project, then title, then description.
		expect(html.indexOf('cProject')).toBeLessThan(html.indexOf('cTitle'));
		expect(html.indexOf('cTitle')).toBeLessThan(html.indexOf('cDesc'));
		// Byte-for-byte with the pre-refactor modal field block.
		expect(html).toBe(CREATE_FIELDS);
	});

	it('renders the default detail fields byte-for-byte (writer sees status pills)', () => {
		expect(renderFields(DEFAULT_LAYOUT, 'detail', { canWrite: true })).toBe(DETAIL_FIELDS_WRITE);
	});

	it('omits the status pills for a viewer in detail mode', () => {
		expect(renderFields(DEFAULT_LAYOUT, 'detail', { canWrite: false })).toBe('<h2 id="pTitle"></h2><div class="desc" id="pDesc"></div>');
	});

	it('skips hidden fields and applies label overrides', () => {
		const layout = { fields: [{ field: 'title', label: 'Summary' }, { field: 'description', hidden: true }] };
		const html = renderFields(layout, 'create');
		expect(html).toContain('<label for="cTitle">Summary <span class="muted">(required)</span></label>');
		expect(html).not.toContain('cDesc');
	});
});
