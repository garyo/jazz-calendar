#!/bin/sh
# The scraper's launchd (macOS) jobs. With no arguments, the daily scrape-and-publish: pulls
# the latest main first (uv run then syncs dependencies; if the pull fails, scrapes with the
# code already here), then runs `jazzcal run --publish`. With arguments, runs that jazzcal
# command on the code already here: `run.sh refresh` every few minutes republishes approved
# submissions. Reads secrets from an env file kept outside the repo, so the plists hold no
# secrets. With NTFY_USER/NTFY_PASS set, the first failure of a command in a row posts the end
# of its output to the ntfy topic, and its next success says it recovered; failures between
# stay quiet, so a broken commit can't alert every 10 minutes.
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

# notify TITLE PRIORITY TAG: posts stdin to the ntfy topic, when it's configured.
notify() {
  [ -n "${NTFY_USER:-}" ] && [ -n "${NTFY_PASS:-}" ] || return 0
  curl --silent --show-error --max-time 15 \
    --user "$NTFY_USER:$NTFY_PASS" \
    --header "Title: Boston Jazz Calendar: $1" \
    --header "Priority: $2" \
    --header "Tags: $3" \
    --data-binary @- \
    "${NTFY_URL:-https://ntfy.oberbrunner.com}/${NTFY_TOPIC:-misc}" >/dev/null ||
    echo "ntfy notification failed" >&2
}

# Marks a command that's failing, so only its first failure in a row alerts.
failing="${JAZZCAL_VAR:-var}/failing-$1"
if [ "$status" -eq 0 ]; then
  if [ -e "$failing" ]; then
    rm -f "$failing"
    echo "jazzcal $1 succeeded again." | notify "jazzcal $1 recovered" default white_check_mark
  fi
elif [ ! -e "$failing" ]; then
  mkdir -p "$(dirname "$failing")"
  touch "$failing"
  { tail -n 15 "$output"; echo; echo "Further failures stay quiet until it succeeds."; } |
    notify "jazzcal $1 failed (exit $status)" high warning
fi
exit "$status"
