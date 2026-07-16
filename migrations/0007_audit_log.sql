-- Audit log: one row per write (POST/PATCH/PUT/DELETE), written by the audit
-- middleware. Plain CREATE TABLE (no trigger) so it applies cleanly on --remote.
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  diff        TEXT, -- JSON payload; SQLite has no JSON type, JSON is stored as TEXT
  ip          TEXT,
  user_agent  TEXT,
  created_at  INTEGER NOT NULL
);

-- The admin audit page filters by actor and date, ordered by recency.
CREATE INDEX audit_log_created_at ON audit_log (created_at);
CREATE INDEX audit_log_actor_id ON audit_log (actor_id);
