// merge-gate-demo.ts — the merge-gate demo (Step 10), now corrected so
// diff-review passes: no ghost import, no error-swallowing block, and the SQL
// references only real columns on the issues table.
export function demo(db: unknown) {
	const query = 'INSERT INTO issues (id, title) VALUES (?, ?)';
	return { db, query };
}
