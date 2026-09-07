/**
 * Maps PostgreSQL column type base names (lowercase, without length/precision) to MSSQL types.
 * Precision is preserved by the caller for nchar, nvarchar, numeric, decimal, real, float.
 *
 * Serial types are mapped to their base integer equivalents; IDENTITY is handled by the
 * schema synchronizer separately.
 */
export const POSTGRES_TO_MSSQL_TYPE_MAP: Readonly<Record<string, string>> = {
  // Boolean
  boolean: 'bit',
  bool: 'bit',

  // Integer types
  smallint: 'smallint',
  int2: 'smallint',
  integer: 'int',
  int: 'int',
  int4: 'int',
  bigint: 'bigint',
  int8: 'bigint',
  serial: 'int',
  smallserial: 'smallint',
  bigserial: 'bigint',

  // Floating point
  real: 'real',
  float4: 'real',
  'double precision': 'float',
  float8: 'float',

  // Fixed-point (precision preserved by caller)
  numeric: 'numeric',
  decimal: 'decimal',
  money: 'decimal(19,4)',

  // Character (precision preserved by caller for nchar/nvarchar)
  char: 'nchar',
  character: 'nchar',
  varchar: 'nvarchar',
  'character varying': 'nvarchar',
  text: 'nvarchar(max)',
  name: 'nvarchar(128)',

  // Binary
  bytea: 'varbinary(max)',

  // Date / time
  date: 'date',
  time: 'time',
  'time without time zone': 'time',
  timestamp: 'datetime2',
  'timestamp without time zone': 'datetime2',
  'timestamp with time zone': 'datetimeoffset',
  timestamptz: 'datetimeoffset',
  interval: 'nvarchar(50)',

  // Unique / structured
  uuid: 'uniqueidentifier',
  jsonb: 'nvarchar(max)',
  json: 'nvarchar(max)',
  xml: 'xml',
  bit: 'bit',
};
