# Snowflake Adapter (v3)

Planned for v3. Implement the following interfaces to add Snowflake support:

- `IDatabaseConnection` → `snowflake-connection.adapter.ts` using `snowflake-sdk`
- `ISchemaInspector` → `snowflake-schema-inspector.adapter.ts` (INFORMATION_SCHEMA + SHOW commands)
- `ISchemaSynchronizer` → `snowflake-schema-synchronizer.adapter.ts` (no traditional indexes — createIndexes is a no-op)
- `ISchemaTranslator` → `snowflake-schema-translator.adapter.ts` (Snowflake ↔ Postgres type mappings)
- `IDataMigrator` → `../../migration/snowflake-data-migrator.adapter.ts` (PUT + COPY INTO via internal stage)
- Wire all into `snowflake-adapter-set.ts` and register in `src/index.ts`

Add `snowflake-sdk` to `dependencies` in `package.json`.

Notes:
- `createIndexes()` must be a no-op (Snowflake uses micro-partitions, not indexes)
- Worker count should map to warehouse size, not a fixed cap
- AUTOINCREMENT handled differently from PG sequences
See `docs/implementation-plan.md` → "v3: Snowflake" for full type mappings.
