#!/usr/bin/env bash
# A local Kubernetes Movy: a kind cluster, KEDA, both images, and the chart with
# values-kind.yaml (bundled meta-db, seeded lab). Safe to re-run: it reuses the
# cluster and upgrades the release, so a code change is `pnpm k8s:up` again.
#
#   pnpm k8s:up
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/k8s-env.sh
require_tools docker kind kubectl helm

if kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
  echo "== kind cluster \"$KIND_CLUSTER\" exists, reusing it"
else
  echo "== creating kind cluster \"$KIND_CLUSTER\""
  kind create cluster --name "$KIND_CLUSTER" --config "$KIND_CONFIG" --wait 120s
fi

echo "== KEDA $KEDA_VERSION"
helm repo add kedacore https://kedacore.github.io/charts --force-update >/dev/null
hm upgrade --install keda kedacore/keda --version "$KEDA_VERSION" \
  --namespace keda --create-namespace --wait --timeout 5m

# The chart cannot read files outside itself; keep its copy current.
bash scripts/k8s-sync-fixtures.sh

echo "== building images (runtime, build)"
docker build -f docker/Dockerfile --target runtime -t movy:kind .
docker build -f docker/Dockerfile --target build -t movy-build:kind .

# A tag per build, never a reused one: kind's node keeps the image it has under
# a tag, and a Deployment whose spec did not change never rolls. The runtime
# image's id names both, so a rebuild that changed nothing changes nothing.
TAG="kind-$(docker image inspect -f '{{.Id}}' movy:kind | sed 's/^sha256://' | cut -c1-12)"
docker tag movy:kind "movy:$TAG"
docker tag movy-build:kind "movy-build:$TAG"
echo "== loading movy:$TAG and movy-build:$TAG into the node"
kind load docker-image --name "$KIND_CLUSTER" "movy:$TAG" "movy-build:$TAG"

echo "== helm upgrade --install $HELM_RELEASE"
# --wait covers the migrate Job and the seed hook as well as the pods. The lab's
# SQL Server is the slow part (an image pull under emulation on Apple Silicon).
hm upgrade --install "$HELM_RELEASE" "$CHART" \
  --namespace "$K8S_NAMESPACE" --create-namespace \
  -f "$CHART/values-kind.yaml" \
  --set "image.tag=$TAG" --set "toolsImage.tag=$TAG" \
  --wait --timeout 20m

echo "== waiting for rollouts"
for workload in $(kc -n "$K8S_NAMESPACE" get deployment,statefulset -o name); do
  kc -n "$K8S_NAMESPACE" rollout status "$workload" --timeout 10m
done

cat <<DONE

Movy is up on kind (context $KUBE_CONTEXT, namespace $K8S_NAMESPACE, images $TAG).
  console:  kubectl --context $KUBE_CONTEXT -n $K8S_NAMESPACE port-forward svc/$HELM_RELEASE-web 3000
            then http://localhost:3000 (editor@movy.local / movy-dev)
  e2e:      pnpm k8s:e2e
  remove:   pnpm k8s:down
DONE
