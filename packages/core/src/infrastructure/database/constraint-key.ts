import { ConstraintSchema } from '../../domain/types/schema.types.js';

/**
 * The identity a schema diff matches a constraint by.
 *
 * A primary key is matched by type, because a table has exactly one and its
 * name is the least portable thing about it: MySQL calls every one `PRIMARY`,
 * PostgreSQL `<table>_pkey`. By name, every cross-engine re-run dropped the
 * destination's key and re-added it, which PostgreSQL refuses while a foreign
 * key depends on it and MySQL refuses under an AUTO_INCREMENT column.
 */
export function constraintKey(c: ConstraintSchema): string {
  return c.type === 'PRIMARY KEY' ? 'PRIMARY KEY' : c.name;
}
