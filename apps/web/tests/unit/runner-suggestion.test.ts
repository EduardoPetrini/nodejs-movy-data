import { describe, it, expect } from 'vitest';
import { formatBytes, suggestRunnerClass, suggestionSentence } from '../../shared/runner-suggestion';

const GB = 1_000_000_000;
const classes = [
  { name: 'default', label: 'Default', suggestAboveBytes: null },
  { name: 'xlarge', label: 'Extra large', suggestAboveBytes: 200 * GB },
  { name: 'large', label: 'Large', suggestAboveBytes: 20 * GB },
];

describe('suggestRunnerClass', () => {
  it('takes the highest threshold the source exceeds, whatever order the classes are in', () => {
    expect(suggestRunnerClass(300 * GB, classes)?.runnerClass).toBe('xlarge');
    expect(suggestRunnerClass(84 * GB, classes)?.runnerClass).toBe('large');
  });

  it('suggests only ABOVE the threshold, and nothing when the size is unknown', () => {
    expect(suggestRunnerClass(20 * GB, classes)).toBeNull();
    expect(suggestRunnerClass(null, classes)).toBeNull();
    expect(suggestRunnerClass(10 * GB, [])).toBeNull();
  });
});

describe('formatBytes and the hint', () => {
  it('uses decimal units with sensible precision', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1500)).toBe('1.5 KB');
    expect(formatBytes(84 * GB)).toBe('84 GB');
    expect(formatBytes(1_234_000_000)).toBe('1.23 GB');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('words the suggestion as a recommendation', () => {
    expect(suggestionSentence(84 * GB, { runnerClass: 'large', label: 'Large', aboveBytes: 20 * GB }))
      .toBe('The source is 84 GB; the Large runner is recommended above 20 GB.');
  });
});
