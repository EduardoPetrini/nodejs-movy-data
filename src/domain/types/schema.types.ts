export interface ColumnSchema {
  name: string;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  characterMaxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
}

export interface ConstraintSchema {
  name: string;
  type: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK';
  columns: string[];
  // Foreign key specifics
  referencedTable?: string;
  referencedColumns?: string[];
  onDelete?: string;
  onUpdate?: string;
  // Check constraint specifics
  checkExpression?: string;
}

export interface IndexSchema {
  name: string;
  columns: string[];
  isUnique: boolean;
  method: string; // btree, hash, gin, gist, etc.
}

export interface TableSchema {
  name: string;
  columns: ColumnSchema[];
  constraints: ConstraintSchema[];
  indexes: IndexSchema[];
}

export interface SequenceSchema {
  name: string;
  startValue: number;
  minValue: number;
  maxValue: number;
  incrementBy: number;
  cycleOption: boolean;
  lastValue: number | null;
}

export interface DatabaseSchema {
  tables: TableSchema[];
  sequences: SequenceSchema[];
}
