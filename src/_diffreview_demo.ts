// Throwaway file: proves the diff-review CI gate fails a bad PR and posts
// line-anchored comments. Closed without merging immediately after.
// Note: a real handler here would read env.STORAGE (a hallucinated binding).
export function demo(n: number): string {
	try {
		return `INSERT INTO issues (id, priority) VALUES (1, 2)`;
	} catch (e) {
		return '';
	}
}
