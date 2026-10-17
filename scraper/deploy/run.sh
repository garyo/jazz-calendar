#!/bin/sh
# The scraper's launchd (macOS) jobs. With no arguments, the daily scrape-and-publish: pulls
# the latest main first (uv run then syncs dependencies; if the pull fails, scrapes with the
# code already here), then runs `jazzcal run --publish`. With arguments, runs that jazzcal
# command on the code already here: `run.sh refresh` every few minutes republishes approved
# submissions. Reads secrets from an env file kept outside the repo, so the plists hold no
# secrets. If the command fails and NTFY_USER/NTFY_PASS are set, posts the end of its output
# to the ntfy topic.
set -eu
ENV_FILE="${JAZZCAL_ENV_FILE:-$HOME/.config/jazzcal/env}"
set -a
. "$ENV_FILE"
set +a
cd "$(dirname "$0")/.."
if [ "$#" -eq 0 ]; then
  git pull --ff-only --quiet || echo "git pull failed; running the code already checked out" >&2
  set -- run --publish
fi

output=$(mktemp)
trap 'rm -f "$output"' EXIT
status=0
"$HOME/.local/bin/uv" run --frozen jazzcal "$@" >"$output" 2>&1 || status=$?
cat "$output"

if [ "$status" -ne 0 ] && [ -n "${NTFY_USER:-}" ] && [ -n "${NTFY_PASS:-}" ]; then
  tail -n 15 "$output" | curl --silent --show-error --max-time 15 \
    --user "$NTFY_USER:$NTFY_PASS" \
    --header "Title: Boston Jazz Calendar: jazzcal $1 failed (exit $status)" \
    --header "Priority: high" \
    --header "Tags: warning" \
    --data-binary @- \
    "${NTFY_URL:-https://ntfy.oberbrunner.com}/${NTFY_TOPIC:-misc}" >/dev/null ||
    echo "ntfy notification failed" >&2
fi
exit "$status"
