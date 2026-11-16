import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { EditorDocument, type ScrapeProgress } from '../src/engine/document';
import { LoadedFont, sameOutline, unwrapFontBytes } from '../src/engine/font/hb';
import { bestVariationFont } from '../src/engine/font/match';
import { FontLibrary, type GoogleManifest, type LibraryEnv } from '../src/engine/font/library';
import { fuzzyFamilies, keyVariants, relevantFile, scriptsInText } from '../src/engine/font/scrape';
import type { PdfFont } from '../src/engine/pdf/fonts';
import { ROOT, nodeLibrary } from './helpers';

const bytesOf = (rel: string) => new Uint8Array(readFileSync(join(ROOT, rel)));
const fixture = (name: string) => bytesOf(`tests/fixtures/${name}`);

/** Builds a WOFF 1.0 file (uncompressed tables) from a TrueType/OpenType file. */
function toWoff(sfnt: Uint8Array): Uint8Array {
  const dv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const numTables = dv.getUint16(4);
  const tables: { tag: number; csum: number; data: Uint8Array }[] = [];
  for (let i = 0; i < numTables; i++) {
    const r = 12 + i * 16;
    const off = dv.getUint32(r + 8);
    const len = dv.getUint32(r + 12);
    tables.push({ tag: dv.getUint32(r), csum: dv.getUint32(r + 4), data: sfnt.subarray(off, off + len) });
  }
  const dirEnd = 44 + numTables * 20;
  let total = dirEnd;
  for (const t of tables) total += (t.data.length + 3) & ~3;
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, 0x774f4646);
  ov.setUint32(4, dv.getUint32(0));
  ov.setUint32(8, total);
  ov.setUint16(12, numTables);
  ov.setUint32(16, sfnt.length);
  let cursor = dirEnd;
  tables.forEach((t, i) => {
    const e = 44 + i * 20;
    ov.setUint32(e, t.tag);
    ov.setUint32(e + 4, cursor);
    ov.setUint32(e + 8, t.data.length);
    ov.setUint32(e + 12, t.data.length);
    ov.setUint32(e + 16, t.csum);
    out.set(t.data, cursor);
    cursor += (t.data.length + 3) & ~3;
  });
  return out;
}

/** A PDF font stand-in with no embedded program: only the codes, Unicode and widths a PDF would give. */
function stubPdfFont(font: LoadedFont, text: string): PdfFont {
  const codes = new Map<number, { cp: number; width: number }>();
  Array.from(text).forEach((ch, i) => {
    const cp = ch.codePointAt(0)!;
    const g = font.glyphFor(cp);
    codes.set(i + 1, { cp, width: Math.round(font.advance1000(g)) });
  });
  return {
    used: new Set(codes.keys()),
    composite: false,
    program: null,
    desc: { flags: 0, italicAngle: 0, fontWeight: 0 },
    unicode: (c: number) => String.fromCodePoint(codes.get(c)!.cp),
    width: (c: number) => codes.get(c)!.width,
    gid: () => 0,
    cid: (c: number) => c,
  } as unknown as PdfFont;
}

describe('name clues', () => {
  test('spelling variants drop common suffixes and the Khmer prefix', () => {
    expect(keyVariants('arialmt')).toContain('arial');
    expect(keyVariants('notosansthaiui')).toContain('notosansthai');
    expect(keyVariants('khmerosbattambang')).toContain('osbattambang');
    expect(keyVariants('arial')).not.toContain('arial');
  });

  test('scripts are read from the characters drawn', () => {
    expect([...scriptsInText('សួស្តី')]).toEqual(['khmr']);
    expect([...scriptsInText('สวัสดี Hello')]).toEqual(['thai']);
    expect(scriptsInText('plain latin').size).toBe(0);
  });

  test('fuzzy family search finds Google families the name resembles, exact first', () => {
    const m: GoogleManifest = {
      ref: 'x',
      families: { notosanskhmer: ['o', []] as never, roboto: ['a', []] as never, battambang: ['o', []] as never },
    };
    m.families.notosanskhmer = ['ofl', ['NotoSansKhmer[wdth,wght].ttf']];
    m.families.roboto = ['apache', ['Roboto[wdth,wght].ttf']];
    m.families.battambang = ['ofl', ['Battambang-Regular.ttf']];
    expect(fuzzyFamilies(m, ['notosanskhmerui'])).toEqual(['notosanskhmer']);
    expect(fuzzyFamilies(m, ['battambang', 'notosanskhmer'])).toEqual(expect.arrayContaining(['battambang', 'notosanskhmer']));
    expect(fuzzyFamilies(m, ['helveticaneue'])).toEqual([]);
  });

  test('repository files are only candidates when their name resembles the font', () => {
    expect(relevantFile('fonts/v5.0/KhmerOS_battambang.ttf', ['khmerosbattambang'])).toBe(true);
    expect(relevantFile('fonts/v5.0/KhmerOS_siemreap.ttf', ['khmerosbattambang'])).toBe(false);
    expect(relevantFile('docs/readme.md', ['khmerosbattambang'])).toBe(false);
  });
});

describe('font files', () => {
  test('a WOFF wrapper unpacks to the same font', async () => {
    const sfnt = bytesOf('public/fonts/google/Hanuman-VF.ttf');
    const woff = toWoff(sfnt);
    const unpacked = await unwrapFontBytes(woff);
    const a = new LoadedFont(sfnt);
    const b = new LoadedFont(unpacked);
    expect(b.glyphCount).toBe(a.glyphCount);
    const g = a.glyphFor(0x41);
    expect(b.path(b.glyphFor(0x41))).toBe(a.path(g));
  });

  test('outline comparison tolerates point rounding but not different shapes', () => {
    expect(sameOutline('M10,20L30.4,40Z', 'M10,20L30,40Z')).toBe(true);
    expect(sameOutline('M10,20L30,40Z', 'M10,20L36,40Z')).toBe(false);
    expect(sameOutline('M10,20L30,40Z', 'M10,20Q30,40 50,60Z')).toBe(false);
    expect(sameOutline('', '')).toBe(false);
  });
});

describe('variable fonts', () => {
  test('the weight whose widths match the PDF is found by probing wght', () => {
    const base = new LoadedFont(bytesOf('public/fonts/google/NotoSansKhmer-VF.ttf'));
    const target = base.withVariations({ wght: 700 });
    // Only letters whose advance really changes with weight can tell the instances apart.
    const telling = Array.from({ length: 58 }, (_, i) => String.fromCharCode(65 + i)).filter((ch) => {
      const cp = ch.codePointAt(0)!;
      const a = base.advance1000(base.glyphFor(cp));
      const b = target.advance1000(target.glyphFor(cp));
      return Math.abs(a - b) > 3;
    });
    expect(telling.length).toBeGreaterThanOrEqual(4);
    const pdf = stubPdfFont(target, telling.slice(0, 6).join(''));
    const chosen = bestVariationFont(pdf, base, { weights: [400] });
    expect(chosen.variations.wght).toBe(700);
    expect(chosen.variations.wdth).toBe(100);
  });
});

describe('scrape until matched (remote mirror only)', () => {
  // The file is reachable only through the mirror: no bundled copies, so the match has to be scraped.
  const battambang = bytesOf('public/fonts/khmeros/KhmerOS_battambang.ttf');
  const siemreap = bytesOf('public/fonts/khmeros/KhmerOS_siemreap.ttf');

  function mirrorLibrary(serve: (url: string) => Uint8Array | null, calls: string[] = []) {
    const env: LibraryEnv = {
      readAsset: async () => {
        throw new Error('no bundled fonts in this scenario');
      },
      fetchRemote: async (sources) => {
        for (const s of sources) {
          calls.push(s.url);
          const hit = serve(s.url);
          if (hit) return hit;
        }
        throw new Error('not on the mirror');
      },
      fetchJson: async () => null,
      loadGoogleManifest: async () => JSON.parse(readFileSync(join(ROOT, 'src/data/google-fonts.json'), 'utf8')) as GoogleManifest,
    };
    return new FontLibrary(env);
  }

  async function openBattambang(library: FontLibrary) {
    const doc = await EditorDocument.open(fixture('chrome-khmer.pdf'), { library });
    await doc.resolveFonts({ online: false });
    const df = doc.fonts.find((f) => f.font.embedded && /battambang/i.test(f.name.clean))!;
    expect(df).toBeDefined();
    return { doc, df };
  }

  test('finds the exact font on the mirror and stops early', async () => {
    const calls: string[] = [];
    const library = mirrorLibrary((url) => (/KhmerOS_battambang\.ttf$/.test(url) ? battambang : null), calls);
    const { doc, df } = await openBattambang(library);
    expect(df.match?.quality).not.toBe('exact');

    const phases: ScrapeProgress['phase'][] = [];
    const res = await doc.scrapeFont(df, { onProgress: (p) => phases.push(p.phase) });
    expect(res.exact).toBe(true);
    expect(res.aborted).toBe(false);
    expect(df.match?.quality).toBe('exact');
    expect(df.match?.entry.source).toBe('github');
    expect(df.state).toBe('done');
    expect(phases).toContain('catalog');
    // Once the exact file is found the rest of the plan is skipped.
    expect(calls.length).toBeLessThan(40);
  });

  test('a look-alike font with the same name is not accepted', async () => {
    const library = mirrorLibrary((url) => (/KhmerOS_battambang\.ttf$/.test(url) ? siemreap : null));
    const { doc, df } = await openBattambang(library);
    const res = await doc.scrapeFont(df);
    expect(res.exact).toBe(false);
    expect(df.match?.quality).not.toBe('exact');
  });

  test('stopping before the first probe keeps the existing match and fetches nothing', async () => {
    const calls: string[] = [];
    const library = mirrorLibrary((url) => (/KhmerOS_battambang\.ttf$/.test(url) ? battambang : null), calls);
    const { doc, df } = await openBattambang(library);
    const before = df.match;
    const ctl = new AbortController();
    ctl.abort();
    const res = await doc.scrapeFont(df, { signal: ctl.signal });
    expect(res.aborted).toBe(true);
    expect(res.exact).toBe(false);
    expect(calls).toHaveLength(0);
    expect(df.match).toBe(before);
  });

  test('an aborted scrape keeps the best match found so far', async () => {
    const library = mirrorLibrary((url) => (/KhmerOS_battambang\.ttf$/.test(url) ? battambang : null));
    const { doc, df } = await openBattambang(library);
    const ctl = new AbortController();
    const res = await doc.scrapeFont(df, {
      signal: ctl.signal,
      onMatch: () => ctl.abort(),
    });
    expect(res.exact).toBe(true);
    expect(df.match?.quality).toBe('exact');
  });

  test('the local library still matches fonts without any network', async () => {
    const doc = await EditorDocument.open(fixture('chrome-khmer.pdf'), { library: nodeLibrary() });
    await doc.resolveFonts({ online: false });
    const df = doc.fonts.find((f) => f.font.embedded && /battambang/i.test(f.name.clean))!;
    expect(df.match?.quality).toBe('exact');
    // Already exact: nothing is downloaded again.
    const res = await doc.scrapeFont(df);
    expect(res.exact).toBe(true);
    expect(res.probed).toBe(0);
  });
});
