# MySQL Adapter (v2)

Planned for v2. Implement the following interfaces to add MySQL support:

- `IDatabaseConnection` → `mysql-connection.adapter.ts` using `mysql2`
- `ISchemaInspector` → `mysql-schema-inspector.adapter.ts` using `information_schema`
- `ISchemaSynchronizer` → `mysql-schema-synchronizer.adapter.ts`
- `ISchemaTranslator` → `mysql-schema-translator.adapter.ts` (MySQL ↔ Postgres type mappings)
- `IDataMigrator` → `../../migration/mysql-data-migrator.adapter.ts` (batched INSERT, optional LOAD DATA LOCAL INFILE)
- Wire all into `mysql-adapter-set.ts` and register in `src/index.ts`

Add `mysql2` to `dependencies` in `package.json`.

See `docs/implementation-plan.md` → "v2: MySQL" for full type mappings and FK handling notes.
