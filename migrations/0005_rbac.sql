-- RBAC: project membership + role-based authorization.
--
-- user.role already exists (0003) with DEFAULT 'member'. The spec asks for a
-- CHECK (role IN ('admin','member','viewer')) on it, but SQLite cannot add a
-- CHECK to an existing column without rebuilding the whole Better Auth "user"
-- table (6 live rows + inbound FKs from session/account/issues/projects/
-- comments/attachments). That rewrite is not worth the risk, so the user.role
-- invariant is enforced at the app layer (src/lib/authz.ts). The NEW
-- project_members.role below DOES carry its CHECK at the DB level.

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id    TEXT NOT NULL REFERENCES "user"(id),
  role       TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  PRIMARY KEY (project_id, user_id)
);

-- Creating a project makes its creator an 'owner' member. AFTER INSERT so the
-- projects row exists (FK) before the membership row is written.
CREATE TRIGGER project_owner_membership
AFTER INSERT ON projects
BEGIN
  INSERT INTO project_members (project_id, user_id, role)
  VALUES (NEW.id, NEW.owner_id, 'owner');
END;

-- Backfill: projects created before this trigger get their owner membership.
-- Idempotent via NOT EXISTS so a re-run cannot double-insert.
INSERT INTO project_members (project_id, user_id, role)
SELECT id, owner_id, 'owner'
FROM projects
WHERE NOT EXISTS (
  SELECT 1 FROM project_members pm
  WHERE pm.project_id = projects.id AND pm.user_id = projects.owner_id
);
