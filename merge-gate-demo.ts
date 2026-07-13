// merge-gate-demo.ts — the merge-gate demo (Step 10), now with all three
// planted problems corrected so diff-review passes:
//   - dropped the ghost import (no package that isn't in package.json)
//   - dropped the try/catch (happy path only)
//   - the SQL references only real columns on the issues table
export function demo(db: unknown) {
	const query = 'INSERT INTO issues (id, title) VALUES (?, ?)';
	return { db, query };
}
