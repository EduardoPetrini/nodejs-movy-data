# Shared by the k8s-*.sh scripts. Sourced, never run.
#
# Every kubectl and helm call names the kind context explicitly, so these
# scripts can never act on whatever cluster the current context points at.
KIND_CLUSTER="${MOVY_KIND_CLUSTER:-movy}"
KUBE_CONTEXT="kind-${KIND_CLUSTER}"
K8S_NAMESPACE=movy
HELM_RELEASE=movy
KEDA_VERSION=2.21.0
KIND_CONFIG=deploy/kind/cluster.yaml
CHART=deploy/helm/movy

kc() { kubectl --context "$KUBE_CONTEXT" "$@"; }
hm() { helm --kube-context "$KUBE_CONTEXT" "$@"; }

require_tools() {
  local missing=()
  for tool in "$@"; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
  if ((${#missing[@]})); then
    echo "missing: ${missing[*]} (see README, Running on Kubernetes)" >&2
    exit 69
  fi
}

require_cluster() {
  if ! kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
    echo "no kind cluster \"$KIND_CLUSTER\": run pnpm k8s:up first" >&2
    exit 69
  fi
}
