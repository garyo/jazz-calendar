#!/bin/sh
# Daily scrape-and-publish for launchd (macOS). Pulls the latest main first (uv run then
# syncs dependencies); if the pull fails, scrapes with the code already here. Reads secrets
# from an env file kept outside the repo, so the plist itself holds no secrets. If the run
# fails and NTFY_USER/NTFY_PASS are set, posts the end of its output to the ntfy topic.
set -eu
ENV_FILE="${JAZZCAL_ENV_FILE:-$HOME/.config/jazzcal/env}"
set -a
. "$ENV_FILE"
set +a
cd "$(dirname "$0")/.."
git pull --ff-only --quiet || echo "git pull failed; running the code already checked out" >&2

output=$(mktemp)
trap 'rm -f "$output"' EXIT
status=0
"$HOME/.local/bin/uv" run --frozen jazzcal run --publish >"$output" 2>&1 || status=$?
cat "$output"

if [ "$status" -ne 0 ] && [ -n "${NTFY_USER:-}" ] && [ -n "${NTFY_PASS:-}" ]; then
  tail -n 15 "$output" | curl --silent --show-error --max-time 15 \
    --user "$NTFY_USER:$NTFY_PASS" \
    --header "Title: Boston Jazz Calendar: scraper run failed (exit $status)" \
    --header "Priority: high" \
    --header "Tags: warning" \
    --data-binary @- \
    "${NTFY_URL:-https://ntfy.oberbrunner.com}/${NTFY_TOPIC:-misc}" >/dev/null ||
    echo "ntfy notification failed" >&2
fi
exit "$status"
