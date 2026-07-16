-- Admin invites. A pending invite is a row here until the invitee signs in.
-- No trigger (unlike 0005) so `wrangler d1 migrations apply --remote` applies it
-- cleanly — the remote runner's statement splitter chokes only on the semicolon
-- inside a trigger body.
CREATE TABLE invites (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES "user"(id),
  created_at INTEGER NOT NULL
);
