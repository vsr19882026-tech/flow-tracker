import { DEFAULT_LAYOUT } from './render';
import type { Layout, LayoutField } from './render';

// Load the active ui_layouts version as a Layout for renderFields. Falls back to
// the built-in default when no layout has been saved (or a row is unreadable).
export async function loadActiveLayout(db: D1Database): Promise<Layout> {
	const row = await db.prepare('SELECT layout_json FROM ui_layouts WHERE active = 1 ORDER BY version DESC LIMIT 1').first<{ layout_json: string }>();
	if (!row) return DEFAULT_LAYOUT;
	const parsed = await Promise.resolve()
		.then(() => JSON.parse(row.layout_json) as { fields?: LayoutField[] })
		.then(
			(v) => v,
			() => null,
		);
	if (!parsed || !Array.isArray(parsed.fields)) return DEFAULT_LAYOUT;
	return { fields: parsed.fields };
}
