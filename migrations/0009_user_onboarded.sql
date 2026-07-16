-- Track the one-time onboarding email. onboarded_at is NULL until a user's first
-- sign-in, when sendOnboardingIfNeeded() (wired into Better Auth's
-- session.create.after hook, src/auth.ts) atomically stamps it and sends the
-- welcome email exactly once. Single ALTER (no trigger) so
-- `wrangler d1 migrations apply --remote` applies it cleanly.
ALTER TABLE "user" ADD COLUMN onboarded_at INTEGER;
