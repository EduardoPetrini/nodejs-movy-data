#!/usr/bin/env bash
# Deletes the kind cluster `pnpm k8s:up` created, with everything in it: the
# meta-db's volume, the lab, the release's kept Secrets. Nothing else is touched.
#
#   pnpm k8s:down
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/k8s-env.sh
require_tools kind
kind delete cluster --name "$KIND_CLUSTER"
