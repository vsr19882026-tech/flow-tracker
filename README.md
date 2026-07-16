# Flow Tracker

A lightweight issue tracker for the team, running on Cloudflare Workers
(Hono + D1 + KV + R2 + Email). Live at **https://tracker.shravyalabs.com**.

## Getting started

Sign in with your work email — request a magic link at the site and click it.
The first time you sign in you'll get a short welcome email.

## Everyday tasks

- **File an issue.** `POST /issues` with a JSON body: `title` (required), plus
  optional `description`, `priority` (`low`/`medium`/`high`), and `project`.
- **See your team's issues.** `GET /issues` lists them; `GET /issues/<number>`
  opens a single issue.
- **Mention a teammate.** Comment on an issue with
  `POST /issues/<number>/comments` and @name whoever should weigh in.

## Roles

Everyone starts as a **member** (can read and file issues). **Admins** get the
`/admin` surface: team users, invites, projects, the audit log, and CSV/JSON
export.

## For contributors

Working on the code? Read [CLAUDE.md](./CLAUDE.md) — it defines the stack, the
bindings, and the hard rules (remote-only migrations, no swallowed errors,
test-first routes, ship workflow).
