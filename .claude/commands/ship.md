---
description: Ship the current branch end to end — test, commit, PR, CI, merge, deploy, smoke prod
---

Ship the current branch to production. Execute these steps in order.

**Failure policy:** if any step fails, STOP immediately and surface the error
output verbatim. Do not continue, do not work around it. Never bypass hooks
(`--no-verify`), never `git push --force`.

1. **Confirm the working tree is dirty.** Run `git status --porcelain`. If the
   output is empty, abort with exactly this message and stop: `nothing to ship`.

2. **Test until green.** Run `npm test -- --run`. If any test fails, stop and
   show the failing output.

3. **Generate types.** Run `npx wrangler types`.

4. **Commit.** Run `git add -A`, then commit with a concise message derived from
   the diff — imperative, present tense, no test plan, no Claude/Anthropic
   mention.

5. **Push.** Read the branch with `git branch --show-current`, then
   `git push -u origin <current-branch>`. Never force-push.

6. **Open a PR.** `gh pr create --title "<title>" --body "<body>"`. The body is
   at most 5 lines, present tense, no test-plan section — match the style in
   `CLAUDE.md`.

7. **Wait for CI green.** `gh pr checks <pr-number> --watch`. If CI fails, stop
   and show the failing job.

8. **Merge.** `gh pr merge <pr-number> --merge --delete-branch`.

9. **Deploy.** Check out and pull `main`, then promote a new version:
   run `wrangler versions upload`, read the version id it prints, and run
   `wrangler versions deploy <version-id>@100 --yes` to route 100% of traffic.

10. **Smoke prod.** Run
    `curl -s -o /dev/null -w "%{http_code}" https://tracker.shravyalabs.com/whoami`.
    Confirm it returns `401` — prod is up and unauthenticated `/whoami` is 401.

Report the result of each step as you go.
