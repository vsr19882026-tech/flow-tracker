-- SAP Cloud ALM ITSM integration schema.
--
-- Plain CREATE TABLE / INSERT only — no triggers. 0005's trigger broke the
-- `wrangler d1 migrations apply --remote` file splitter on the semicolon inside
-- the trigger body (SQLITE_ERROR 7500); this file stays splitter-safe.
--
-- JSON-bearing columns are declared TEXT (SQLite has no JSON type; JSON is
-- stored as TEXT), matching audit_log.diff in 0007. Declaring them `JSON` also
-- trips the diff-review schema parser, which expects a known affinity keyword.

-- Outbox: durable queue of issue changes awaiting sync to SAP. One row per
-- change; a producer drains status='pending' rows to the sap-outbound queue.
CREATE TABLE sap_outbox (
  id         TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL,
  issue_id   TEXT NOT NULL REFERENCES issues(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated')),
  payload    TEXT NOT NULL, -- JSON snapshot of the change, stored as TEXT
  status     TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'dead')) DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE INDEX sap_outbox_status_created ON sap_outbox (status, created_at);

-- Link table: the SAP case an issue is mapped to, plus sync bookkeeping.
CREATE TABLE sap_links (
  issue_id       TEXT PRIMARY KEY REFERENCES issues(id),
  sap_case_id    TEXT,
  external_ref   TEXT,
  last_seq_sent  INTEGER,
  last_change_id TEXT,
  updated_at     INTEGER NOT NULL
);

-- Field mapping: flow-tracker field <-> SAP case field, per direction.
CREATE TABLE sap_field_map (
  flow_field TEXT NOT NULL,
  sap_field  TEXT NOT NULL,
  direction  TEXT NOT NULL CHECK (direction IN ('outbound', 'inbound', 'both')),
  transform  TEXT,
  active     INTEGER NOT NULL DEFAULT 1
);

-- Status mapping: flow-tracker status <-> SAP ITSM case status, per direction.
CREATE TABLE sap_status_map (
  flow_status TEXT NOT NULL,
  sap_status  TEXT NOT NULL,
  direction   TEXT NOT NULL
);

-- Sync watermarks (e.g. last inbound change cursor pulled from SAP).
CREATE TABLE sync_state (
  key       TEXT PRIMARY KEY,
  watermark TEXT
);

-- Per-project opt-in flag for SAP sync.
ALTER TABLE projects ADD COLUMN sap_synced INTEGER NOT NULL DEFAULT 0;

-- Agreed default field mapping (title->subject, description->description,
-- status->status both-ways, issue_number->externalReference outbound).
INSERT INTO sap_field_map (flow_field, sap_field, direction, transform, active) VALUES
  ('title', 'subject', 'both', NULL, 1),
  ('description', 'description', 'both', NULL, 1),
  ('status', 'status', 'both', NULL, 1),
  ('issue_number', 'externalReference', 'outbound', NULL, 1);

-- Agreed default status mapping (both-ways).
INSERT INTO sap_status_map (flow_status, sap_status, direction) VALUES
  ('open', 'New', 'both'),
  ('in_progress', 'In Process', 'both'),
  ('done', 'Completed', 'both');
