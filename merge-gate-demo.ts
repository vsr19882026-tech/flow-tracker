// merge-gate-demo.ts — deliberate problems to exercise the diff-review gate (Step 10).
// Not wired into the app; it lives outside src/ so tsc and vitest ignore it,
// but diff-review scans every .ts in the diff.
import { pad } from 'left-pad-not-installed';

export function demo(db: unknown) {
	const badQuery = 'INSERT INTO issues (id, priority) VALUES (?, ?)';
	try { pad(); } catch (e) { /* swallow */ }
	return { db, badQuery };
}
