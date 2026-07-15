-- Multi-feature schema: the serial choke-point every parallel feature depends on.
-- Adds the projects, comments, and attachments tables, links issues to a project
-- (nullable for backwards-compat), and gives Better Auth's "user" table a role.
-- App tables use snake_case columns + INTEGER epoch-ms timestamps, matching 0001.

-- projects — a container issues can belong to.
CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES "user"(id),
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- comments — threaded discussion on an issue.
CREATE TABLE comments (
  id         TEXT PRIMARY KEY,
  issue_id   TEXT NOT NULL REFERENCES issues(id),
  author_id  TEXT NOT NULL REFERENCES "user"(id),
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- attachments — R2-backed files on an issue. r2_key is the object key in the
-- ATTACHMENTS bucket; the row is the metadata index.
CREATE TABLE attachments (
  id          TEXT PRIMARY KEY,
  issue_id    TEXT NOT NULL REFERENCES issues(id),
  uploader_id TEXT NOT NULL REFERENCES "user"(id),
  r2_key      TEXT NOT NULL,
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Link an issue to a project. Nullable so existing issues (no project) stay valid.
-- SQLite allows ADD COLUMN with a REFERENCES clause only when the default is NULL.
ALTER TABLE issues ADD COLUMN project_id TEXT REFERENCES projects(id);

-- Better Auth: give every user a role. Default 'member' so existing rows and new
-- magic-link sign-ups get a role without any application-code change.
ALTER TABLE "user" ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
