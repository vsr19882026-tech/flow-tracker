# SAP Cloud ALM ITSM integration

Flow Tracker syncs issues in a `sap_synced` project to SAP support cases and back.
Outbound and inbound both go through Cloudflare Queues so a transient failure
retries instead of dropping.

```
issue write ──► sap_outbox row (same D1 batch) ──► SAP_OUTBOUND queue
                                                        │
                                             outbound consumer ──► PUT {base}/cases
                                                        │
                                                   sap_links (case_id)

SAP change ──► POST /integrations/sap/inbound (HMAC) ──► SAP_INBOUND queue
                                                        │
                                             inbound consumer ──► UPDATE issue + audit_log
```

## Mode toggle (mock / real / off)

The active SAP target is chosen at runtime, not at deploy time. Admin →
**SAP** tab → *Sync mode*:

- `off` — sync disabled (no target).
- `mock` — the `mock-sap/` Worker (see its README). Base from the *Mock base URL*
  field (or `SAP_API_BASE`); token endpoint is `<base>/oauth/token`.
- `real` — the `SAP_API_BASE` / `SAP_TOKEN_URL` secrets.

The mode lives in KV (`sap:config`). With nothing saved it falls back to `real`
when `SAP_API_BASE` is set, else `off`. `resolveSapTarget` (`src/lib/sap/target.ts`)
is the single place that resolves this.

## Token setup (OAuth client_credentials)

The outbound consumer authenticates with an OAuth 2.0 client-credentials grant and
caches the bearer in KV (`sap:token`, TTL = `expires_in - 60`). Secrets on the
Flow Tracker Worker:

```sh
wrangler secret put SAP_API_BASE       # SAP (or CPI) API base, e.g. https://<tenant>/itsm
wrangler secret put SAP_TOKEN_URL      # BTP OAuth token endpoint (real) — mock derives its own
wrangler secret put SAP_CLIENT_ID
wrangler secret put SAP_CLIENT_SECRET
wrangler secret put SAP_WEBHOOK_SECRET # 32+ random chars, shared with the sender (see inbound)
```

The token request is `POST SAP_TOKEN_URL` with `grant_type=client_credentials` and
HTTP Basic auth from `SAP_CLIENT_ID:SAP_CLIENT_SECRET`. A non-2xx throws so the
queue consumer retries / dead-letters.

## Outbound contract (Flow Tracker → SAP)

Per pending `sap_outbox` row, the consumer `PUT {base}/cases` with a bearer token.
The body is built from the field map (`toSapCase`); the `status` value is
translated through the status map. The **idempotency key** is
`externalReference = ft-<issueId>-<seq>` — SAP must upsert on it so a redelivery
does not create a second case.

- `2xx` → upsert `sap_links` (`sap_case_id`, `external_ref`, `last_seq_sent`), mark
  the outbox row `sent`, ack.
- `5xx` / network → retry, up to `max_retries` (5), then mark `dead`.
- `4xx` / unmapped status → mark `dead` immediately (no retry).

Expected `2xx` response shape: `{ "caseId": "<id>" }` (or `{ "id": "<id>" }`). The
returned id is stored in `sap_links.sap_case_id`.

## Inbound contract (SAP / CPI → Flow Tracker)

SAP (directly, or a CPI iflow) POSTs case changes to:

```
POST https://tracker.shravyalabs.com/integrations/sap/inbound
Content-Type: application/json
X-FT-Signature: sha256=<hex>

{ "case_id": "<sap case id>", "status": "<sap status>", "change_id": "<unique id>" }
```

- `X-FT-Signature` is `HMAC-SHA256(rawBody, SAP_WEBHOOK_SECRET)` as lowercase hex,
  prefixed `sha256=`. The receiver recomputes it over the exact raw bytes and does a
  constant-time compare. A mismatch → `401`, nothing changes.
- On a valid signature the request is enqueued on `SAP_INBOUND` and returns `202`
  immediately. The consumer then:
  - unknown `case_id` → ack + log `unknown_case` (no such `sap_links` row);
  - `change_id == sap_links.last_change_id` → ack (idempotent redelivery);
  - unmapped SAP status → dead-letter (`unmapped_status`), issue untouched;
  - otherwise update the issue status, insert an `audit_log` row with
    `actor_id = 'sap-sync'`, and advance `last_change_id` — atomically.

`change_id` must be unique per change; reusing one is treated as a duplicate.

## Reconciliation (safety net)

A `*/10 * * * *` cron (guarded on `SAP_API_BASE`) runs two passes:

- `reconcileOutbound` — re-enqueues `sap_outbox` rows still `pending` past a
  5-minute grace window (the consumer is idempotent, so this is safe).
- `reconcileInbound` — reads the `sync_state` inbound watermark, `GET
  {base}/cases?changedSince=<watermark>`, enqueues each changed case, and advances
  the watermark. A missed webhook is picked up here.

## Replay a dead outbox row

Admin → **SAP** tab → *Dead-letter queue*. Each dead row has a **Replay** button
(`POST /admin/integrations/sap/replay`, body `{ outboxId }`): it flips the row back
to `pending` and re-enqueues it. Because the outbound consumer is idempotent (a
row already `sent` acks as a no-op, and SAP upserts on `externalReference`), replay
never creates a duplicate case. Use it after fixing a mapping or once SAP recovers.

## Editing field / status maps

Admin → **SAP** tab → *Field & status mappings*. Edit the tables and **Save
mappings** (`POST /admin/integrations/sap/mappings`) — directions are validated
(`outbound` / `inbound` / `both`) and both maps are replaced atomically. Defaults
(seeded in migration `0010`):

| flow field / status | SAP field / status | direction |
|---|---|---|
| title | subject | both |
| description | description | both |
| status | status | both |
| issue_number | externalReference | outbound |
| open ↔ New, in_progress ↔ In Process, done ↔ Completed | | both |

Note the outbound consumer overrides `externalReference` with `ft-<issueId>-<seq>`
(the idempotency key); the seeded `issue_number → externalReference` row is a
placeholder for other mappings.

## Mock SAP

To run without a real tenant, deploy `mock-sap/` (see `mock-sap/README.md`), set
mode to `mock`, and drive status changes with
`GET <mock>/trigger-status?case_id=&status=`.
