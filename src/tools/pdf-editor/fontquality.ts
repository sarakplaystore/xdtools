/** How well each font of the PDF was matched, as the UI describes it. */
import type { DocFont } from '../../engine/document';

export type Quality = 'exact' | 'name' | 'chosen' | 'standard' | 'substitute' | 'none' | 'searching';

const STANDARD = /^(helvetica|times|timesroman|courier)$/;

/**
 * The classic PDF fonts are usually only named, not stored in the file: every viewer draws them with
 * its own look-alike, so a look-alike is the best any editor can do — no reason to alarm the user.
 */
export const isStandardFont = (df: DocFont): boolean => !df.font.embedded && !df.font.type3 && df.name.keys.some((k) => STANDARD.test(k));

export const qualityOf = (df: DocFont): Quality => {
  if (df.state === 'searching') return 'searching';
  const m = df.match;
  if (!m) return 'none';
  if (m.chosen && m.quality !== 'exact') return 'chosen';
  if (m.quality === 'substitute' && isStandardFont(df)) return 'standard';
  return m.quality;
};

/** PDF fonts that are the same typeface matched the same way, shown as one row. */
export interface FontGroup {
  key: string;
  fonts: DocFont[];
  lead: DocFont;
  quality: Quality;
  pages: number[];
  verified: number;
  total: number;
}

/** Fonts worth showing: those that draw something other than spaces. */
export const visibleFonts = (fonts: DocFont[]): DocFont[] => {
  const seen = fonts.filter((f) => !f.spacing);
  return seen.length ? seen : fonts;
};

export function groupFonts(fonts: DocFont[]): FontGroup[] {
  const groups = new Map<string, FontGroup>();
  for (const df of visibleFonts(fonts)) {
    const quality = qualityOf(df);
    const m = df.match;
    const key = [df.name.clean, df.font.type3 ? 't3' : df.font.embedded ? 'emb' : 'ref', quality, m?.entry.id ?? '', m?.evidence ?? ''].join('|');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, fonts: [], lead: df, quality, pages: [], verified: 0, total: 0 }));
    g.fonts.push(df);
    for (const p of df.pages) if (!g.pages.includes(p)) g.pages.push(p);
    if (m?.evidence === 'outline') {
      g.verified += m.verified;
      g.total += m.total;
    }
  }
  const out = [...groups.values()];
  for (const g of out) g.pages.sort((a, b) => a - b);
  return out;
}
