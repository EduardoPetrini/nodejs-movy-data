/**
 * Maps MySQL column type base names (lowercase, without length/precision) to PostgreSQL types.
 * Special cases (e.g. tinyint(1) → boolean) are resolved before stripping precision.
 */
export const MYSQL_TO_POSTGRES_TYPE_MAP: Readonly<Record<string, string>> = {
  // Exact matches first (including length — resolved before normalisation)
  'tinyint(1)': 'boolean',

  // Integer types
  tinyint: 'smallint',
  smallint: 'smallint',
  mediumint: 'integer',
  int: 'integer',
  integer: 'integer',
  bigint: 'bigint',

  // Floating point
  float: 'real',
  double: 'double precision',
  'double precision': 'double precision',

  // Fixed-point (precision preserved by caller)
  decimal: 'numeric',
  numeric: 'numeric',

  // Character
  char: 'char',
  varchar: 'varchar',
  'character varying': 'varchar',

  // Binary
  binary: 'bytea',
  varbinary: 'bytea',
  tinyblob: 'bytea',
  blob: 'bytea',
  mediumblob: 'bytea',
  longblob: 'bytea',

  // Text
  tinytext: 'text',
  text: 'text',
  mediumtext: 'text',
  longtext: 'text',

  // Date / time
  date: 'date',
  time: 'time',
  datetime: 'timestamp without time zone',
  timestamp: 'timestamp with time zone',
  year: 'integer',

  // JSON
  json: 'jsonb',

  // Enum / set (simplified — enum values captured separately)
  enum: 'text',
  set: 'text',

  // Bit
  bit: 'bit',
};
