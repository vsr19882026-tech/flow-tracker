# Repeatable workflow — start the next internal tool

A one-page, self-contained template for taking an internal tool from nothing to
first-teammate-onboarded on Cloudflare Workers (Hono + D1 + Better Auth + R2 +
Email). Budget **~12–16 hours**. Each phase: what you do, the exact commands,
where to look deeper, and the pitfall that cost us time.

You're **done** when a real teammate signs in and files an issue. Stack assumed:
`wrangler`, `gh`, Node, git. Run commands as `wrangler ...` (or `npx wrangler`).

---

## Day 0 — Setup checklist (~1 h)

**Do:** Line up the rails before any code: a paid Workers plan, a domain in your
Cloudflare zone, a verified Email Routing sender, an empty repo, and your app
secret.

```bash
wrangler login
# Dashboard: enable a paid Workers plan; add your domain (zone);
#            Email Routing -> verify a sender address/domain (DKIM/SPF).
gh repo create <name> --private
wrangler secret put BETTER_AUTH_SECRET      # any long random string
```

**Deeper:** the bindings table + hard rules in [`../CLAUDE.md`](../CLAUDE.md).
**Pitfall:** skip the *verified* sender or the secret now and auth/email fail
silently much later — set them Day 0.

## Day 1 · Block A — Skeleton that deploys (~2.5 h)

**Do:** Scaffold, add D1 + a first migration, wire magic-link auth, attach the
domain, and run a rollback drill so you trust "undo" before you need it.

```bash
wrangler init <name>                          # wrangler.toml + src/index.ts
wrangler d1 create <db>                        # paste [[d1_databases]] into wrangler.toml
# write migrations/0001_init.sql, then apply to REAL remote D1:
wrangler d1 migrations apply <db> --remote
# src/auth.ts: Better Auth magic-link via a per-request createAuth(env) factory
# wrangler.toml: routes = [{ pattern="tool.<domain>", custom_domain=true }]
wrangler versions upload && wrangler versions deploy <id>@100
wrangler rollback <previous-id> -y && curl -s -o /dev/null -w "%{http_code}\n" https://tool.<domain>/whoami
```

**Deeper:** [`wrangler.toml`](../wrangler.toml), the rollback playbook in
[`oncall.md`](./oncall.md).
**Pitfall:** a migration with a trigger (inner `;`) passes the `--local` CI gate
but fails `apply --remote` — always apply against real remote before trusting green.

## Day 1 · Block B — Test-first agent loop (~2 h)

**Do:** For every feature, write the failing test first, implement to green,
typecheck, then preview and promote.

```bash
# 1) failing contract test  2) implement  3) green:
npm test -- --run
npx wrangler types && npx tsc --noEmit
wrangler versions upload                        # preview URL, no traffic
wrangler versions deploy <id>@100               # promote
wrangler triggers deploy                        # ONLY if you added/changed a Cron Trigger
```

**Deeper:** the Workflow section of [`../CLAUDE.md`](../CLAUDE.md).
**Pitfall:** `versions deploy` does not register Cron Triggers, and rollout is
gradual — re-verify prod a minute later, not on the first request.

## Day 2 — Guardrails around the agent (~2 h)

**Do:** Write `CLAUDE.md` (stack, bindings, non-negotiable rules) and wire the
automation that enforces it.

```bash
# CLAUDE.md at repo root: hard rules (remote-only migrations, test-first, no swallowed errors)
# husky: pre-commit = tsc on staged TS; pre-push = full test run
# .github/: diff-review (BLOCKING static check) + second-opinion (ADVISORY) on every PR
# .claude/commands/: /ship (branch->test->PR) and /tail (prod errors)
wrangler tail <name> --status error --format pretty
```

**Deeper:** [`../CLAUDE.md`](../CLAUDE.md), `.github/scripts/diff-review.mjs`.
**Pitfall:** these prove the code is *self-consistent*, not that it *works in
prod* — keep a human/real-env check on the "merged → actually works" boundary
(see [`post-mortem.md`](./post-mortem.md)).

## Week 2 · Day 1 — Scale + observability (~2.5 h)

**Do:** Map the serial choke-points, fan independent work out across git
worktrees, merge in dependency order, add structured logging, invite teammates.

```bash
git worktree add ../<feat> -b feat/<x>          # one worktree per independent stream
# one log() helper emitting JSON lines; save a few Workers Logs queries
# invite the first teammates through the admin UI, watch: wrangler tail
```

**Deeper:** [`logs-queries.md`](./logs-queries.md),
[`s3-traffic-findings.md`](./s3-traffic-findings.md).
**Pitfall:** parallel worktrees editing the same files collide at merge — split
fan-out along file boundaries and fix merge order *before* you start.

## Week 2 · Day 2 — Hardening + handoff (~3 h)

**Do:** Layer in the internal-tool essentials, then write the post-mortem.

```bash
# migrations: RBAC (project_members), audit_log, invites (+ consumed_at), users.onboarded_at
# GET /admin/export streaming CSV/JSON; nightly Cron -> full D1 dump -> R2 (30-day retention)
# bulk invite via admin UI; on-call playbook (docs/oncall.md)
# verify email delivery in D1 (invites.consumed_at, users.onboarded_at) — NOT the HTTP 200
```

**Deeper:** [`oncall.md`](./oncall.md), [`post-mortem.md`](./post-mortem.md).
**Pitfall:** best-effort email/audit paths swallow errors, so a pinned or
misconfigured sender returns 200 while delivering nothing — verify via the
database, never the status code.

---

## Rough time budget

| Phase                      | Est.   |
|----------------------------|--------|
| Day 0 setup                | ~1.0 h |
| Day 1 Block A skeleton     | ~2.5 h |
| Day 1 Block B agent loop   | ~2.0 h |
| Day 2 guardrails           | ~2.0 h |
| Week 2 D1 scale + obs.     | ~2.5 h |
| Week 2 D2 harden + handoff | ~3.0 h |
| **Total**                  | **~13 h** |

Add a couple of hours the first time through for the pitfalls above — that's the
**12–16 h** range. Highest-leverage habit: **run the real thing against real
infra early** (remote migrations, a real sign-in, a rollback drill) instead of
trusting green checks. Green means consistent, not correct.
