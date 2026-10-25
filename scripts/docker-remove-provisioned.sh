#!/usr/bin/env bash
# Removes runner containers the docker provisioner started. Compose does not
# know them — they carry no Compose labels — so `docker compose down` leaves them.
set -euo pipefail
ids="$(docker ps -aq --filter label=movy.provisioned=true)"
if [[ -n "$ids" ]]; then
  # shellcheck disable=SC2086
  docker rm -f $ids >/dev/null
  echo "Removed $(echo "$ids" | wc -l | tr -d ' ') provisioned runner(s)."
fi
