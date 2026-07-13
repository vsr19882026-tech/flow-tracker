#!/usr/bin/env bash
# second-opinion — an advisory PR review by Codex, playing the on-call engineer
# at 2am. Reads a unified diff (path arg, default stdin), asks Codex for the top
# risks, and prints the review to stdout.
#
# ADVISORY ONLY. This never fails: if no OPENAI_API_KEY is configured (the job
# is "dormant"), the diff is empty, or Codex errors, it prints nothing and exits
# 0 so the CI job stays green and never blocks a merge. The caller comments the
# output on the PR only when this produced a non-empty review.
#
# CODEX_CMD overrides the Codex invocation (used to stub it in tests). MAX_BYTES
# caps how much diff is sent (token + arg-length safety).
set -uo pipefail

DIFF_FILE="${1:-/dev/stdin}"
CODEX_CMD="${CODEX_CMD:-npx --yes @openai/codex}"
MAX_BYTES="${MAX_BYTES:-60000}"

PROMPT='Review this PR diff as if you were the on-call engineer at 2am. List the top 3 risks if this ships as-is. Be concrete: file:line. If nothing is risky, say so.'

if [ -z "${OPENAI_API_KEY:-}" ]; then
	echo "second-opinion: OPENAI_API_KEY not configured — dormant, skipping." >&2
	exit 0
fi

diff_content="$(head -c "$MAX_BYTES" "$DIFF_FILE")"
if [ -z "$diff_content" ]; then
	echo "second-opinion: empty diff — nothing to review." >&2
	exit 0
fi

input="$(printf '%s\n\n--- BEGIN PR DIFF ---\n%s\n--- END PR DIFF ---\n' "$PROMPT" "$diff_content")"

# Codex runs non-interactively and read-only (it must not edit files or run
# commands — it only reads the diff and answers). Capture stdout; on any failure
# emit nothing and exit 0 so the job stays advisory.
if review="$($CODEX_CMD exec --skip-git-repo-check --sandbox read-only "$input" 2>second-opinion.err)"; then
	printf '%s\n' "$review"
else
	echo "second-opinion: Codex run failed (advisory, ignoring):" >&2
	cat second-opinion.err >&2 || true
	exit 0
fi
