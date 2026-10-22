/**
 * Maps MSSQL column type base names (lowercase, without length/precision) to MySQL types.
 * Exact matches (including suffix) are resolved before base-name normalisation.
 *
 * Note: MSSQL `timestamp` is a rowversion (binary counter) stored as binary(8) in MySQL.
 */
export const MSSQL_TO_MYSQL_TYPE_MAP: Readonly<Record<string, string>> = {
  // Exact matches first (resolved before normalisation)
  'nvarchar(max)': 'longtext',
  'varchar(max)': 'longtext',
  'varbinary(max)': 'longblob',
  ntext: 'longtext',
  image: 'longblob',

  // Boolean (MSSQL bit = true/false → MySQL tinyint(1))
  bit: 'tinyint(1)',

  // Integer types
  tinyint: 'tinyint',
  smallint: 'smallint',
  int: 'int',
  integer: 'int',
  bigint: 'bigint',

  // Floating point
  float: 'double',
  real: 'float',

  // Fixed-point (precision preserved by caller)
  decimal: 'decimal',
  numeric: 'decimal',
  money: 'decimal(19,4)',
  smallmoney: 'decimal(10,4)',

  // Character (precision preserved by caller for char/nchar/varchar/nvarchar)
  char: 'char',
  nchar: 'char',
  varchar: 'varchar',
  nvarchar: 'varchar',
  text: 'longtext',

  // Binary (precision preserved by caller for binary/varbinary)
  binary: 'binary',
  varbinary: 'varbinary',
  timestamp: 'binary(8)',
  rowversion: 'binary(8)',

  // Date / time
  date: 'date',
  time: 'time',
  datetime: 'datetime',
  datetime2: 'datetime',
  smalldatetime: 'datetime',
  datetimeoffset: 'datetime',

  // Unique / structured
  uniqueidentifier: 'char(36)',
  xml: 'longtext',
  sql_variant: 'text',
  hierarchyid: 'text',
  geography: 'text',
  geometry: 'text',
};
