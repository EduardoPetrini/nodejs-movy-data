/**
 * Maps MSSQL column type base names (lowercase, without length/precision) to PostgreSQL types.
 * Exact matches (including suffix) are resolved before base-name normalisation.
 *
 * Note: MSSQL `timestamp` is a rowversion (binary counter), NOT a datetime type.
 */
export const MSSQL_TO_POSTGRES_TYPE_MAP: Readonly<Record<string, string>> = {
  // Exact matches first (resolved before normalisation)
  'nvarchar(max)': 'text',
  'varchar(max)': 'text',
  'varbinary(max)': 'bytea',
  ntext: 'text',
  image: 'bytea',

  // Boolean
  bit: 'boolean',

  // Integer types
  tinyint: 'smallint',
  smallint: 'smallint',
  int: 'integer',
  integer: 'integer',
  bigint: 'bigint',

  // Floating point
  float: 'double precision',
  real: 'real',

  // Fixed-point (precision preserved by caller)
  decimal: 'numeric',
  numeric: 'numeric',
  money: 'numeric(19,4)',
  smallmoney: 'numeric(10,4)',

  // Character (precision preserved by caller for char/nchar/varchar/nvarchar)
  char: 'char',
  nchar: 'char',
  varchar: 'varchar',
  nvarchar: 'varchar',
  text: 'text',

  // Binary (precision preserved by caller for varbinary)
  binary: 'bytea',
  varbinary: 'bytea',
  timestamp: 'bytea',
  rowversion: 'bytea',

  // Date / time
  date: 'date',
  time: 'time',
  datetime: 'timestamp without time zone',
  datetime2: 'timestamp without time zone',
  smalldatetime: 'timestamp without time zone',
  datetimeoffset: 'timestamp with time zone',

  // Unique / structured
  uniqueidentifier: 'uuid',
  xml: 'text',
  sql_variant: 'text',
  hierarchyid: 'text',
  geography: 'text',
  geometry: 'text',
};
