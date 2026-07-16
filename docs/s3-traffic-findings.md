# S3 real-traffic smoke — findings

Live smoke of the deployed Worker (`tracker.shravyalabs.com`, version
`3559a39f`) driven by the five teammates provisioned in Step 7. Each teammate
performed the three core actions — file an issue, comment on someone else's
issue, attach a file — for 15 authenticated requests total, captured with
`wrangler tail --format json` and analyzed offline (the Step 6 latency and 5xx
queries, reproduced from the structured `request.completed` / `request.errored`
logs because the Workers Logs dashboard UI is not scriptable from here).

**Window note:** traffic was generated as one burst rather than spread over ten
minutes of organic clicks. The p95 figures below are from that burst; they are
directional, not a steady-state SLO measurement.

## Traffic result

| Action | Requests | Result |
|--------|----------|--------|
| File an issue (`POST /issues`) | 5 | 5 × 200 |
| Comment on another's issue (`POST /issues/:n/comments`) | 5 | 5 × 200 |
| Attach a file (`POST /issues/:n/attachments`) | 5 | **5 × 500** |

## p95 latency per route

Grouped by logical route. The raw logs record the concrete path (see issue #3),
so the comment rows were aggregated back into one logical route by hand.

| Route | n | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) |
|-------|---|----------|----------|----------|----------|
| `POST /issues` | 5 | 349 | 354 | 354 | 354 |
| `POST /issues/:n/comments` | 5 | 515 | **529** | 529 | 529 |
| `POST /issues/:n/attachments` | 5 | — | — | — | — (threw before `request.completed`) |

**Routes with p95 > 500 ms:** `POST /issues/:n/comments` (529 ms). Every one of
the five comment writes measured 513–529 ms.

## 5xx analysis (excluding expected 401s)

No unauthenticated 401 probes landed in the capture window. All errors were real
5xx from authenticated traffic:

- **5 × exception-outcome invocations**, all on `POST /issues/:n/attachments`,
  all the same signature:
  `TypeError: accessKeyId is a required option`.

## Top 3 issues

### 1. Attachment uploads are 100% broken in production (worst)
- **Where:** `src/routes/attachments.ts:39` (`new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID, ... })`), reached from the `POST /` handler at `src/routes/attachments.ts:89`.
- **Symptom:** every `POST /issues/:n/attachments` with a valid mime/size throws `TypeError: accessKeyId is a required option` and returns a raw Cloudflare `1101` (unhandled exception), not a JSON error.
- **Root cause:** the `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` Worker secrets are not set in production (only `BETTER_AUTH_SECRET` and `R2_ACCOUNT_ID` are). `aws4fetch` rejects an undefined `accessKeyId` before any network call.
- **Impact:** the entire attachment feature is dead for all users. Confirmed 5/5 in this smoke.
- **Disposition — LOGGED (not fixed this session).** The real fix is an operator action, not code: create an R2 API token (dashboard → R2 → Manage R2 API Tokens → Object Read & Write on `issue-attachments`) and set the two secrets with `wrangler secret put`. Out of scope for an in-session code change. Secondary code hardening to follow up (S4): guard `presign()` so a missing credential returns a clean `503 { error: "attachments not configured" }` instead of a raw 1101.

### 2. `POST /issues/:n/comments` breaches the 500 ms p95 SLO
- **Where:** `src/routes/comments.ts:23` (resolve `issue_number` → `issues.id`) then `src/routes/comments.ts:52` (insert) — two sequential D1 round-trips.
- **Symptom:** every comment write measured 513–529 ms (p95 529 ms), vs `POST /issues` at ~350 ms, which does a single round-trip.
- **Root cause:** the extra ~170 ms is the second remote D1 call. `POST /issues` avoids it by resolving `issue_number` inside the insert with a subquery; comments does not.
- **Impact:** a core write path is consistently over the 500 ms p95 target.
- **Disposition — FIXED this session.** Collapse resolve + insert into one `INSERT … SELECT … RETURNING` statement, mirroring `issues.ts`. Under 30 minutes, low risk, clears the measured breach.

### 3. High-cardinality route label defeats the per-route latency/error queries
- **Where:** `src/log.ts:24` (`route: c.req.path`).
- **Symptom:** the logger records the concrete path (`/issues/5/comments`), so the Step 6 group-by-route percentile queries (`docs/logs-queries.md` Q1/Q2) fragment one logical route into a separate bucket per issue number. This analysis had to re-aggregate the comment rows by hand.
- **Root cause:** `c.req.path` is the request path, not the matched route template.
- **Impact:** at any real traffic volume the per-route p95 / error-count queries are unusable — every issue id is its own "route".
- **Disposition — LOGGED (follow-up, S4).** Fix is to log the matched route template (`c.req.routePath`), but it needs verifying that Hono resolves the template correctly through the mounted sub-apps before shipping.
