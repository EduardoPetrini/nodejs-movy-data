#!/usr/bin/env bash
# Generates the env files `docker compose` reads, with fresh secrets.
#
#   pnpm docker:init
#
# Never overwrites a file that exists: regenerating NUXT_ENCRYPTION_KEY would
# make every saved connection password undecryptable, and a new meta-db
# password would not match the volume that was initialised with the old one.
# To start over: `docker compose down -v` and delete docker/*.env.
set -euo pipefail

cd "$(dirname "$0")/.."
DIR=docker

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

# Hex, not base64, for anything that lands in a URL or a shell argument.
hex() { openssl rand -hex "$1"; }

write() {
  local file="$DIR/$1"
  if [[ -e "$file" ]]; then
    echo "  kept      $file (exists)"
    return 1
  fi
  return 0
}

META_PASSWORD=""
if write meta-db.env; then
  META_PASSWORD="$(hex 16)"
  printf 'POSTGRES_PASSWORD=%s\n' "$META_PASSWORD" > "$DIR/meta-db.env"
  echo "  created   $DIR/meta-db.env"
else
  META_PASSWORD="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$DIR/meta-db.env")"
fi

if write movy.env; then
  sed \
    -e "s|^NUXT_DATABASE_URL=.*|NUXT_DATABASE_URL=postgres://movy:${META_PASSWORD}@meta-db:5432/movy_data|" \
    -e "s|^NUXT_ENCRYPTION_KEY=.*|NUXT_ENCRYPTION_KEY=$(openssl rand -base64 32)|" \
    -e "s|^NUXT_SESSION_PASSWORD=.*|NUXT_SESSION_PASSWORD=$(hex 32)|" \
    "$DIR/movy.env.example" > "$DIR/movy.env"
  echo "  created   $DIR/movy.env"
fi

if write lab.env; then
  {
    printf 'POSTGRES_PASSWORD=%s\n' "$(hex 12)"
    printf 'MYSQL_ROOT_PASSWORD=%s\n' "$(hex 12)"
    # Upper, lower, digit and symbol: SQL Server's policy rejects anything less.
    printf 'MSSQL_SA_PASSWORD=Mv1-%s\n' "$(hex 12)"
  } > "$DIR/lab.env"
  echo "  created   $DIR/lab.env"
fi

if write cli.env; then
  PG="$(sed -n 's/^POSTGRES_PASSWORD=//p' "$DIR/lab.env")"
  MY="$(sed -n 's/^MYSQL_ROOT_PASSWORD=//p' "$DIR/lab.env")"
  sed \
    -e "s|^SOURCE_MYSQL_PASSWORD=.*|SOURCE_MYSQL_PASSWORD=${MY}|" \
    -e "s|^TARGET_POSTGRES_PASSWORD=.*|TARGET_POSTGRES_PASSWORD=${PG}|" \
    "$DIR/cli.env.example" > "$DIR/cli.env"
  echo "  created   $DIR/cli.env"
fi

chmod 600 "$DIR"/*.env
echo "Done. Next: pnpm docker:up"
