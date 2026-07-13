# flow-tracker — Agent Guide

Read this file at the start of every session. It defines the stack, the
bindings, and the hard rules for working in this repo. Follow it exactly.

## Stack

- **Runtime:** Cloudflare Workers, TypeScript, `nodejs_compat`.
- **HTTP:** Hono (`src/index.ts` is the entry; features mount as sub-apps).
- **D1:** primary relational store (issues + Better Auth tables).
- **KV:** cache namespace.
- **R2:** issue attachments.
- **Email Workers:** outbound transactional email (magic-link sign-in).
- **Auth:** Better Auth (magic-link), per-request `createAuth(env)` factory.
- **Tests:** Vitest with `@cloudflare/vitest-pool-workers` (real bindings).

## Bindings

Defined in `wrangler.toml`. Never hardcode ids; read them from `env`.

| Binding      | Type       | wrangler.toml block   |
|--------------|------------|-----------------------|
| `DB`         | D1         | `[[d1_databases]]`    |
| `CACHE`      | KV         | `[[kv_namespaces]]`   |
| `ATTACHMENTS`| R2         | `[[r2_buckets]]`      |
| `EMAIL`      | send_email | `send_email = [...]`  |

## Hard rules

These are non-negotiable. Do not violate them even if asked casually.

- **No `try/except` / `try/catch`.** Code the happy path only. On error,
  raise/throw and let it propagate. Do not swallow errors.
- **Never `git push --force`** (nor `--force-with-lease`) to any branch.
- **Never bypass hooks or CI.** No `--no-verify` on `git commit` or
  `git push`, no skipping required checks. The husky hooks are mandatory:
  pre-commit type-checks staged TS (`tsc --noEmit` via lint-staged), pre-push
  runs the test suite. If a hook fails, fix the code — never disable the hook.
- **Migrations are remote.** Apply schema with
  `wrangler d1 migrations apply issues-prod --remote`. Never apply with
  `--local` — the one exception is CI's throwaway dry-run gate, which applies
  migrations to a clean local D1 to validate SQL and never touches prod.
- **All DB writes go through versioned migrations.** Every schema change is a
  new file `migrations/NNNN_*.sql` (zero-padded, monotonic). No ad-hoc DDL.
- **Every new route gets a failing test first.** Write the contract test in
  `src/routes/<feature>.test.ts`, watch it fail, then implement.

## Workflow

1. Cut a branch. Never commit feature work straight to `main`.
2. Write the failing test (TDD red).
3. Implement until green: `npm test -- --run`.
4. Typecheck: `npx wrangler types && npx tsc --noEmit`.
5. Open a PR with `gh`, wait for CI green, merge.
6. Deploy: `wrangler versions upload` then `wrangler versions deploy <id>@100`.

## Tooling

- **`wrangler`** for all Cloudflare operations (deploy, D1, KV, R2, secrets).
- **`gh`** for all GitHub operations (PRs, CI status, merges).
- **No MCP servers.** See §MCP avoidance.
- **Permissions** are pinned in `.claude/settings.json`: a wrangler/gh/git
  allow-list, and a deny-list for `--force`, `--no-verify`, `git reset --hard`,
  and `rm -rf` outside `node_modules`/`.wrangler`.

### §MCP avoidance

Do not add, configure, or depend on MCP servers for this repo. Every task is
achievable with the `wrangler` and `gh` CLIs plus the file tools. If a task
seems to need an MCP server, use the CLI instead. This keeps the project
reproducible in CI and on a clean machine with no server setup.

## File layout

- `src/index.ts` — Worker entry: session middleware, route mounting.
- `src/auth.ts` — `createAuth(env)` factory (Better Auth).
- `src/email.ts` — `sendEmail()` via the `EMAIL` binding.
- `src/routes/<feature>.ts` — one Hono sub-app per feature.
- `src/routes/<feature>.test.ts` — co-located contract tests.
- `migrations/NNNN_*.sql` — versioned D1 migrations.
- `.husky/` — git hooks (pre-commit type-check, pre-push tests).
- `lint-staged.config.mjs` — runs `tsc --noEmit` when TS is staged.

## Conventions

- **Avoid model names in abstractions.** Refer to AI capabilities by their
  binding (e.g. the Workers AI binding), never by a model name. Model ids are
  configuration, not code. This applies to any provider (Workers AI, Bedrock,
  etc.) — swap the model without touching the abstraction.
- **Use full names for humans.** When code, comments, commits, or docs
  reference a person, use their full name, not initials or a handle.
- **Present tense, imperative.** Docs and comments state what the code does and
  what the reader must do. No marketing prose.

## Cloudflare docs

Your knowledge of Workers APIs and limits may be stale. Retrieve current docs
from `https://developers.cloudflare.com/` before any non-trivial Workers, D1,
KV, R2, or Email task. For limits, read the product's `/platform/limits/` page.
