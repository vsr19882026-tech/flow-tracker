# Workers Logs — saved queries & cost budget

Operational queries for `flow-tracker`, plus the cost-alert setup. Run them in
the Cloudflare dashboard under **Workers & Pages → flow-tracker → Observability
→ Logs** (the "Logs" explorer). Observability is enabled in `wrangler.toml`
(`[observability] enabled = true`, `head_sampling_rate = 1`), so every
invocation is captured.

## What the logs contain

Every request emits structured JSON events via `log()` (`src/log.ts`), logged as
objects so each key is a first-class, queryable field:

| Event                    | When                          | Key fields |
|--------------------------|-------------------------------|------------|
| `request.started`        | request entry                 | `request_id`, `route`, `method`, `user_id` (null at entry) |
| `request.completed`      | request exit (no throw)       | `request_id`, `route`, `method`, `user_id`, `duration_ms`, `status` |
| `request.errored`        | uncaught throw (→ 500)        | `request_id`, `route`, `method`, `user_id`, `duration_ms`, `error_name`, `error_message` |
| `magic_link.requested`   | every sign-in attempt         | `email` (lowercased), `ip` |
| `magic_link_rate_limited`| a throttled sign-in           | `scope`, `email`, `ip`, `count` |

`route` is the request path (e.g. `/issues`, `/whoami`). A 5xx surfaces as a
`request.errored` event, not a `request.completed` with `status >= 500`, because
the app throws on error and re-throws in `app.onError` (so the invocation is
recorded as an exception).

---

## Query 1 — latency percentiles per route (last 1 hour)

p50 / p95 / p99 of request duration, per route. Spot slow endpoints.

**Logs explorer:**
- **Time range:** Last 1 hour
- **Filter:** `event = request.completed`
- **Visualize:** add three calculations on field `duration_ms` → **p50**, **p95**, **p99**
- **Group by:** `route`

**Filter expression (paste into the query bar):**
```
event = "request.completed"
```
then set the visualization to `p50(duration_ms), p95(duration_ms), p99(duration_ms)` grouped by `route`.

Returns one row per route with three latency columns. Requires at least one
completed request in the window.

---

## Query 2 — 5xx count per route (last 24 hours)

Count of server errors per route. Any nonzero row is worth investigating.

**Logs explorer:**
- **Time range:** Last 24 hours
- **Filter:** `event = request.errored`
- **Visualize:** **Count**
- **Group by:** `route`

**Filter expression:**
```
event = "request.errored"
```
grouped by `route`, calculation `Count`.

> If you ever return a 5xx *without* throwing (not the case today), also union in
> `event = "request.completed" AND status >= 500`. As written, `request.errored`
> is the complete set of 5xx responses.

Returns one row per route that threw. To force a row for testing:
`curl -X POST https://tracker.shravyalabs.com/issues -H 'content-type: application/json' --cookie '<session>' -d 'not-json{'` → 500.

---

## Query 3 — sign-in attempts per email (last 1 hour)

Count of magic-link sign-in attempts per email. A single email with a high count
is the abuse signal the KV rate limiter throttles at 5/hour.

**Logs explorer:**
- **Time range:** Last 1 hour
- **Filter:** `event = magic_link.requested`
- **Visualize:** **Count**
- **Group by:** `email`
- **Sort:** count descending

**Filter expression:**
```
event = "magic_link.requested"
```
grouped by `email`, calculation `Count`, sorted descending.

Returns one row per email that attempted sign-in. Every attempt is logged (the
event fires before the allowlist guard and the rate limiter), so this counts all
attempts, not just throttled ones. To force rows:
`curl -X POST https://tracker.shravyalabs.com/auth/sign-in/magic-link -H 'content-type: application/json' -d '{"email":"probe@example.com"}'` (repeat).

---

## Cost budget alert — $20/month

Set a billing notification at **$20/mo** — 4× the $5 Workers Paid floor — so cost
overruns are caught early.

Dashboard steps (billing alerts are account-level; there is no wrangler command
and the CLI OAuth token cannot create them, so this is done in the UI):

1. **Cloudflare dashboard → Manage Account → Notifications** (or **Billing →
   Billing Alerts**).
2. **Add** a notification → type **Billing: Usage Based Billing** (a.k.a.
   "Usage-based billing spend alert").
3. **Threshold:** `20` (USD, per month).
4. **Delivery:** your email (`vsr19882026@gmail.com`).
5. **Save.**

Alternatively, per-worker: **Workers & Pages → flow-tracker → Settings → Usage**
shows current usage; billing alerts themselves live under account Notifications.

Confirm the alert appears in **Notifications** with a $20 threshold and an active
state.
