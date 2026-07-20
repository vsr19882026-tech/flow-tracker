// The field registry: the SINGLE source of truth for issue fields. Every field's
// type, whether it is required, and how to validate a submitted value live here.
// Validation reads ONLY from this registry — never from a ui_layouts row — so the
// presentation layout (order, hidden, labels) can never change what is accepted.

export type FieldType = 'text' | 'textarea' | 'select' | 'status' | 'readonly';

export type FieldDef = {
	type: FieldType;
	required: boolean;
	// Returns an error message for an invalid value, or null when it is acceptable.
	validate: (value: unknown) => string | null;
};

const STATUSES = ['open', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];

export const FIELD_REGISTRY: Record<string, FieldDef> = {
	title: {
		type: 'text',
		required: true,
		validate: (v) => (typeof v === 'string' && v.trim() !== '' ? null : 'title is required'),
	},
	status: {
		type: 'status',
		required: true,
		validate: (v) => (typeof v === 'string' && STATUSES.includes(v) ? null : "status must be one of 'open', 'in_progress', 'done'"),
	},
	description: {
		type: 'textarea',
		required: false,
		validate: (v) => (v === undefined || typeof v === 'string' ? null : 'description must be a string'),
	},
	project: {
		type: 'select',
		required: false,
		validate: (v) => (v === undefined || typeof v === 'string' ? null : 'project_id must be a string'),
	},
	sap_link: {
		type: 'readonly',
		required: false,
		validate: () => null,
	},
	priority: {
		type: 'select',
		required: false,
		validate: (v) => (typeof v === 'string' && PRIORITIES.includes(v) ? null : "priority must be one of 'low', 'medium', 'high'"),
	},
};
