# Repeatable workflow — start the next internal tool

A one-page template for taking an internal tool from nothing to
first-teammate-onboarded, distilled from building flow-tracker. Budget
**~12–16 hours** across the phases below. Each phase: what you do, where to look,
and the pitfall that cost us time so it won't cost you.

You're **done** when a real teammate signs in and can file an issue — everything
before that is setup.

---

## Day 0 — Setup checklist (~1 h)

**Do:** Before any code, line up the rails — a Cloudflare account on a paid
Workers plan, `wrangler` installed and `wrangler login`, a domain in the zone,
a verified Email Routing sender, an empty GitHub repo, and your app secret via
`wrangler secret put BETTER_AUTH_SECRET`.
**Follow:** Session **S0**; the bindings table and hard rules in
[`../CLAUDE.md`](../CLAUDE.md).
**Pitfall:** Skipping the *verified* email domain and the secrets now means auth
and email fail silently much later — set them Day 0, not when they break.

## Day 1 · Block A — Skeleton that deploys (~2.5 h)

**Do:** `wrangler init` → create a D1 database and a first migration → wire
Better Auth (magic-link) with a per-request `createAuth(env)` factory → attach
the custom domain → and immediately run a **rollback drill** so you trust "undo"
before you need it.
**Follow:** Session **Block A**; [`wrangler.toml`](../wrangler.toml),
`src/auth.ts`, and the rollback playbook in [`oncall.md`](./oncall.md).
**Pitfall:** A migration with a trigger (inner `;`) passes the `--local` CI gate
but fails `wrangler d1 migrations apply --remote` — always apply against real
remote D1 before trusting a green check.

## Day 1 · Block B — Test-first agent loop (~2 h)

**Do:** Adopt the loop for every feature — write the failing contract test
first, implement until `npm test` is green, typecheck, then preview with
`wrangler versions upload` and promote with `wrangler versions deploy <id>@100`.
**Follow:** Session **Block B**; the Workflow section of
[`../CLAUDE.md`](../CLAUDE.md).
**Pitfall:** `versions deploy` does **not** register Cron Triggers (run
`wrangler triggers deploy` separately), and rollout is gradual — re-verify prod a
minute after deploying, not on the first request.

## Day 2 — Guardrails around the agent (~2 h)

**Do:** Write `CLAUDE.md` (stack, bindings, non-negotiable rules) and wire the
automation that enforces it: a `/ship` command, husky hooks (pre-commit
typecheck, pre-push tests), a **blocking** diff-review check, an **advisory**
second-opinion reviewer, and a `/tail` for prod errors.
**Follow:** Session **Day 2**; [`../CLAUDE.md`](../CLAUDE.md),
`.claude/`, and `.github/scripts/diff-review.mjs`.
**Pitfall:** These guards prove the code is *self-consistent*, not that it
*works in prod* — keep a human or a real-environment check on the boundary
between "merged" and "actually works" (see [`post-mortem.md`](./post-mortem.md)).

## Week 2 · Day 1 — Scale + observability (~2.5 h)

**Do:** Map the serial choke-points, then fan independent work out across git
worktrees, merge in dependency order, add structured logging + a few saved log
queries, and invite your first teammates.
**Follow:** Session **Week 2 Day 1**; [`logs-queries.md`](./logs-queries.md) and
the traffic-smoke writeup in [`s3-traffic-findings.md`](./s3-traffic-findings.md).
**Pitfall:** Parallel worktrees that edit the same files collide at merge —
split fan-out along file boundaries and settle merge order *before* you start,
not after.

## Week 2 · Day 2 — Hardening + handoff (~3 h)

**Do:** Layer in the internal-tool essentials — RBAC (as middleware, not in
handlers), an audit log, CSV/JSON export, a nightly D1→R2 backup on Cron, bulk
invites, and an on-call playbook — then write the post-mortem.
**Follow:** Session **Week 2 Day 2**; [`oncall.md`](./oncall.md) and
[`post-mortem.md`](./post-mortem.md).
**Pitfall:** Best-effort email/audit paths swallow their errors, so a pinned or
misconfigured sender returns 200 while delivering nothing — verify via the
database (`invites.consumed_at`, `users.onboarded_at`), never the HTTP status.

---

## Rough time budget

| Phase                     | Est.   |
|---------------------------|--------|
| Day 0 setup               | ~1.0 h |
| Day 1 Block A skeleton    | ~2.5 h |
| Day 1 Block B agent loop  | ~2.0 h |
| Day 2 guardrails          | ~2.0 h |
| Week 2 D1 scale + obs.    | ~2.5 h |
| Week 2 D2 harden + handoff| ~3.0 h |
| **Total**                 | **~13 h** |

Add a couple of hours the first time through for the pitfalls above — that's the
12–16 h range. The single highest-leverage habit: **run the real thing against
real infra early** (remote migrations, a real sign-in, a rollback drill) instead
of trusting green checks. Green means consistent, not correct.
