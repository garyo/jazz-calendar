#!/bin/sh
# Daily scrape-and-publish for launchd (macOS). Reads secrets from an env file kept outside
# the repo, so the plist itself holds no secrets.
set -eu
ENV_FILE="${JAZZCAL_ENV_FILE:-$HOME/.config/jazzcal/env}"
set -a
. "$ENV_FILE"
set +a
cd "$(dirname "$0")/.."
exec "$HOME/.local/bin/uv" run --frozen jazzcal run --publish
