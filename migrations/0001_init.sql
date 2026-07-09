-- App schema: issues table.
-- NOTE: reporter_id references "user"(id) (singular) — Better Auth uses singular
-- table names. The "user" table is created in 0002_better_auth.sql; SQLite does not
-- require the referenced table to exist at CREATE TABLE time (FK is enforced at insert).
CREATE TABLE issues (
  id           TEXT PRIMARY KEY,
  reporter_id  TEXT NOT NULL REFERENCES "user"(id),
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done')),
  issue_number INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE(issue_number)
);
