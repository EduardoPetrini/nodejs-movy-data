/**
 * Maps PostgreSQL column type base names (lowercase) to MySQL types.
 * Precision is preserved by the caller for decimal/numeric, char, varchar.
 */
export const POSTGRES_TO_MYSQL_TYPE_MAP: Readonly<Record<string, string>> = {
  // Boolean
  boolean: 'tinyint(1)',
  bool: 'tinyint(1)',

  // Integer types
  smallint: 'smallint',
  int2: 'smallint',
  smallserial: 'smallint',
  integer: 'int',
  int: 'int',
  int4: 'int',
  serial: 'int',
  bigint: 'bigint',
  int8: 'bigint',
  bigserial: 'bigint',

  // Floating point
  real: 'float',
  float4: 'float',
  'double precision': 'double',
  float8: 'double',
  float: 'double',

  // Fixed-point (precision preserved by caller)
  numeric: 'decimal',
  decimal: 'decimal',

  // Character
  char: 'char',
  'character': 'char',
  varchar: 'varchar',
  'character varying': 'varchar',

  // Text
  text: 'longtext',

  // Binary
  bytea: 'longblob',

  // Date / time
  date: 'date',
  time: 'time',
  'time without time zone': 'time',
  'time with time zone': 'time',
  timestamp: 'datetime',
  'timestamp without time zone': 'datetime',
  'timestamp with time zone': 'datetime',
  timestamptz: 'datetime',

  // UUID
  uuid: 'char(36)',

  // JSON
  json: 'json',
  jsonb: 'json',

  // Bit
  bit: 'bit',

  // Lossy conversions
  interval: 'varchar(255)',
  inet: 'varchar(45)',
  cidr: 'varchar(43)',
  macaddr: 'varchar(17)',
  xml: 'longtext',
};
