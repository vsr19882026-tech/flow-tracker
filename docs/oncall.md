# On-call playbook — flow-tracker

The four incidents most likely to page you at 2am, with the exact commands to
run. Copy/paste ready. Read the decision point in each before you act.

## Ground truth (fill these into commands below)

| Thing            | Value                                          |
|------------------|------------------------------------------------|
| Worker           | `flow-tracker`                                 |
| Prod URL         | `https://tracker.shravyalabs.com`              |
| D1 database      | `issues-prod` (`d32ac579-9af3-4212-b047-a1fabc098071`) |
| R2 bucket        | `issue-attachments` (nightly DB backups under `backups/issues-prod/`) |
| GitHub repo      | `vsr19882026-tech/flow-tracker`                |
| Health check     | `GET /whoami` → **401** (no session) or **200** (session). Anything **5xx** is unhealthy. |

**Shell note (Windows dev box):** run `git` through Git Bash with
`export PATH="/c/Program Files/Git/cmd:$PATH"` first; run Wrangler as
`npx wrangler`. On Linux/mac just use `wrangler`/`git` directly.

Quick health probe used throughout:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://tracker.shravyalabs.com/whoami
# 401 or 200 = up.  5xx / 000 = down.
```

---

## 1. Prod is throwing 500s on every request

**Identify.** Tail live error invocations for ~60s and read the signatures.
Unhandled errors reach here because `app.onError` (`src/index.ts`) logs and
**rethrows**, and `--status error` filters on the exception outcome.

```bash
npx wrangler tail flow-tracker --status error --format pretty
# Look for: repeated error_name/error_message, and which route.
```

**Decision point.** Is it a config/secret problem you can fix forward in
minutes (missing secret, bad binding), or is it code that's broken for everyone?

- Fixable forward → fix, `npx wrangler versions upload` + `versions deploy <id>@100`.
- **Unrecoverable / unknown at 2am → roll back now, diagnose later.**

**Roll back** to the immediately previous deployment:

```bash
npx wrangler rollback -y -m "2am: prod 500s on every request, rolling back"
# To a SPECIFIC known-good version instead, pass its id (see playbook 4):
#   npx wrangler rollback <version-id> -y -m "..."
```

> Rollout/rollback is **gradual and non-atomic** — during propagation you'll see
> a mix of old and new. Re-check for ~1–2 min, don't declare victory on the
> first request.

**Confirm recovery:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://tracker.shravyalabs.com/whoami   # want 401/200
npx wrangler tail flow-tracker --status error --format pretty                     # want silence
```

**Open a post-mortem issue** so the fix-forward happens in daylight:

```bash
gh issue create --repo vsr19882026-tech/flow-tracker \
  --title "Post-mortem: prod 500s on $(date -u +%Y-%m-%d)" \
  --label incident \
  --body "**Impact:** all requests 500 for <N> min.
**Action taken:** rolled back to previous version.
**Rolled-back-from version:** <bad id from \`wrangler versions list\`>.
**Suspected cause:** <error_name/message from tail>.
**Follow-up:** root-cause and fix forward."
```

---

## 2. D1 is full / slow

**Current size and shape:**

```bash
npx wrangler d1 info issues-prod
# Reads: database_size, num_tables, rows_written_24h. NOTE: d1 info always acts
# on remote — it does NOT take --remote (passing it just prints help).
```

**Find the biggest tables** (by row count — the usual proxy for size here):

```bash
npx wrangler d1 execute issues-prod --remote --command \
"SELECT 'audit_log' AS tbl, COUNT(*) AS rows FROM audit_log
 UNION ALL SELECT 'issues',       COUNT(*) FROM issues
 UNION ALL SELECT 'comments',     COUNT(*) FROM comments
 UNION ALL SELECT 'session',      COUNT(*) FROM session
 UNION ALL SELECT 'verification', COUNT(*) FROM verification
 ORDER BY rows DESC"
```

**Most common culprit: `audit_log` past retention.** It grows one row per write
(POST/PATCH/PUT/DELETE) forever — there is no automatic prune. `created_at` is
**epoch milliseconds**.

**Decision point.** Keep the last 30 days of audit history (default) unless a
compliance hold says otherwise. Then delete older rows and reclaim the space:

```bash
# Cutoff = 30 days ago, in epoch MILLISECONDS.
CUTOFF=$(date -d '30 days ago' +%s)000

# Dry run: how many rows would go?
npx wrangler d1 execute issues-prod --remote --command \
  "SELECT COUNT(*) AS to_delete FROM audit_log WHERE created_at < $CUTOFF"

# Delete, then reclaim freed pages (VACUUM rewrites the file smaller).
npx wrangler d1 execute issues-prod --remote --command \
  "DELETE FROM audit_log WHERE created_at < $CUTOFF"
npx wrangler d1 execute issues-prod --remote --command "VACUUM"

npx wrangler d1 info issues-prod   # confirm database_size dropped
```

> Other unbounded-ish tables: `session` and `verification` accumulate rows Better
> Auth normally expires. Expired rows are safe to prune the same way
> (`expiresAt < datetime('now')`). Never delete from `issues`, `comments`,
> `user`, `invites`, or `project_members` — that's real data; restore from the
> nightly R2 backup (`backups/issues-prod/<date>.sql`) instead.

---

## 3. Magic-link emails not arriving

**Known by design first:** the `send_email` (EMAIL) binding is pinned to the
**verified** address `vsr19882026@gmail.com`. Any other recipient fails with
`E_RECIPIENT_NOT_ALLOWED` — so teammates at `@shravyalabs.com` *not* getting mail
is expected until a real provider (Resend/Postmark via `fetch`) is wired. Rule
this out before chasing DNS.

**Check delivery in the dashboard.** Cloudflare → the `shravyalabs.com` zone →
**Email Routing → Overview / Activity log**: are messages being accepted,
dropped, or bounced?

**Check DKIM is still verified.** Cloudflare → **Email Routing → Settings** (and
zone **DNS**): confirm the sender domain's DKIM/SPF records are present and
**Verified**. These rotate rarely but a lapsed record silently kills delivery.
Sender is `noreply@shravyalabs.com` (`src/email.ts`).

**Rate-limit hit?** Magic-link requests are throttled in KV at **5 per email**
and **30 per IP** per hour. A throttled request returns **429** and logs
`magic_link_rate_limited`:

```bash
npx wrangler tail flow-tracker --format pretty | grep -E "429|magic_link_rate_limited"
```

**Decision point.** Accepted-but-not-delivered → DNS/DKIM or recipient not
verified. 429s → rate limit (wait out the hour, or raise the limit in
`src/rate-limit.ts`). Nothing in Email Routing at all → the send never left the
Worker: check `wrangler tail --status error` for a send exception.

---

## 4. An agent shipped a destructive change you only noticed in the morning

**Find the last-good version.** Versions are listed newest-last; the message
column carries the deploy note:

```bash
npx wrangler versions list flow-tracker
# Identify: the current (bad) version, and the last version you trust.
```

**Roll back to that specific version:**

```bash
npx wrangler rollback <good-version-id> -y -m "revert destructive change, see PR #<n>"
curl -s -o /dev/null -w "%{http_code}\n" https://tracker.shravyalabs.com/whoami   # want 401/200
```

> Same non-atomic caveat as playbook 1 — give propagation a minute.

**Inspect what actually changed** (bad PR vs the good state):

```bash
gh pr view <bad-pr-number> --repo vsr19882026-tech/flow-tracker
gh pr diff <bad-pr-number> --repo vsr19882026-tech/flow-tracker
```

**If the change touched the database** (dropped/edited data), code rollback is
not enough — data is separate. Restore from the nightly backup:

```bash
npx wrangler r2 object get issue-attachments/backups/issues-prod/<YYYY-MM-DD>.sql \
  --file restore.sql --remote
# Review restore.sql, then apply the needed statements with `d1 execute`.
```

**File the post-mortem with the bad PR linked:**

```bash
gh issue create --repo vsr19882026-tech/flow-tracker \
  --title "Post-mortem: destructive change shipped in #<bad-pr>" \
  --label incident \
  --body "**Bad PR:** #<bad-pr>.
**Detected:** <when/how>.
**Rolled back to:** <good-version-id>.
**Data impact:** <none | restored from backups/issues-prod/<date>.sql>.
**Prevention:** <test/gate to add so this can't merge again>."
```

---

## Notes / gotchas that bite during an incident

- **Cron triggers don't ride along with `versions deploy`.** If a rollback or
  deploy needs the nightly-backup cron (`0 3 * * *`) re-registered, run
  `npx wrangler triggers deploy` separately.
- **`wrangler r2 object list` doesn't exist** in this Wrangler (4.107) — only
  `get`/`put`/`delete`. Verify a backup with `r2 object get ... --remote`.
- **Migrations are append-only and remote.** Never edit a shipped migration;
  never apply `--local` against prod. A destructive schema change is reverted
  with a *new* forward migration, not by editing history.
- **Branch protection** on `main` requires review + build-and-test + migrations
  checks (enforce_admins on). A true emergency hotfix still goes through a PR.
