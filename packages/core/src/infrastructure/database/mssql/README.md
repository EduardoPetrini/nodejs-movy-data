# MSSQL Adapter

Full MSSQL (SQL Server) support implemented via the `mssql@12` driver (wraps `tedious`).

## Files

| File | Interface | Description |
|------|-----------|-------------|
| `mssql-connection.adapter.ts` | `IDatabaseConnection` | Wraps `mssql.ConnectionPool`. Converts positional `?` params to named `@p0, @p1` inputs. |
| `mssql-schema-inspector.adapter.ts` | `ISchemaInspector` | Parallel queries to `INFORMATION_SCHEMA` + `sys.*` for columns (including IDENTITY flag), constraints, indexes. Row estimates via `sys.partitions`. |
| `mssql-schema-synchronizer.adapter.ts` | `ISchemaSynchronizer` | `[bracketed]` DDL. `IDENTITY(1,1)` syntax. `NOCHECK`/`WITH CHECK CHECK CONSTRAINT ALL` for FK control. `DBCC CHECKIDENT` for sequence reset. |
| `mssql-query-analyzer.adapter.ts` | `IQueryAnalyzer` | Creates `#movy_query_analysis` temp table via `SELECT TOP 0 INTO`, then reads `tempdb.sys.columns`. **Currently unreachable** — query migration is PostgreSQL-only, see [issue #4](https://github.com/EduardoPetrini/nodejs-movy-data/issues/4). |
| `mssql-to-postgres-translator.adapter.ts` | `ISchemaTranslator` | Type translation MSSQL → PostgreSQL using `MSSQL_TO_POSTGRES_TYPE_MAP`. |
| `mssql-to-mysql-translator.adapter.ts` | `ISchemaTranslator` | Type translation MSSQL → MySQL using `MSSQL_TO_MYSQL_TYPE_MAP`. |
| `mssql-adapter-set.ts` | `DatabaseAdapterSet` | Factory wiring all adapters. Admin database: `master`. `ensureDatabase()` via `sys.databases`. |

Cross-DB migrators live in `src/infrastructure/migration/`:
- `mssql-data-migrator.adapter.ts` — MSSQL → MSSQL (same-engine, batched SELECT/INSERT)
- `mssql-cross-db-data-migrator.ts` — All MSSQL ↔ PG and MSSQL ↔ MySQL pairs

## Supported Migration Pairs

| Source | Destination | Migrator |
|--------|-------------|---------|
| MSSQL | MSSQL | `MssqlDataMigrator` |
| MSSQL | PostgreSQL | `MssqlCrossDbDataMigrator` |
| MSSQL | MySQL | `MssqlCrossDbDataMigrator` |
| PostgreSQL | MSSQL | `MssqlCrossDbDataMigrator` |
| MySQL | MSSQL | `MssqlCrossDbDataMigrator` |

## Identifier Quoting

All identifiers use `[bracketed]` syntax (not `"double-quoted"`):

```sql
SELECT [id], [name] FROM [users]
ALTER TABLE [orders] NOCHECK CONSTRAINT ALL
```

## FK Handling

```sql
-- Disable before data load
ALTER TABLE [t] NOCHECK CONSTRAINT ALL

-- Re-enable after data load (with validation)
ALTER TABLE [t] WITH CHECK CHECK CONSTRAINT ALL
```

## IDENTITY Columns

MSSQL requires explicit opt-in to insert into identity columns:

```sql
SET IDENTITY_INSERT [table] ON
INSERT INTO [table] ([id], [col]) VALUES (1, 'x')
SET IDENTITY_INSERT [table] OFF
```

Detection query:
```sql
SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = ?
  AND COLUMNPROPERTY(OBJECT_ID(TABLE_SCHEMA + '.' + TABLE_NAME), COLUMN_NAME, 'IsIdentity') = 1
```

Only one table can have `IDENTITY_INSERT ON` at a time. Tables are processed sequentially, so this is safe.

After data load, sequences are reset via:
```sql
DBCC CHECKIDENT ('[table]', RESEED, <max_id>)
```

## Pagination

MSSQL uses `OFFSET/FETCH` syntax (SQL Server 2012+):

```sql
SELECT [col] FROM [table]
ORDER BY (SELECT NULL)
OFFSET 500 ROWS FETCH NEXT 500 ROWS ONLY
```

## Admin Connection

Admin database is `master` (equivalent to PostgreSQL's `postgres` or MySQL's `mysql`). Used for `CREATE DATABASE` operations:

```sql
-- Check existence
SELECT COUNT(*) AS db_count FROM sys.databases WHERE name = ?

-- Create
CREATE DATABASE [target_db]
```

## Type Notes

| MSSQL type | Note |
|-----------|------|
| `timestamp` / `rowversion` | Binary row-version counter, NOT a datetime — maps to `bytea`/`binary(8)` |
| `nvarchar(max)` | Requires exact map entry; `(max)` is not a numeric precision suffix |
| `bit` | Boolean-like; maps to `boolean` (PG) or `tinyint(1)` (MySQL) |
| `uniqueidentifier` | Maps to `uuid` (PG) or `char(36)` (MySQL) |
| `money` | Maps to `numeric(19,4)` (PG) or `decimal(19,4)` (MySQL) |

## Default Schema

`dbo` is used as the default schema for all introspection queries. Multi-schema databases are not currently supported.
