-- Track when an invite is accepted. consumed_at is NULL for a pending invite and
-- gets stamped (epoch ms) the first time a user with that email signs in — see
-- consumeInvite() wired into Better Auth's user.create hook in src/auth.ts.
-- Single ALTER statement (no trigger) so `wrangler d1 migrations apply --remote`
-- applies it cleanly.
ALTER TABLE invites ADD COLUMN consumed_at INTEGER;
