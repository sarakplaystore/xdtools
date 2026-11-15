/**
 * Font matching: deciding which real font file a PDF font corresponds to, and
 * proving it.
 *
 * A name alone is weak evidence (versions differ, names collide), so every
 * candidate is checked against the font program embedded in the PDF: the
 * outline of each glyph the document uses must be found, point for point, in
 * the candidate. A verified match also yields the glyph-id correspondence
 * needed to read Khmer text back from the PDF and to reuse embedded glyphs.
 */
import type { PdfFont } from '../pdf/fonts';
import { LoadedFont } from './hb';
import type { CatalogEntry } from './library';
import { Unshaper } from './unshape';

export type MatchQuality = 'exact' | 'name' | 'substitute';
export type MatchEvidence = 'outline' | 'metrics' | 'none';

export interface FontMatch {
  entry: CatalogEntry;
  font: LoadedFont;
  quality: MatchQuality;
  evidence: MatchEvidence;
  alias: boolean;
  /** Share of the glyphs used in the document that were verified in `font`. */
  score: number;
  verified: number;
  total: number;
  /** PDF character code → glyph id in `font` (verified codes only). */
  codeToGid: Map<number, number>;
  /** Glyph id in `font` → PDF character code that draws the same glyph. */
  gidToCode: Map<number, number>;
  unshaper: Unshaper | null;
  /** The user picked this font by hand (upload / picker) rather than the matcher finding it. */
  chosen?: boolean;
}

const embeddedCache = new WeakMap<PdfFont, LoadedFont | null>();
const printIndex = new WeakMap<LoadedFont, Map<string, number>>();

/** The PDF's embedded font program opened with HarfBuzz (TrueType/OpenType only). */
export function embeddedFont(pdfFont: PdfFont): LoadedFont | null {
  let f = embeddedCache.get(pdfFont);
  if (f !== undefined) return f;
  f = null;
  const prog = pdfFont.program;
  if (prog && (prog.kind === 'truetype' || prog.kind === 'opentype')) {
    try {
      const lf = new LoadedFont(prog.bytes);
      if (lf.glyphCount > 0) f = lf;
    } catch {
      f = null;
    }
  }
  embeddedCache.set(pdfFont, f);
  return f;
}

function fingerprintIndex(font: LoadedFont): Map<string, number> {
  let idx = printIndex.get(font);
  if (!idx) {
    idx = new Map();
    for (let g = font.glyphCount - 1; g >= 1; g--) idx.set(font.fingerprint(g), g);
    printIndex.set(font, idx);
  }
  return idx;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;

export function verifyFont(pdfFont: PdfFont, font: LoadedFont): Pick<FontMatch, 'score' | 'verified' | 'total' | 'codeToGid' | 'gidToCode' | 'evidence'> {
  const codeToGid = new Map<number, number>();
  const emb = embeddedFont(pdfFont);
  let total = 0;
  let verified = 0;
  /** Verified glyphs that actually have an outline (a matching space proves nothing). */
  let inked = 0;
  const distinctWidths = new Set<number>();

  const viaUnicode = (code: number): number | undefined => {
    const u = pdfFont.unicode(code);
    if (!u) return undefined;
    const cps = Array.from(u);
    if (cps.length !== 1) return undefined;
    const g = font.glyphFor(cps[0].codePointAt(0)!);
    return g && near(font.advance1000(g), pdfFont.width(code)) ? g : undefined;
  };

  for (const code of pdfFont.used) {
    total++;
    const w = pdfFont.width(code);
    let gid: number | undefined;
    if (emb) {
      let eg = 0;
      if (pdfFont.composite) eg = pdfFont.gid(code);
      else {
        const u = pdfFont.unicode(code);
        const cp = u ? u.codePointAt(0)! : 0;
        eg = (cp && emb.glyphFor(cp)) || emb.glyphFor(0xf000 + code) || emb.glyphFor(code);
      }
      if (eg > 0 && eg < emb.glyphCount) {
        const fp = emb.fingerprint(eg);
        const hinted = viaUnicode(code);
        if (eg < font.glyphCount && font.fingerprint(eg) === fp) gid = eg;
        else if (hinted !== undefined && font.fingerprint(hinted) === fp) gid = hinted;
        else gid = fingerprintIndex(font).get(fp);
        if (gid !== undefined && !fp.startsWith('blank:')) inked++;
      }
    } else {
      if (pdfFont.composite) {
        const g = pdfFont.gid(code);
        if (g > 0 && g < font.glyphCount && near(font.advance1000(g), w)) gid = g;
      }
      if (gid === undefined) gid = viaUnicode(code);
      if (gid !== undefined && w > 0) distinctWidths.add(Math.round(w));
    }
    if (gid !== undefined) {
      codeToGid.set(code, gid);
      verified++;
    }
  }
  const gidToCode = new Map<number, number>();
  for (const [code, gid] of codeToGid) if (!gidToCode.has(gid)) gidToCode.set(gid, code);
  let evidence: MatchEvidence = 'none';
  if (verified > 0) evidence = emb ? (inked > 0 ? 'outline' : 'none') : distinctWidths.size >= 4 ? 'metrics' : 'none';
  return { score: total ? verified / total : 0, verified, total, codeToGid, gidToCode, evidence };
}

export function makeMatch(pdfFont: PdfFont, entry: CatalogEntry, font: LoadedFont, alias: boolean): FontMatch {
  const v = verifyFont(pdfFont, font);
  let quality: MatchQuality = alias ? 'substitute' : 'name';
  if (v.evidence === 'outline' && v.score >= 0.9) quality = 'exact';
  else if (v.evidence === 'metrics' && v.score >= 0.95 && !alias) quality = 'exact';
  return { entry, font, alias, quality, ...v, unshaper: null };
}

/** Lazily creates the text-recovery helper for a match. */
export function unshaperOf(match: FontMatch): Unshaper {
  if (!match.unshaper) match.unshaper = new Unshaper(match.font);
  return match.unshaper;
}
