#!/usr/bin/env bash
# Sets the number of large-class runners: `pnpm docker:scale 1`, `pnpm docker:scale 0`.
# Scaling down stops runners gracefully: each drains its live runs first.
set -euo pipefail
cd "$(dirname "$0")/.."
N="${1:-}"
[[ "$N" =~ ^[0-9]+$ ]] || { echo "usage: pnpm docker:scale <replicas>" >&2; exit 64; }
docker compose up -d --no-recreate --scale "runner-large=$N" runner-large
