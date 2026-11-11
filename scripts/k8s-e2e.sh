#!/usr/bin/env bash
# Host Playwright against the kind release that `pnpm k8s:up` installed.
# Arguments go to Playwright: `pnpm k8s:e2e live-migration`.
#
# The console is port-forwarded, so it is http://localhost to the browser and
# the Secure session cookie sticks: the same reason Compose's e2e shares web's
# network namespace. MOVY_K8S_PORT picks another local port when 3000 is taken.
#
# A port-forward to a Service holds ONE pod. If that web pod goes away (a
# rolling restart), the forward dies with it; a spec that restarts web has to
# open its own.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/k8s-env.sh
require_tools kind kubectl
require_cluster

PORT="${MOVY_K8S_PORT:-3000}"
BASE_URL="http://localhost:$PORT"
if curl -s -o /dev/null "$BASE_URL"; then
  echo "something already answers on $BASE_URL (a dev server, pnpm docker:up?)." >&2
  echo "stop it, or pick another port: MOVY_K8S_PORT=3300 pnpm k8s:e2e" >&2
  exit 69
fi

LOG="$(mktemp "${TMPDIR:-/tmp}/movy-port-forward.XXXXXX")"
# kubectl itself, not the kc function: a backgrounded function is a subshell,
# and killing that on exit would leave the forward holding the port.
kubectl --context "$KUBE_CONTEXT" -n "$K8S_NAMESPACE" port-forward "svc/$HELM_RELEASE-web" "$PORT:3000" >"$LOG" 2>&1 &
FORWARD=$!
trap 'kill "$FORWARD" 2>/dev/null || true; rm -f "$LOG"' EXIT

for _ in $(seq 1 30); do
  curl -sf -o /dev/null "$BASE_URL/api/health" && break
  if ! kill -0 "$FORWARD" 2>/dev/null; then
    echo "port-forward exited:" >&2; cat "$LOG" >&2; exit 1
  fi
  sleep 1
done
curl -sf -o /dev/null "$BASE_URL/api/health" || { echo "console not answering on $BASE_URL" >&2; cat "$LOG" >&2; exit 1; }

cd apps/web
MOVY_E2E_EXTERNAL_SERVER=1 MOVY_E2E_LIVE=1 MOVY_E2E_K8S=1 MOVY_E2E_BASE_URL="$BASE_URL" \
  MOVY_KUBE_CONTEXT="$KUBE_CONTEXT" MOVY_K8S_NAMESPACE="$K8S_NAMESPACE" \
  pnpm exec playwright test "$@"
