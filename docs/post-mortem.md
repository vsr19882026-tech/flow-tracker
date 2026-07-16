# Post-mortem — the flow-tracker build weekend

Honest retro of building flow-tracker with an agent driving the ship loop
(branch → TDD → PR → CI → merge → deploy → verify). Written from the agent's
own record of what happened; add your cohort's perspective inline where it
differs. The goal is not to grade the weekend — it's to find where the
**agent + tooling stack still leaned on a human paying attention.**

---

## 1. What did the agents get wrong? (top 5)

### 1. A migration passed CI but broke on real prod D1

- **Step / file:** Block A Step 1 (RBAC), `migrations/0005_rbac.sql`.
- **Failure mode:** the migration created a trigger whose body contained an
  inner `;`. `wrangler d1 migrations apply --remote` splits the file on
  semicolons and choked mid-trigger (`incomplete input`, `SQLITE_ERROR 7500`).
  The CI migration gate applies migrations with `--local` (miniflare), which
  splits statements *differently* and passed clean — **a false green.**
- **What saved us:** not CI. A human ran the real `--remote` apply and watched
  it fail. Recovery was manual: apply the three statements individually via
  `wrangler d1 execute`, then hand-insert the row into `d1_migrations` so the
  runner wouldn't retry. Had we trusted the green check and moved on, prod would
  have been missing `project_members` + its trigger — **RBAC silently not
  enforced.** (This is the missing guard in §3.)

### 2. Feature work committed straight to `main` — twice

- **Step / file:** Block A Step 3 (audit log), and once earlier in Step 6. The
  workflow's first rule is "cut a branch"; it got skipped.
- **Failure mode:** process discipline. The agent implemented and committed
  before branching.
- **What saved us:** branch protection on `main` (the push would be rejected —
  required review + checks, `enforce_admins` on) plus a careful recovery:
  `git branch <feat>` then `git reset --keep origin/main` (never `--hard`,
  which is deny-listed). No history was lost, but only because the guard and the
  recovery both existed. A less careful reset would have dropped the work.

### 3. Unicode BOM got mangled by the editing tooling

- **Step / file:** Step 4 (CSV/JSON export), `src/lib/export.ts`.
- **Failure mode:** the UTF-8 BOM was first written as a `﻿` literal; the
  Edit tool converted it to an invisible character, and a shell-escaping attempt
  turned it into the literal text `FEFF`. Either way the emitted bytes were
  wrong — a CSV that opens as mojibake in Excel for non-ASCII data.
- **What saved us:** a check asserting the **exact leading bytes** `ef bb bf`.
  It failed on the corrupted versions and only passed once the code used an
  explicit `new Uint8Array([0xef, 0xbb, 0xbf])`. A test that asserted "has a
  BOM" loosely, or no test at all, would have shipped garbage.

### 4. Emails silently do nothing for real teammates

- **Step / file:** Step 6 (`src/routes/admin.tsx`, `sendInviteEmail`) and Step 7
  (`src/lib/onboarding.ts`, `sendOnboardingEmail`), both through `src/email.ts`.
- **Failure mode:** the `send_email` binding is pinned to one verified address
  (`vsr19882026@gmail.com`); any other recipient fails with
  `E_RECIPIENT_NOT_ALLOWED`. Both send paths are **best-effort and swallow the
  error** (the no-try/catch house rule implemented as `.then(ok, noop)`), and
  the request returns 200/302. So the code reports success while nothing reaches
  the teammate.
- **What saved us:** a human who *knew* the constraint and verified via the
  database (`invites.consumed_at`, `users.onboarded_at`) rather than trusting the
  200. Nothing in the stack raised a flag. If you didn't already know delivery
  was pinned, you'd believe onboarding worked.

### 5. A live route 500s on unset optional config

- **Step / file:** attachments (`src/routes/attachments.ts`); surfaced by the
  Step-8 real-traffic smoke, written up in `docs/s3-traffic-findings.md`.
- **Failure mode:** the attachment presign path throws a 500 when the R2 presign
  secrets are unset. The route and its validation shipped; the secrets never got
  set (parked). Unit tests exercise validation, not a real presign, so they were
  green.
- **What saved us:** a deliberate, human-initiated traffic smoke — not the test
  suite. Absent that smoke, the first a user learns of it is a 500 on upload.

---

## 2. What would have shipped to prod if you hadn't been watching?

Being honest about where a green pipeline was **not** the same as a working system:

- **Broken RBAC with a green checkmark (worst case).** CI marked `0005` applied;
  prod would have lacked `project_members` and its trigger. Authorization would
  quietly fail open/closed depending on the path, and the dashboard would say
  everything was fine. This is the one that would actually have shipped, because
  the human is the *only* thing that ran the real remote apply.
- **An onboarding/invite feature that emails no one.** Both would have "shipped"
  as green, tested, deployed features that silently no-op for every real
  teammate. The demo works (owner is verified); production for anyone else does
  nothing, with no error surfaced.
- **A 500 on attachment upload.** Live right now for anyone who hits it — only
  known because we went looking. Still parked.
- **A CSV export that corrupts non-ASCII in Excel.** Would have shipped if the
  byte-exact BOM assertion hadn't existed.
- **Silently dropped audit rows.** The audit write is best-effort too
  (`src/middleware/audit.ts`); a failing insert is swallowed with no signal. We
  never saw it happen, but nothing would tell us if it did — a compliance gap
  hiding behind "best effort."

The pattern: **the tooling is excellent at "is the code internally consistent?"
and blind to "does the deployed system actually do the thing?"** Every near-miss
above lived in that gap.

## 3. Which guard is missing?

**Pick: CI validates migrations against `--local`, not real remote D1.** This is
the gap that nearly shipped broken RBAC (§1.1) with a green build.

**The guard that would have caught it automatically:** a CI job that applies each
new migration to a **throwaway real D1** (a dedicated `issues-ci` database)
with `wrangler d1 migrations apply issues-ci --remote`, then tears it down. The
real remote runner is the only thing that reproduces the statement-splitter
behavior that `--local`/miniflare does not. Make it a required check alongside
`build-and-test` and the existing (local) `migrations` gate.

Cheaper stopgap if a remote CI database isn't wanted: a lint rule (extend
`.github/scripts/diff-review.mjs`) that **flags any migration containing a
`CREATE TRIGGER ... BEGIN ... ;` with inner semicolons** and requires such DDL to
be applied via single-statement `d1 execute` instead of the migration runner.
That's exactly the shape that broke, and it's statically detectable.

*Runner-up gap:* no visibility into swallowed best-effort failures (§1.4, audit
in §2). The fix is small — emit a structured `email.send_failed` /
`audit.write_failed` log line in the `noop` branch instead of a bare swallow, and
add a Workers Logs alert. "Best effort" should still be *observable* effort.

## 4. What was unexpectedly easy?

Worth naming, because these would have been a day each before:

- **Streaming CSV/JSON export with a hard row cap** (Step 4). A `ReadableStream`
  paging through D1 with RFC-4180 quoting and a 100k → 413 cap, memory-bounded,
  in a single sitting. Historically a "get the buffering wrong, OOM in prod"
  task; here it was routine.
- **Nightly DB backup to R2 on a Cron Trigger** (Step 5). Full schema+data SQL
  dump, 30-day retention prune, a `scheduled` handler, shipped and verified live
  (`wrangler dev --remote --test-scheduled`) in one branch.
- **Real RBAC as middleware** (Step 1). `canWrite`/`canRead`/`requireAdmin`
  wired across routes with a 3×3 permission-matrix test — the kind of thing
  that's usually a week of subtle bugs — landed fast and stayed green.
- **Rollback as a non-event** (Steps 8–9). `wrangler rollback <id>` +
  roll-forward in seconds, with `/whoami` as an instant health check. "Undo a
  prod deploy" went from scary to a drill we ran on purpose.
- **Faking a 12-person org with no inboxes.** Provisioning realistic multi-user
  state (invites, first-sign-in onboarding, audit trails) via the no-inbox token
  trick let us exercise the whole team flow end-to-end without real email.
- **The ship loop itself became muscle memory.** Branch → failing test → green →
  typecheck → diff-review → PR → CI → merge → deploy → verify, many times over,
  fast enough that the process stopped being the bottleneck.

---

### The one line to carry to the next project

Green CI proves the code is consistent with itself. It does **not** prove the
deployed system does its job — migrations, email delivery, and config-dependent
routes all passed checks while being wrong. Put a human (or a real-environment
check) on the boundary between "merged" and "actually works in prod."
