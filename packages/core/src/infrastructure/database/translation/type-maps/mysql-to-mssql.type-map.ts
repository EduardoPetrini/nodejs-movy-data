/**
 * Maps MySQL column type base names (lowercase, without length/precision) to MSSQL types.
 * Special cases (e.g. tinyint(1) → bit) are resolved before stripping precision.
 * Precision is preserved by the caller for nchar, nvarchar, binary, varbinary, decimal, numeric.
 */
export const MYSQL_TO_MSSQL_TYPE_MAP: Readonly<Record<string, string>> = {
  // Exact matches first (including length — resolved before normalisation)
  'tinyint(1)': 'bit',

  // Integer types
  tinyint: 'tinyint',
  smallint: 'smallint',
  mediumint: 'int',
  int: 'int',
  integer: 'int',
  bigint: 'bigint',
  year: 'smallint',

  // Floating point
  float: 'real',
  double: 'float',
  'double precision': 'float',

  // Fixed-point (precision preserved by caller)
  decimal: 'decimal',
  numeric: 'numeric',

  // Character (precision preserved by caller for nchar/nvarchar)
  char: 'nchar',
  varchar: 'nvarchar',
  'character varying': 'nvarchar',
  tinytext: 'nvarchar(max)',
  text: 'nvarchar(max)',
  mediumtext: 'nvarchar(max)',
  longtext: 'nvarchar(max)',

  // Binary (precision preserved by caller for binary/varbinary)
  binary: 'binary',
  varbinary: 'varbinary',
  tinyblob: 'varbinary(max)',
  blob: 'varbinary(max)',
  mediumblob: 'varbinary(max)',
  longblob: 'varbinary(max)',

  // Date / time
  date: 'date',
  time: 'time',
  datetime: 'datetime2',
  timestamp: 'datetimeoffset',

  // JSON / enum / set
  json: 'nvarchar(max)',
  enum: 'nvarchar(255)',
  set: 'nvarchar(255)',

  // Bit (MySQL bit field — different from tinyint(1) boolean)
  bit: 'bit',
};
