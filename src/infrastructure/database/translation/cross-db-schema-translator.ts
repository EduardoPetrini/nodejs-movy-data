import { ISchemaTranslator } from '../../../domain/ports/schema-translator.port';
import { DatabaseType } from '../../../domain/types/connection.types';
import { ConstraintSchema } from '../../../domain/types/schema.types';
import { DefaultValueTranslator } from './default-value.translator';

/**
 * Strips length/precision from a type string, returning only the base name.
 * e.g. "varchar(255)" → "varchar", "decimal(10,2)" → "decimal"
 */
export function normaliseTypeName(sourceType: string): string {
  return sourceType.trim().toLowerCase().replace(/\s*\(.*\)$/, '');
}

/**
 * Extracts the precision/scale suffix from a type string, if present.
 * e.g. "decimal(10,2)" → "(10,2)", "varchar(255)" → "(255)", "text" → ""
 */
export function extractPrecisionSuffix(sourceType: string): string {
  const match = sourceType.match(/(\([\d,\s]+\))$/);
  return match ? match[1] : '';
}

/**
 * Types that support precision/scale suffix propagation from source to mapped target.
 */
const PRECISION_PROPAGATING_TARGETS = new Set([
  'numeric', 'decimal', 'char', 'varchar', 'character varying', 'bit',
]);

/**
 * Abstract base class for cross-database schema translators.
 *
 * Subclasses provide a type map and a default-value translator.
 * Constraint structure is DB-agnostic, so it passes through unchanged.
 */
export abstract class CrossDbSchemaTranslator implements ISchemaTranslator {
  protected abstract readonly typeMap: Readonly<Record<string, string>>;
  protected abstract readonly defaultValueTranslator: DefaultValueTranslator;

  translateColumnType(
    sourceType: string,
    _sourceDbType: DatabaseType,
    _destDbType: DatabaseType
  ): string {
    const lower = sourceType.trim().toLowerCase();

    // 1. Exact match (handles special cases like "tinyint(1)")
    if (lower in this.typeMap) {
      return this.typeMap[lower];
    }

    // 2. Normalised (base name without precision) lookup
    const base = normaliseTypeName(sourceType);
    if (base in this.typeMap) {
      const mapped = this.typeMap[base];
      // Propagate precision suffix to target when the target type supports it
      if (PRECISION_PROPAGATING_TARGETS.has(mapped)) {
        const suffix = extractPrecisionSuffix(sourceType);
        if (suffix) return `${mapped}${suffix}`;
      }
      return mapped;
    }

    // 3. Fall back to original type (unknown types pass through)
    return sourceType;
  }

  translateDefaultValue(
    defaultExpr: string,
    sourceDbType: DatabaseType,
    destDbType: DatabaseType
  ): string {
    if (!defaultExpr) return defaultExpr;
    return this.defaultValueTranslator.translate(defaultExpr, sourceDbType, destDbType);
  }

  translateConstraint(
    constraint: ConstraintSchema,
    _sourceDbType: DatabaseType,
    _destDbType: DatabaseType
  ): ConstraintSchema {
    // Constraint structure (columns, references, actions) is DB-agnostic.
    // Column types are translated separately at the column level.
    return constraint;
  }
}
