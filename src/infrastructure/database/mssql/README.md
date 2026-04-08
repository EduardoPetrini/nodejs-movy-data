# MSSQL Adapter (v3)

Planned for v3. Implement the following interfaces to add MSSQL support:

- `IDatabaseConnection` → `mssql-connection.adapter.ts` using `mssql` (wraps `tedious`)
- `ISchemaInspector` → `mssql-schema-inspector.adapter.ts` using `sys.*` catalog views
- `ISchemaSynchronizer` → `mssql-schema-synchronizer.adapter.ts` (bracketed identifiers, IDENTITY_INSERT)
- `ISchemaTranslator` → `mssql-schema-translator.adapter.ts` (MSSQL ↔ Postgres type mappings)
- `IDataMigrator` → `../../migration/mssql-data-migrator.adapter.ts` (BCP bulk insert via mssql Table API)
- Wire all into `mssql-adapter-set.ts` and register in `src/index.ts`

Add `mssql` to `dependencies` in `package.json`.

Note: Use `[bracketed]` identifiers instead of `"double-quoted"`. Handle `dbo` schema as default.
See `docs/implementation-plan.md` → "v3: MSSQL" for full type mappings.
