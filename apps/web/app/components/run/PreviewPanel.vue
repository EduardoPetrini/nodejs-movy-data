<script setup lang="ts">
import type { RunPreview } from '#shared/definition-wire'

/**
 * What this run would do, read in the order that matters.
 *
 * Warnings first, and the destructive one first among those. Everything below
 * is reference; the top of this panel is the only part someone skimming will
 * read, so it has to carry the sentence they must not miss — which tables get
 * emptied, and that there is no rollback.
 */
const props = defineProps<{ preview: RunPreview }>()

const num = new Intl.NumberFormat()

const warned = computed(() => props.preview.warnings.filter((w) => w.severity === 'warn'))
const noted = computed(() => props.preview.warnings.filter((w) => w.severity === 'info'))

const toCreate = computed(() => props.preview.tables.filter((t) => t.disposition === 'create'))
const toLoad = computed(() => props.preview.tables.filter((t) => t.disposition === 'load'))
const untouched = computed(() => props.preview.tables.filter((t) => t.disposition === 'extra'))

/** Long subject lists are the norm here — 400 tables is not unusual. */
const SUBJECT_PREVIEW = 8
const subjectLine = (subjects: string[]): string => {
  if (subjects.length === 0) return ''
  const shown = subjects.slice(0, SUBJECT_PREVIEW).join(', ')
  const rest = subjects.length - SUBJECT_PREVIEW
  return rest > 0 ? `${shown} and ${rest} more` : shown
}

const rowsFor = (name: string): number =>
  props.preview.tables.find((t) => t.tableName === name)?.rowsEstimated ?? 0

const takenAt = computed(() => new Date(props.preview.takenAt).toLocaleTimeString())
</script>

<template>
  <section class="preview" aria-labelledby="preview-heading">
    <header class="head">
      <h2 id="preview-heading">Preview</h2>
      <p class="sub">
        Read-only. Nothing has been changed — this inspected both schemas at {{ takenAt }}.
      </p>
    </header>

    <!-- The one hero-size element on this screen. -->
    <div class="headline">
      <span class="figure mv-num">{{ num.format(preview.totalRowsEstimated) }}</span>
      <span class="unit">rows, estimated, across {{ toCreate.length + toLoad.length }} tables</span>
    </div>

    <ul v-if="warned.length" class="notes">
      <li v-for="w in warned" :key="w.code" class="note warn">
        <span class="mark" aria-hidden="true" />
        <div>
          <p class="msg">{{ w.message }}</p>
          <p v-if="w.subjects.length" class="subjects mv-mono">{{ subjectLine(w.subjects) }}</p>
        </div>
      </li>
    </ul>

    <ul v-if="noted.length" class="notes">
      <li v-for="w in noted" :key="w.code" class="note info">
        <span class="mark" aria-hidden="true" />
        <div>
          <p class="msg">{{ w.message }}</p>
          <p v-if="w.subjects.length" class="subjects mv-mono">{{ subjectLine(w.subjects) }}</p>
        </div>
      </li>
    </ul>

    <dl class="counts">
      <div><dt>Tables to create</dt><dd class="mv-num">{{ preview.diff.tablesToCreate }}</dd></div>
      <div><dt>Columns to add</dt><dd class="mv-num">{{ preview.diff.columnsToAdd }}</dd></div>
      <div><dt>Columns to alter</dt><dd class="mv-num">{{ preview.diff.columnsToAlter }}</dd></div>
      <div><dt>Constraints</dt><dd class="mv-num">{{ preview.diff.constraintsToAdd }}</dd></div>
      <div><dt>Indexes</dt><dd class="mv-num">{{ preview.diff.indexesToCreate }}</dd></div>
      <div><dt>Sequences</dt><dd class="mv-num">{{ preview.diff.sequencesToCreate }}</dd></div>
      <div><dt>Enums</dt><dd class="mv-num">{{ preview.diff.enumsToCreate }}</dd></div>
    </dl>

    <details v-if="preview.typeChanges.length" class="drawer">
      <summary>{{ preview.typeChanges.length }} columns change type</summary>
      <div class="scroller">
        <table class="grid">
          <thead>
            <tr><th>Column</th><th>From</th><th>To</th></tr>
          </thead>
          <tbody>
            <tr v-for="c in preview.typeChanges" :key="`${c.tableName}.${c.columnName}`">
              <td class="mv-mono">{{ c.tableName }}.{{ c.columnName }}</td>
              <td class="mv-mono from">{{ c.sourceType }}</td>
              <td class="mv-mono to">{{ c.targetType }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>

    <details class="drawer">
      <summary>Copy order — {{ preview.loadOrder.length }} tables, parents before children</summary>
      <ol class="order">
        <li v-for="(name, i) in preview.loadOrder" :key="name">
          <span class="idx mv-num">{{ i + 1 }}</span>
          <span class="mv-mono">{{ name }}</span>
          <span class="rows mv-num">{{ num.format(rowsFor(name)) }}</span>
        </li>
      </ol>
    </details>

    <details v-if="untouched.length" class="drawer">
      <summary>{{ untouched.length }} tables in the destination Movy will not touch</summary>
      <p class="order-note mv-mono">{{ untouched.map((t) => t.tableName).join(', ') }}</p>
    </details>
  </section>
</template>

<style scoped>
.preview {
  display: flex; flex-direction: column; gap: var(--mv-s-4);
  padding: var(--mv-s-4);
  border: 1px solid var(--mv-line); border-radius: var(--mv-r-lg);
  background: var(--mv-bg-base); box-shadow: var(--mv-elev-1);
}
.head h2 { font-size: var(--mv-fs-md); letter-spacing: -0.01em; }
.sub { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); margin-top: var(--mv-s-1); }

/* Exactly one hero-size element per screen. On a preview, this is it. */
.headline { display: flex; align-items: baseline; gap: var(--mv-s-3); flex-wrap: wrap; }
.figure {
  font-size: var(--mv-fs-hero); font-weight: var(--mv-fw-semibold);
  line-height: var(--mv-lh-tight); letter-spacing: -0.03em;
  font-variant-numeric: var(--mv-numeric);
}
.unit { font-size: var(--mv-fs-xs); color: var(--mv-fg-subtle); }

.notes { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--mv-s-2); }
.note {
  display: flex; gap: var(--mv-s-3); align-items: flex-start;
  padding: var(--mv-s-3);
  border-radius: var(--mv-r-md);
  /* A 2px bar rather than a filled panel: the page stays one surface and the
     severity still reads at a glance. */
  border-left: 2px solid var(--mv-line);
  background: var(--mv-bg-raised);
}
.note.warn { border-left-color: var(--mv-warn); background: var(--mv-warn-dim); }
.note.info { border-left-color: var(--mv-line-strong); }
.mark {
  width: 6px; height: 6px; margin-top: 6px; flex: none;
  border-radius: var(--mv-r-pill); background: var(--mv-line-strong);
}
.note.warn .mark { background: var(--mv-warn); }
.msg { font-size: var(--mv-fs-sm); line-height: var(--mv-lh-body); }
.subjects {
  margin-top: var(--mv-s-1);
  font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle);
  word-break: break-word;
}

.counts { display: flex; flex-wrap: wrap; gap: var(--mv-s-5); margin: 0; }
.counts div { display: flex; flex-direction: column; gap: 2px; }
.counts dt {
  font-size: var(--mv-fs-micro); text-transform: uppercase;
  letter-spacing: var(--mv-track-label); color: var(--mv-fg-subtle);
}
.counts dd { margin: 0; font-size: var(--mv-fs-md); font-variant-numeric: var(--mv-numeric); }

.drawer { border-top: 1px solid var(--mv-line); padding-top: var(--mv-s-3); }
.drawer summary {
  cursor: pointer; font-size: var(--mv-fs-xs); color: var(--mv-fg-muted);
  transition: color var(--mv-dur-1) var(--mv-ease-out);
}
.drawer summary:hover { color: var(--mv-fg); }
.drawer summary:focus-visible { outline: 2px solid var(--mv-focus); outline-offset: 2px; }

/* Wide content scrolls inside its own box; the page never scrolls sideways. */
.scroller { overflow-x: auto; }
.grid { width: 100%; border-collapse: collapse; margin-top: var(--mv-s-3); font-size: var(--mv-fs-xs); }
.grid th {
  text-align: left; padding: 4px var(--mv-s-2);
  font-size: var(--mv-fs-micro); text-transform: uppercase;
  letter-spacing: var(--mv-track-label); color: var(--mv-fg-subtle);
  border-bottom: 1px solid var(--mv-line);
}
.grid td { padding: 4px var(--mv-s-2); border-bottom: 1px solid var(--mv-line); white-space: nowrap; }
.from { color: var(--mv-fg-subtle); }
.to { color: var(--mv-accent); }

.order { list-style: none; margin: var(--mv-s-3) 0 0; padding: 0; max-height: 320px; overflow-y: auto; }
.order li {
  display: flex; align-items: center; gap: var(--mv-s-3);
  height: var(--mv-row-h); font-size: var(--mv-fs-xs);
  border-bottom: 1px solid var(--mv-line);
}
.idx { width: 3ch; text-align: right; color: var(--mv-fg-subtle); }
.rows { margin-left: auto; color: var(--mv-fg-subtle); }
.order-note {
  margin-top: var(--mv-s-3);
  font-size: var(--mv-fs-micro); color: var(--mv-fg-subtle); word-break: break-word;
}
</style>
