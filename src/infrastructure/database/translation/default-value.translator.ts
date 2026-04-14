import { DatabaseType } from '../../../domain/types/connection.types';

export interface DefaultValueRule {
  /** Pattern matched against the trimmed, lowercased expression. */
  pattern: RegExp;
  replacement: string;
}

/**
 * Translates SQL default-value expressions between database dialects.
 *
 * Priority: exact map lookup → regex rules → return unchanged.
 */
export class DefaultValueTranslator {
  constructor(
    /** Exact matches (key: lowercased expression, value: replacement). */
    private readonly exactMap: Readonly<Record<string, string>>,
    /** Optional regex-based rules applied in order when no exact match exists. */
    private readonly regexRules: ReadonlyArray<DefaultValueRule> = []
  ) {}

  translate(expr: string, _src: DatabaseType, _dst: DatabaseType): string {
    if (!expr) return expr;
    const lower = expr.trim().toLowerCase();
    if (lower in this.exactMap) return this.exactMap[lower];
    for (const rule of this.regexRules) {
      if (rule.pattern.test(expr)) {
        return expr.replace(rule.pattern, rule.replacement);
      }
    }
    return expr;
  }
}

// ---------------------------------------------------------------------------
// Shared maps for convenience
// ---------------------------------------------------------------------------

export const MYSQL_TO_POSTGRES_DEFAULT_MAP: Readonly<Record<string, string>> = {
  'current_timestamp': 'CURRENT_TIMESTAMP',
  'now()': 'CURRENT_TIMESTAMP',
  'current_date': 'CURRENT_DATE',
  'current_time': 'CURRENT_TIME',
  '0': 'false',         // default for TINYINT(1) columns converted to boolean
  '1': 'true',
  'uuid()': 'gen_random_uuid()',
};

export const MYSQL_TO_POSTGRES_DEFAULT_RULES: ReadonlyArray<DefaultValueRule> = [
  // Strip MySQL string cast: 'value' → 'value' (already fine)
  // Remove b'' bit literals: b'0' → 0
  { pattern: /^b'(\d+)'$/i, replacement: '$1' },
];

export const POSTGRES_TO_MYSQL_DEFAULT_MAP: Readonly<Record<string, string>> = {
  'current_timestamp': 'CURRENT_TIMESTAMP',
  'now()': 'CURRENT_TIMESTAMP',
  'current_date': 'CURRENT_DATE',
  'current_time': 'CURRENT_TIME',
  'false': '0',
  'true': '1',
  'gen_random_uuid()': '(UUID())',
};

export const POSTGRES_TO_MYSQL_DEFAULT_RULES: ReadonlyArray<DefaultValueRule> = [
  // Strip PostgreSQL type casts: 'value'::text → 'value'
  { pattern: /^('.*?')::[\w\s]+$/i, replacement: '$1' },
  // Strip empty-string casts: ''::text → ''
  { pattern: /^('')::[\w\s]+$/i, replacement: '$1' },
];
