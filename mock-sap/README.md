# mock-sap

A standalone Cloudflare Worker that stands in for a real SAP Cloud ALM ITSM tenant
so the Flow Tracker SAP integration can run end-to-end without one.

## Endpoints

- `POST /oauth/token` → `{ access_token, token_type, expires_in }` (fake bearer).
- `PUT /cases` → echoes `{ caseId: "MOCK-<externalReference>", ... }`. The case id
  is derived from `externalReference`, so re-PUT of the same change is idempotent.
- `GET /trigger-status?case_id=<id>&status=<sap-status>[&change_id=<id>]` → POSTs a
  signed webhook (`X-FT-Signature: sha256=<hmac>`) to `FT_INBOUND_URL`.

## Deploy

```sh
cd mock-sap
# Same secret value as Flow Tracker's SAP_WEBHOOK_SECRET:
wrangler secret put SAP_WEBHOOK_SECRET
wrangler deploy
# → note the deployed URL, e.g. https://mock-sap.<subdomain>.workers.dev
```

`FT_INBOUND_URL` defaults to the production tracker
(`https://tracker.shravyalabs.com/integrations/sap/inbound`) — override in
`wrangler.toml` `[vars]` if pointing at a different Flow Tracker.

## Wire Flow Tracker to it

Set on the **Flow Tracker** Worker (not here):

```sh
wrangler secret put SAP_WEBHOOK_SECRET   # same value as above
wrangler secret put SAP_API_BASE         # the mock-sap URL
wrangler secret put SAP_TOKEN_URL        # <mock-sap URL>/oauth/token
wrangler secret put SAP_CLIENT_ID        # any value (the mock ignores auth)
wrangler secret put SAP_CLIENT_SECRET    # any value
```

Then in Flow Tracker admin → **SAP** tab, set mode to **mock** (optionally with the
mock base URL). The outbound consumer will PUT cases to the mock; `/trigger-status`
flips issue status back through the inbound webhook.
