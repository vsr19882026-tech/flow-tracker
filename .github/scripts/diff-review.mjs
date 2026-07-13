#!/usr/bin/env node
// diff-review — static review of a unified diff for flow-tracker.
//
// Runs five checks over the ADDED lines of a diff and reports pass/fail with
// line-anchored findings. Shared by the `diff-review` sub-agent (run manually
// before /ship) and the diff-review GitHub Action (run on every PR), so the
// verdict is identical in both places and reproducible on a clean machine —
// no MCP server, no network, no non-Node dependency.
//
// Checks:
//   1. ghost-import       imported module/symbol must resolve (local file or dep)
//   2. schema-drift       INSERT/UPDATE columns must exist in the migrations
//   3. better-auth        no `auth.session` outside middleware; no unguarded `auth.user`
//   4. hallucinated-binding  every `env.X` must be declared in wrangler.toml (or a known secret)
//   5. forbidden-pattern  no try/catch, `--no-verify`, or `git push --force`
//
// Usage:
//   node .github/scripts/diff-review.mjs --diff pr.diff [--json out.json] [--root .]
//   git diff origin/main...HEAD | node .github/scripts/diff-review.mjs
//
// Reads the diff from --diff <path> or stdin. Reads repo context (wrangler.toml,
// migrations/, package.json, imported files) from --root (default: cwd).
// Exit 0 = PASS (no findings), exit 1 = FAIL (one or more findings).
//
// This script deliberately uses no try/catch — it codes the happy path and lets
// errors throw, so it satisfies its own forbidden-pattern rule.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Worker secrets are supplied via `wrangler secret put`, not wrangler.toml, so
// they can never be discovered from config. List the known ones here; add a
// line whenever a new secret is introduced.
const KNOWN_SECRETS = ['BETTER_AUTH_SECRET'];

// Node builtins and Cloudflare virtual modules are always importable.
const NODE_BUILTINS = new Set([
	'assert', 'buffer', 'child_process', 'cluster', 'console', 'crypto', 'dns',
	'events', 'fs', 'http', 'https', 'net', 'os', 'path', 'process', 'querystring',
	'readline', 'stream', 'string_decoder', 'timers', 'tls', 'url', 'util', 'zlib',
]);

// The one file allowed to read `auth.session` — the session middleware lives here.
const MIDDLEWARE_FILE = 'src/index.ts';

const CODE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

// Files the reviewer does not review. A linter should not lint its own rule
// definitions: this script encodes every forbidden token as data, and the
// Markdown docs/agent/command files describe the rules in prose. Reviewing them
// would flag the rulebook itself. Everything else — .ts source, .sh/.yml
// scripts, other .mjs — is still fully checked.
const SKIP_FILES = new Set(['.github/scripts/diff-review.mjs']);
function skipFile(file) {
	// .d.ts is generated (e.g. worker-configuration.d.ts) — not hand-written source.
	return SKIP_FILES.has(file) || file.endsWith('.md') || file.endsWith('.d.ts');
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(flag) {
	const i = argv.indexOf(flag);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const root = resolve(argValue('--root') ?? '.');
const diffPath = argValue('--diff');
const jsonPath = argValue('--json');

const diffText = diffPath ? readFileSync(diffPath, 'utf8') : readFileSync(0, 'utf8');

// ---------------------------------------------------------------------------
// Parse the unified diff into per-file added lines with new-file line numbers.
// ---------------------------------------------------------------------------

function parseDiff(text) {
	const files = new Map(); // path -> [{ line, text }]
	let current = null;
	let newLine = 0;
	for (const raw of text.split('\n')) {
		if (raw.startsWith('+++ ')) {
			const p = raw.slice(4).trim();
			current = p === '/dev/null' ? null : p.replace(/^[ab]\//, '');
			if (current && !files.has(current)) files.set(current, []);
			continue;
		}
		if (raw.startsWith('--- ') || raw.startsWith('diff ') || raw.startsWith('index ')) {
			continue;
		}
		const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk) {
			newLine = Number(hunk[1]);
			continue;
		}
		if (!current) continue;
		if (raw.startsWith('+')) {
			files.get(current).push({ line: newLine, text: raw.slice(1) });
			newLine++;
		} else if (raw.startsWith('-') || raw.startsWith('\\')) {
			// removed line / "\ No newline" marker — new-file line does not advance
		} else {
			// context line (leading space, or an empty line inside a hunk)
			newLine++;
		}
	}
	return files;
}

const added = parseDiff(diffText);

// ---------------------------------------------------------------------------
// Repo context
// ---------------------------------------------------------------------------

function readRepo(rel) {
	const p = join(root, rel);
	return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// package.json dependency names.
const pkgRaw = readRepo('package.json');
const pkgDeps = new Set();
if (pkgRaw) {
	const pkg = JSON.parse(pkgRaw);
	for (const k of Object.keys(pkg.dependencies ?? {})) pkgDeps.add(k);
	for (const k of Object.keys(pkg.devDependencies ?? {})) pkgDeps.add(k);
}

// wrangler.toml bindings + vars → the set of legal `env.X` names.
const wranglerRaw = readRepo('wrangler.toml') ?? '';
const bindingNames = new Set(KNOWN_SECRETS);
for (const m of wranglerRaw.matchAll(/^\s*binding\s*=\s*"([^"]+)"/gm)) bindingNames.add(m[1]);
// send_email uses `name = "..."` inside its array; capture those too.
for (const block of wranglerRaw.matchAll(/send_email\s*=\s*\[([\s\S]*?)\]/g)) {
	for (const m of block[1].matchAll(/name\s*=\s*"([^"]+)"/g)) bindingNames.add(m[1]);
}
// [vars] section keys.
const varsSection = wranglerRaw.match(/\[vars\]([\s\S]*?)(?:\n\[|$)/);
if (varsSection) {
	for (const m of varsSection[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) bindingNames.add(m[1]);
}

// D1 schema: table -> Set(columns), parsed from every migration file.
const schema = new Map();
const migDir = join(root, 'migrations');
if (existsSync(migDir)) {
	const { readdirSync } = await import('node:fs');
	const sql = readdirSync(migDir)
		.filter((f) => f.endsWith('.sql'))
		.sort()
		.map((f) => readFileSync(join(migDir, f), 'utf8'))
		.join('\n')
		// Strip SQL comments first, or prose like "CREATE TABLE time (FK ...)" in a
		// comment gets parsed as a real table.
		.replace(/--[^\n]*/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '');
	for (const t of sql.matchAll(/CREATE\s+TABLE\s+"?(\w+)"?\s*\(([\s\S]*?)\)\s*;/gi)) {
		const table = t[1];
		const cols = new Set();
		for (const line of t[2].split('\n')) {
			const col = line.trim().match(/^"?(\w+)"?\s+(?:TEXT|INTEGER|REAL|BLOB|NUMERIC)/i);
			if (col) cols.add(col[1]);
		}
		schema.set(table, cols);
	}
	for (const a of sql.matchAll(/ALTER\s+TABLE\s+"?(\w+)"?\s+ADD\s+(?:COLUMN\s+)?"?(\w+)"?/gi)) {
		if (schema.has(a[1])) schema.get(a[1]).add(a[2]);
	}
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const findings = [];
function report(file, line, rule, message) {
	findings.push({ file, line, rule, message });
}

// -- Check 1: ghost imports --------------------------------------------------
function checkGhostImports(file, line, text) {
	if (!CODE_EXT.test(file)) return;
	const m = text.match(/^\s*import\s+(?:type\s+)?(.+?)\s+from\s+['"]([^'"]+)['"]/) ||
		text.match(/^\s*import\s+['"]([^'"]+)['"]/);
	if (!m) return;
	const spec = m.length === 3 ? m[2] : m[1];
	const clause = m.length === 3 ? m[1] : '';

	if (spec.startsWith('.')) {
		const base = resolve(join(root, dirname(file)), spec);
		const candidates = [
			base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`,
			`${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
			join(base, 'index.ts'), join(base, 'index.js'), join(base, 'index.mjs'),
		];
		const hit = candidates.find((c) => existsSync(c));
		if (!hit) {
			report(file, line, 'ghost-import', `cannot resolve local module '${spec}'`);
			return;
		}
		verifyNamedExports(file, line, spec, clause, readFileSync(hit, 'utf8'));
		return;
	}

	// Bare specifier → top-level package name (handle @scope/name).
	const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
	if (spec.startsWith('node:') || NODE_BUILTINS.has(pkg) || spec.startsWith('cloudflare:')) return;
	if (!pkgDeps.has(pkg)) {
		report(file, line, 'ghost-import', `package '${pkg}' is not in package.json dependencies`);
	}
}

function verifyNamedExports(file, line, spec, clause, target) {
	// Re-exports we cannot follow statically → do not risk a false positive.
	if (/export\s+\*/.test(target)) return;
	const names = [];
	const braces = clause.match(/\{([^}]*)\}/);
	if (braces) {
		for (const part of braces[1].split(',')) {
			const name = part.trim().split(/\s+as\s+/)[0].trim();
			if (name) names.push({ name, kind: 'named' });
		}
	}
	const defaultName = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+\w+/, '').replace(/,/g, '').trim();
	if (defaultName && !defaultName.startsWith('{')) names.push({ name: defaultName, kind: 'default' });

	for (const { name, kind } of names) {
		if (kind === 'default') {
			if (!/export\s+default/.test(target) && !/as\s+default/.test(target)) {
				report(file, line, 'ghost-import', `'${spec}' has no default export`);
			}
			continue;
		}
		const exported =
			new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var|class|type|interface|enum)\\s+${name}\\b`).test(target) ||
			new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(target) ||
			new RegExp(`\\bas\\s+${name}\\b`).test(target);
		if (!exported) {
			report(file, line, 'ghost-import', `'${name}' is not exported by '${spec}'`);
		}
	}
}

// -- Check 2: D1 schema drift ------------------------------------------------
function checkSchemaDrift(file, line, text) {
	for (const ins of text.matchAll(/INSERT\s+INTO\s+"?(\w+)"?\s*\(([^)]*)\)/gi)) {
		const table = ins[1];
		if (!schema.has(table)) continue;
		for (const col of ins[2].split(',')) {
			const name = col.trim().replace(/"/g, '');
			if (name && !schema.get(table).has(name)) {
				report(file, line, 'schema-drift', `column '${name}' does not exist on table '${table}'`);
			}
		}
	}
	for (const upd of text.matchAll(/UPDATE\s+"?(\w+)"?\s+SET\s+(.+)/gi)) {
		const table = upd[1];
		if (!schema.has(table)) continue;
		for (const assign of upd[2].split(',')) {
			const name = assign.trim().match(/^"?(\w+)"?\s*=/);
			if (name && !schema.get(table).has(name[1])) {
				report(file, line, 'schema-drift', `column '${name[1]}' does not exist on table '${table}'`);
			}
		}
	}
}

// -- Check 3: Better Auth misuse ---------------------------------------------
function checkBetterAuth(file, line, text) {
	// Require `auth` to not be preceded by a word char, dot, or hyphen, so the
	// Better Auth cookie name (`better-auth.session`) and member accesses like
	// `x.auth.session` don't false-positive — only a standalone `auth.session`.
	if (/(?<![\w.-])auth\.session\b/.test(text) && file !== MIDDLEWARE_FILE) {
		report(file, line, 'better-auth', 'reads `auth.session` outside the session middleware (src/index.ts)');
	}
	// `auth.user` accessed without a null guard on the same line. Optional
	// chaining (auth.user?.x), a `!auth.user` guard, or an `auth.user &&` /
	// `auth.user ?` guard all count as guarded.
	for (const _ of text.matchAll(/(?<![\w.-])auth\.user\b(?!\?\.)/g)) {
		const guarded = /!auth\.user\b/.test(text) || /\bauth\.user\s*(?:&&|\?|===?|!==?)/.test(text);
		if (!guarded) {
			report(file, line, 'better-auth', 'accesses `auth.user` without a null check');
		}
		break; // one finding per line is enough
	}
}

// -- Check 4: hallucinated Wrangler bindings ---------------------------------
function checkBindings(file, line, text) {
	if (!CODE_EXT.test(file)) return;
	for (const m of text.matchAll(/(?<!process\.)\benv\.([A-Z][A-Z0-9_]*)\b/g)) {
		const name = m[1];
		if (!bindingNames.has(name)) {
			report(file, line, 'hallucinated-binding', `env.${name} is not a binding declared in wrangler.toml`);
		}
	}
}

// -- Check 5: forbidden patterns ---------------------------------------------
function checkForbidden(file, line, text) {
	if (/\btry\s*\{/.test(text) || /\}\s*catch\b/.test(text) || /\bcatch\s*[({]/.test(text)) {
		report(file, line, 'forbidden-pattern', 'try/catch is banned — code the happy path and let errors throw');
	}
	if (/--no-verify\b/.test(text)) {
		report(file, line, 'forbidden-pattern', '`--no-verify` bypasses git hooks and is forbidden');
	}
	if (/git\s+push\s+(?:.*\s)?(?:--force\b|-f\b|--force-with-lease\b)/.test(text)) {
		report(file, line, 'forbidden-pattern', '`git push --force` is forbidden');
	}
}

// ---------------------------------------------------------------------------
// Run every check over every added line.
// ---------------------------------------------------------------------------

for (const [file, lines] of added) {
	if (skipFile(file)) continue;
	for (const { line, text } of lines) {
		checkGhostImports(file, line, text);
		checkSchemaDrift(file, line, text);
		checkBetterAuth(file, line, text);
		checkBindings(file, line, text);
		checkForbidden(file, line, text);
	}
}

// Stable order: by file, then line.
findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1));

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const inActions = !!process.env.GITHUB_ACTIONS;
for (const f of findings) {
	if (inActions) {
		const msg = f.message.replace(/\n/g, ' ');
		console.log(`::error file=${f.file},line=${f.line},title=diff-review: ${f.rule}::${msg}`);
	}
	console.error(`FAIL ${f.file}:${f.line}  [${f.rule}] ${f.message}`);
}

if (jsonPath) writeFileSync(jsonPath, JSON.stringify(findings, null, 2));

if (findings.length === 0) {
	console.error('diff-review: PASS — no issues found');
	process.exit(0);
}
console.error(`\ndiff-review: FAIL — ${findings.length} finding(s)`);
process.exit(1);
