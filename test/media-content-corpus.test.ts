import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withoutMediaBytes } from '../src/index.js';

/**
 * The cross-language media-content corpus from `prism-parity`.
 *
 * Which media shapes this bridge withholds bytes from, and the size it reports.
 * If it recognised a different shape than the reference, the same configuration
 * would export a user's file from a TypeScript service and not from a PHP one.
 */
interface MediaCase {
  id: string;
  title: string;
  input: unknown;
  output: { php: string; ts: string; py: string };
  agrees: boolean;
}

const corpus = JSON.parse(
  readFileSync(new URL('./fixtures/opentelemetry-media-content.json', import.meta.url), 'utf8'),
) as { cases: MediaCase[] };

describe('the cross-language media-content corpus', () => {
  it('is the whole suite, not a subset someone trimmed to green', () => {
    expect(corpus.cases).toHaveLength(15);
  });

  it.each(corpus.cases)('$id matches the reference ($title)', (entry) => {
    expect(JSON.stringify(withoutMediaBytes(entry.input))).toBe(entry.output.php);
  });

  it('agrees with the reference on EVERY row', () => {
    for (const entry of corpus.cases) {
      expect([entry.output.ts, entry.output.py], entry.id).toEqual([entry.output.php, entry.output.php]);
      expect(entry.agrees, entry.id).toBe(true);
    }
  });
});
