import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const APP_DIR = join(__dirname, '../../app');
const COMPONENTS_DIR = join(APP_DIR, 'components');
const NUXT_CONFIG = join(__dirname, '../../nuxt.config.ts');

/**
 * Components Nuxt and Vue provide. Anything else in a template has to come from
 * app/components/.
 */
const BUILT_INS = new Set([
  'NuxtPage', 'NuxtLayout', 'NuxtLink', 'NuxtLoadingIndicator', 'NuxtErrorBoundary',
  'NuxtImg', 'NuxtPicture', 'NuxtRouteAnnouncer', 'NuxtWelcome', 'NuxtClientFallback',
  'ClientOnly', 'DevOnly', 'ServerPlaceholder', 'Teleport', 'Transition',
  'TransitionGroup', 'KeepAlive', 'Suspense', 'Component',
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const vueFiles = walk(APP_DIR).filter((f) => f.endsWith('.vue'));

/** Every registrable component name, flat — which is what pathPrefix: false gives. */
const declared = new Set(
  walk(COMPONENTS_DIR)
    .filter((f) => f.endsWith('.vue'))
    .map((f) => basename(f, '.vue'))
);

/** PascalCase tags used in a template, ignoring the <script> and <style> blocks. */
function usedComponents(source: string): string[] {
  const template = source.slice(source.indexOf('<template'), source.lastIndexOf('</template>'));
  const found = template.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g);
  return [...new Set([...found].map((m) => m[1]!))];
}

describe('component resolution', () => {
  it('finds the templates at all (guards against a broken glob)', () => {
    expect(vueFiles.length).toBeGreaterThan(3);
    expect(declared.size).toBeGreaterThan(0);
  });

  /**
   * Nuxt's default `pathPrefix: true` registers components/ui/AppButton.vue as
   * <UiAppButton>. An unresolved <AppButton> is NOT an error — Vue renders it as
   * an inert custom element, so a button silently becomes unclickable text that
   * still looks roughly right. It shipped that way through a manual pass of the
   * whole login and connections UI. This turns it into a test failure.
   */
  it('resolves every component used in a template', () => {
    const unresolved = vueFiles.flatMap((file) =>
      usedComponents(readFileSync(file, 'utf8'))
        .filter((name) => !BUILT_INS.has(name) && !declared.has(name))
        .map((name) => `${basename(file)}: <${name}>`)
    );

    expect(unresolved, `unresolved components: ${unresolved.join(', ')}`).toEqual([]);
  });

  it('keeps the flat naming that makes those bare names resolve', () => {
    // The assertion above only holds while components are registered unprefixed.
    expect(readFileSync(NUXT_CONFIG, 'utf8')).toMatch(/pathPrefix:\s*false/);
  });
});
