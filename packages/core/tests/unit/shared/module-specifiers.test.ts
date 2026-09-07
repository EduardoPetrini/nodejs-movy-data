import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '../../../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Regression guard for the Nuxt dev-server failure.
 *
 * @movy/core is CommonJS and must stay that way (resolveWorkerPath depends on
 * __dirname). TypeScript emits relative specifiers verbatim, so an extensionless
 * './foo' compiles to require('./foo') — valid CJS, but INVALID ESM. When Nitro
 * externalised core it re-emitted those specifiers into an ESM bundle and Node
 * refused them:
 *
 *   Cannot find module '.../dist/domain/types/connection.types'
 *   Did you mean to import ".../connection.types.js"?
 *
 * Writing './foo.js' in the TypeScript source fixes it for every consumer at
 * once: TS still resolves it to foo.ts, and the emitted output is valid under
 * both CJS and ESM resolution.
 */
describe('core module specifiers', () => {
  const files = walk(SRC);

  it('finds the source files (guards against a broken walk)', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it('gives every relative import an explicit .js extension', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const pattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)(['"])(\.\.?\/[^'"]+)\1/g;

      for (const [, , specifier] of src.matchAll(pattern)) {
        if (!/\.(js|json)$/.test(specifier)) {
          offenders.push(`${file.slice(SRC.length + 1)} -> ${specifier}`);
        }
      }
    }

    expect(offenders, `extensionless relative specifiers:\n${offenders.join('\n')}`).toEqual([]);
  });

  // A directory import ('./application/events') needs no test here: the
  // compiler already rejects it once the .js extension is required, which is
  // exactly how the one instance in this codebase was found.
});
