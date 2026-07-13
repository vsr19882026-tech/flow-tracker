---
description: Tail production for ~60s (errors only) and summarize distinct error signatures, counts, and suspected routes
---

Capture a short window of production errors and analyze them.

1. **Capture ~60 seconds of error-only logs.** Run
   `wrangler tail flow-tracker --format pretty --status error` and let it run for
   about 60 seconds, writing all output to a file (e.g. `tail-errors.log`). Start
   it detached/in the background so the window can be bounded, then stop it after
   ~60 seconds. `--status error` filters to invocations whose outcome is an
   exception, so a handler that throws (e.g. a 500) shows here; a plain 4xx/5xx
   *response* does not.

2. **Read the captured file** once the window closes.

3. **Analyze and report.** Produce:
   - **Distinct error signatures** — group by the exception/error message (plus
     the top stack frame if one is present). Each distinct message is one
     signature.
   - **Count** — how many times each signature occurred in the window.
   - **Suspected route** — the `METHOD /path` on the invocation line most
     associated with each signature.

   Present it as a short table or list, most frequent first.

4. If the window captured no errors, report exactly: `No errors observed in the
   60s window.`

Notes:
- Never leave a `wrangler tail` process running after the window; always stop it.
- This is read-only observability — do not change code or deploy from `/tail`.
