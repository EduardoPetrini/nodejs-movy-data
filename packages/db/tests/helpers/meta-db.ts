import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = join(__dirname, '../../migrations');

/** The migration files in the order drizzle-kit applies them. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * An in-memory PostgreSQL with the real migrations applied — not a hand-written
 * schema, so a test of the queue SQL is a test against what production runs.
 * `upTo` stops after the named file, to seed data an older schema would hold.
 */
export async function freshMetaDb(upTo?: string): Promise<PGlite> {
  const db = new PGlite();
  for (const file of migrationFiles()) {
    await applyMigration(db, file);
    if (file === upTo) break;
  }
  return db;
}

export async function applyMigration(db: PGlite, file: string): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--> statement-breakpoint/g, '');
  await db.exec(sql);
}
