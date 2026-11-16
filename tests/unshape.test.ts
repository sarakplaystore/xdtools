import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { LoadedFont } from '../src/engine/font/hb';
import { Unshaper } from '../src/engine/font/unshape';
import { ROOT } from './helpers';

const TARGET = 'រដ្ឋមន្ត្រីក្រសួងមហាផ្ទៃ';
const font = new LoadedFont(new Uint8Array(readFileSync(join(ROOT, 'public/fonts/google/Battambang-Regular.ttf'))), {}, 0);

describe('un-shaping Khmer glyph runs', () => {
  test('a run in logical order is recovered exactly and verified', () => {
    const gids = font.shape(TARGET).map((g) => g.gid);
    const rec = new Unshaper(font).unshape(gids);
    expect(rec.map((c) => c.text).join('')).toBe(TARGET);
    expect(rec.every((c) => c.verified)).toBe(true);
  });

  test('a cluster holding a glyph with no known text is never reported as verified', () => {
    const shaped = font.shape(TARGET).map((g) => g.gid);
    // Subscript consonant ្ឋ (the second glyph of ដ្ឋ) with no text mapping, as a subset font can produce.
    const idx = 2;
    expect(new Unshaper(font).textOf(shaped[idx])).toBeDefined();
    const gids = shaped.map((g, k) => (k === idx ? -1 : g));
    const rec = new Unshaper(font).unshape(gids);
    const owner = rec.find((c) => idx >= c.start && idx < c.end);
    expect(owner).toBeDefined();
    expect(owner!.verified).toBe(false);
  });
});
