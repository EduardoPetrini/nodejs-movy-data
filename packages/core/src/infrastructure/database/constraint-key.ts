import { ConstraintSchema } from '../../domain/types/schema.types.js';

/**
 * The identity a schema diff matches a constraint by.
 *
 * A primary key is matched by type, because a table has exactly one and its
 * name is the least portable thing about it: MySQL calls every one `PRIMARY`,
 * PostgreSQL `<table>_pkey`. By name, every cross-engine re-run dropped the
 * destination's key and re-added it, which PostgreSQL refuses while a foreign
 * key depends on it and MySQL refuses under an AUTO_INCREMENT column.
 *
 * Its ordered columns are part of the identity: two keys over different
 * columns are a replacement, never the same key, or a destination keyed on
 * `(id)` would keep refusing rows a source keyed on `(tenant_id, id)` allows.
 */
export function constraintKey(c: ConstraintSchema): string {
  return c.type === 'PRIMARY KEY' ? `PRIMARY KEY (${c.columns.join(',')})` : c.name;
}
