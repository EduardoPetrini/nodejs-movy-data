#!/usr/bin/env bash
# Copies the lab fixtures into the Helm chart, which cannot read files outside
# itself. docker/fixtures stays the one to edit; helm-chart.test.ts fails when
# the copy drifts.
#
#   pnpm k8s:sync-fixtures
set -euo pipefail

cd "$(dirname "$0")/.."
DEST=deploy/helm/movy/files/fixtures

rm -rf "$DEST"
mkdir -p "$DEST"
cp -R docker/fixtures/. "$DEST/"
echo "synced docker/fixtures -> $DEST"
