#!/bin/bash
# One-shot loader for mssql-lab. SQL Server's image has no init directory, so
# the mssql-init service runs this after mssql-lab reports healthy. The SQL is
# idempotent, so running it on every `compose up` is safe.
set -euo pipefail

SQLCMD=/opt/mssql-tools18/bin/sqlcmd

# -C trusts the container's self-signed certificate; -b exits non-zero on the
# first SQL error, so a broken fixture fails `compose up` instead of a test.
"$SQLCMD" -C -b -S mssql-lab -U sa -P "$MSSQL_SA_PASSWORD" -i /fixtures/01-shop.sql
echo "mssql-lab: movy_src ready"
