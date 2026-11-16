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
import { Encodings } from '@cantoo/pdf-lib/standard-fonts';
import type { PdfFont } from '../pdf/fonts';
import { LoadedFont, sameOutline } from './hb';
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

export interface Verification extends Pick<FontMatch, 'score' | 'verified' | 'total' | 'codeToGid' | 'gidToCode' | 'evidence'> {
  inked: number;
  /** Verified glyphs with non-trivial outlines (rules out lone hyphens/rules during blind sweeps). */
  complex: number;
  distinctWidths: number;
}

interface EmbeddedInfo {
  font: LoadedFont;
  cff: boolean;
  cidToGid: Map<number, number> | null;
}

/** Wraps a standalone PDF `CFF ` font stream in a minimal `OTTO` OpenType shell so HarfBuzz can read its outlines. */
function openCffProgram(cff: Uint8Array): EmbeddedInfo | null {
  if (cff.length < 16 || cff[0] !== 1 || cff[2] < 4 || cff[2] >= cff.length) return null;
  let pos = cff[2];
  const readIndex = (): Uint8Array[] | null => {
    if (pos + 2 > cff.length) return null;
    const count = (cff[pos] << 8) | cff[pos + 1];
    pos += 2;
    if (count === 0) return [];
    const offSize = cff[pos++];
    if (offSize < 1 || offSize > 4 || pos + (count + 1) * offSize > cff.length) return null;
    const offs = new Uint32Array(count + 1);
    for (let i = 0; i <= count; i++) {
      let v = 0;
      for (let k = 0; k < offSize; k++) v = v * 256 + cff[pos++];
      offs[i] = v;
    }
    const base = pos - 1;
    const end = base + offs[count];
    if (offs[0] < 1 || end > cff.length) return null;
    pos = end;
    const out: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      if (offs[i + 1] < offs[i]) return null;
      out.push(cff.subarray(base + offs[i], base + offs[i + 1]));
    }
    return out;
  };
  if (!readIndex()) return null; // Name INDEX
  const top = readIndex();
  if (!top?.length) return null;
  const dict = top[0];
  const nib = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', 'E', 'E-', '', '-'];
  let stack: number[] = [];
  let charsetOff = 0;
  let charStringsOff = 0;
  let upem = 1000;
  let isRos = false;
  for (let i = 0; i < dict.length; ) {
    const b0 = dict[i++];
    if (b0 <= 21) {
      const op = b0 === 12 ? 1200 + (dict[i++] ?? 0) : b0;
      if (op === 15 && stack.length) charsetOff = stack[stack.length - 1];
      else if (op === 17 && stack.length) charStringsOff = stack[stack.length - 1];
      else if (op === 1207 && stack.length >= 6 && stack[0] > 0) {
        const u = Math.round(1 / stack[0]);
        if (u >= 16 && u <= 16384) upem = u;
      } else if (op === 1230) isRos = true;
      stack = [];
    } else if (b0 === 28 && i + 1 < dict.length) {
      const v = (dict[i] << 8) | dict[i + 1];
      i += 2;
      stack.push(v & 0x8000 ? v - 0x10000 : v);
    } else if (b0 === 29 && i + 3 < dict.length) {
      stack.push((dict[i] << 24) | (dict[i + 1] << 16) | (dict[i + 2] << 8) | dict[i + 3]);
      i += 4;
    } else if (b0 === 30) {
      let s = '';
      outer: while (i < dict.length) {
        const byte = dict[i++];
        for (const n of [byte >> 4, byte & 15]) {
          if (n === 15) break outer;
          s += nib[n] ?? '';
        }
      }
      stack.push(Number.parseFloat(s) || 0);
    } else if (b0 >= 32 && b0 <= 246) stack.push(b0 - 139);
    else if (b0 >= 247 && b0 <= 250 && i < dict.length) stack.push((b0 - 247) * 256 + dict[i++] + 108);
    else if (b0 >= 251 && b0 <= 254 && i < dict.length) stack.push(-(b0 - 251) * 256 - dict[i++] - 108);
    else break;
  }
  if (charStringsOff <= 0 || charStringsOff >= cff.length) return null;
  pos = charStringsOff;
  const cs = readIndex();
  if (!cs?.length || cs.length > 65535) return null;
  const glyphCount = cs.length;

  let cidToGid: Map<number, number> | null = null;
  if (isRos && charsetOff > 2 && charsetOff < cff.length) {
    cidToGid = new Map([[0, 0]]);
    let p = charsetOff;
    const fmt = cff[p++];
    let gid = 1;
    if (fmt === 0) {
      while (gid < glyphCount && p + 1 < cff.length) {
        cidToGid.set((cff[p] << 8) | cff[p + 1], gid++);
        p += 2;
      }
    } else if (fmt === 1 || fmt === 2) {
      const step = fmt === 1 ? 3 : 4;
      while (gid < glyphCount && p + step <= cff.length) {
        const first = (cff[p] << 8) | cff[p + 1];
        const left = fmt === 1 ? cff[p + 2] : (cff[p + 2] << 8) | cff[p + 3];
        p += step;
        for (let k = 0; k <= left && gid < glyphCount; k++) cidToGid.set(first + k, gid++);
      }
    }
  }

  const head = new Uint8Array(54);
  const hv = new DataView(head.buffer);
  hv.setUint32(0, 0x00010000);
  hv.setUint32(12, 0x5f0f3cf5);
  hv.setUint16(18, upem);
  const maxp = new Uint8Array(6);
  const mv = new DataView(maxp.buffer);
  mv.setUint32(0, 0x00005000);
  mv.setUint16(4, glyphCount);

  const tables: [number, Uint8Array][] = [
    [0x43464620, cff], // 'CFF '
    [0x68656164, head], // 'head'
    [0x6d617870, maxp], // 'maxp'
  ];
  const dir = 12 + tables.length * 16;
  let total = dir;
  for (const [, d] of tables) total += (d.length + 3) & ~3;
  const sfnt = new Uint8Array(total);
  const dv = new DataView(sfnt.buffer);
  dv.setUint32(0, 0x4f54544f); // 'OTTO'
  dv.setUint16(4, tables.length);
  dv.setUint16(6, 32);
  dv.setUint16(8, 1);
  dv.setUint16(10, 16);
  let off = dir;
  tables.forEach(([tag, d], idx) => {
    const r = 12 + idx * 16;
    dv.setUint32(r, tag);
    dv.setUint32(r + 8, off);
    dv.setUint32(r + 12, d.length);
    sfnt.set(d, off);
    off += (d.length + 3) & ~3;
  });
  const lf = new LoadedFont(sfnt);
  return lf.glyphCount > 0 ? { font: lf, cff: true, cidToGid } : null;
}

const embeddedCache = new WeakMap<PdfFont, EmbeddedInfo | null>();

function embeddedInfo(pdfFont: PdfFont): EmbeddedInfo | null {
  let info = embeddedCache.get(pdfFont);
  if (info !== undefined) return info;
  info = null;
  const prog = pdfFont.program;
  if (prog) {
    try {
      if (prog.kind === 'truetype' || prog.kind === 'opentype') {
        const lf = new LoadedFont(prog.bytes);
        if (lf.glyphCount > 0) info = { font: lf, cff: false, cidToGid: null };
      } else if (prog.kind === 'cff') {
        info = openCffProgram(prog.bytes);
      }
    } catch {
      info = null;
    }
  }
  embeddedCache.set(pdfFont, info);
  return info;
}

/** The PDF's embedded font program opened with HarfBuzz (TrueType, OpenType, or CFF). */
export function embeddedFont(pdfFont: PdfFont): LoadedFont | null {
  return embeddedInfo(pdfFont)?.font ?? null;
}

/**
 * Width-partitioned outline index for a candidate font: groups glyph ids by rounded advance
 * once, then only computes SVG outlines for width buckets a PDF font actually asks about.
 */
class OutlineIndex {
  private byWidth = new Map<number, number[]>();
  private scanned = new Set<number>();
  private exact = new Map<string, number>();
  private skel = new Map<string, number[]>();

  constructor(private font: LoadedFont) {
    for (let g = font.glyphCount - 1; g >= 1; g--) {
      const w = Math.round(font.advance1000(g));
      let bucket = this.byWidth.get(w);
      if (!bucket) {
        bucket = [];
        this.byWidth.set(w, bucket);
      }
      bucket.push(g);
    }
  }

  private ensureWidth(w: number) {
    const rw = Math.round(w);
    for (let k = rw - 2; k <= rw + 2; k++) {
      if (this.scanned.has(k)) continue;
      this.scanned.add(k);
      const bucket = this.byWidth.get(k);
      if (!bucket) continue;
      for (const g of bucket) {
        const fp = this.font.fingerprint(g);
        this.exact.set(fp, g);
        const sk = this.font.skeleton(g);
        if (sk) {
          let list = this.skel.get(sk);
          if (!list) {
            list = [];
            this.skel.set(sk, list);
          }
          list.push(g);
        }
      }
    }
  }

  findExact(fp: string, adv: number): number | undefined {
    this.ensureWidth(adv);
    return this.exact.get(fp);
  }

  findRounded(path: string, skel: string, adv: number, tol: number): number | undefined {
    if (!skel) return undefined;
    this.ensureWidth(adv);
    const list = this.skel.get(skel);
    if (!list) return undefined;
    for (const g of list) {
      if (Math.abs(this.font.advance1000(g) - adv) <= 1.5 && sameOutline(path, this.font.path(g), tol)) return g;
    }
    return undefined;
  }
}

const outlineCache = new WeakMap<LoadedFont, OutlineIndex>();
function outlineIndex(font: LoadedFont): OutlineIndex {
  let idx = outlineCache.get(font);
  if (!idx) {
    idx = new OutlineIndex(font);
    outlineCache.set(font, idx);
  }
  return idx;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;

function glyphNameForCp(cp: number): string {
  try {
    return Encodings.WinAnsi.encodeUnicodeCodePoint(cp).name;
  } catch {
    return cp <= 0xffff ? `uni${cp.toString(16).toUpperCase().padStart(4, '0')}` : `u${cp.toString(16).toUpperCase()}`;
  }
}

function embeddedGlyph(pdfFont: PdfFont, info: EmbeddedInfo, code: number): number {
  const emb = info.font;
  if (pdfFont.composite) {
    if (info.cff && info.cidToGid) return info.cidToGid.get(pdfFont.cid(code)) ?? 0;
    return pdfFont.gid(code);
  }
  const u = pdfFont.unicode(code);
  const cp = u ? u.codePointAt(0)! : 0;
  let eg = (cp && emb.glyphFor(cp)) || emb.glyphFor(0xf000 + code) || emb.glyphFor(code);
  if (!eg && cp) eg = emb.glyphByName(glyphNameForCp(cp));
  return eg;
}

function matchGlyph(emb: LoadedFont, eg: number, pdfWidth: number, cff: boolean, font: LoadedFont, hinted: number | undefined): { gid: number; blank: boolean; complex: boolean } | null {
  const fp = emb.fingerprint(eg);
  const blank = fp.startsWith('blank:');
  const embAdv = emb.advance1000(eg);
  const path = blank ? '' : emb.path(eg);
  const complex = path.length >= 60;

  if (eg < font.glyphCount && font.fingerprint(eg) === fp) return { gid: eg, blank, complex };
  if (hinted !== undefined && font.fingerprint(hinted) === fp) return { gid: hinted, blank, complex };
  const exact = outlineIndex(font).findExact(fp, embAdv);
  if (exact !== undefined) return { gid: exact, blank, complex };

  // Variable-font instancing rounds outline points to integers (≤1.5 units) and CFF subsets may
  // omit Private DICT widths while keeping the true advance in the PDF's /W table.
  if (!blank && emb.upem === font.upem) {
    const tol = 1.5;
    const advs = cff && pdfWidth > 0 && !near(embAdv, pdfWidth) ? [embAdv, pdfWidth] : [embAdv];
    for (const adv of advs) {
      if (eg < font.glyphCount && near(font.advance1000(eg), adv) && sameOutline(path, font.path(eg), tol)) return { gid: eg, blank: false, complex };
      if (hinted !== undefined && near(font.advance1000(hinted), adv) && sameOutline(path, font.path(hinted), tol)) return { gid: hinted, blank: false, complex };
      const rounded = outlineIndex(font).findRounded(path, emb.skeleton(eg), adv, tol);
      if (rounded !== undefined) return { gid: rounded, blank: false, complex };
    }
  }
  return null;
}

export function verifyFont(pdfFont: PdfFont, font: LoadedFont): Verification {
  const codeToGid = new Map<number, number>();
  const info = embeddedInfo(pdfFont);
  let total = 0;
  let verified = 0;
  /** Verified glyphs that actually have an outline (a matching space proves nothing). */
  let inked = 0;
  let complex = 0;
  let resolvable = 0;
  const distinctWidths = new Set<number>();

  const viaUnicode = (code: number): number | undefined => {
    const u = pdfFont.unicode(code);
    if (!u) return undefined;
    const cps = Array.from(u);
    if (cps.length !== 1) return undefined;
    const g = font.glyphFor(cps[0].codePointAt(0)!);
    return g && near(font.advance1000(g), pdfFont.width(code)) ? g : undefined;
  };

  if (info) {
    for (const code of pdfFont.used) {
      total++;
      const eg = embeddedGlyph(pdfFont, info, code);
      if (eg > 0 && eg < info.font.glyphCount) {
        resolvable++;
        const hit = matchGlyph(info.font, eg, pdfFont.width(code), info.cff, font, viaUnicode(code));
        if (hit) {
          codeToGid.set(code, hit.gid);
          verified++;
          if (!hit.blank) inked++;
          if (hit.complex) complex++;
        }
      }
    }
  }

  // Unembedded fonts — and rare simple subsets whose cmap/encoding gives no embedded glyph ids —
  // fall back to checking every character's advance width against the PDF's width table.
  const useMetrics = !info || resolvable === 0;
  if (useMetrics) {
    total = 0;
    verified = 0;
    codeToGid.clear();
    for (const code of pdfFont.used) {
      total++;
      const w = pdfFont.width(code);
      let gid: number | undefined;
      if (!info && pdfFont.composite) {
        const g = pdfFont.gid(code);
        if (g > 0 && g < font.glyphCount && near(font.advance1000(g), w)) gid = g;
      }
      if (gid === undefined) gid = viaUnicode(code);
      if (gid !== undefined) {
        codeToGid.set(code, gid);
        verified++;
        if (w > 0) distinctWidths.add(Math.round(w));
      }
    }
  }

  const gidToCode = new Map<number, number>();
  for (const [code, gid] of codeToGid) if (!gidToCode.has(gid)) gidToCode.set(gid, code);
  let evidence: MatchEvidence = 'none';
  if (verified > 0) {
    evidence = !useMetrics ? (inked > 0 ? 'outline' : 'none') : distinctWidths.size >= 4 ? 'metrics' : 'none';
  }
  return { score: total ? verified / total : 0, verified, total, codeToGid, gidToCode, evidence, inked, complex, distinctWidths: distinctWidths.size };
}

export function makeMatch(pdfFont: PdfFont, entry: CatalogEntry, font: LoadedFont, alias: boolean, blind = false): FontMatch {
  const v = verifyFont(pdfFont, font);
  let quality: MatchQuality = alias || blind ? 'substitute' : 'name';
  if (v.evidence === 'outline' && v.score >= 0.9 && (!blind || v.complex >= 1 || v.inked >= 2)) {
    quality = 'exact';
  } else if (v.evidence === 'metrics') {
    if (!alias && !blind && v.score >= 0.95) quality = 'exact';
    else if (blind && v.distinctWidths >= 6 && v.score >= 0.98) quality = 'exact';
  }
  return {
    entry,
    font,
    alias: alias || (blind && quality !== 'exact'),
    quality,
    evidence: v.evidence,
    score: v.score,
    verified: v.verified,
    total: v.total,
    codeToGid: v.codeToGid,
    gidToCode: v.gidToCode,
    unshaper: null,
  };
}

export interface VariationHints {
  weights?: number[];
  widths?: number[];
  opsz?: number[];
}

const WGHT_STOPS = [400, 700, 500, 600, 300, 800, 900, 200, 100, 350, 450, 550, 650, 750, 850];
const WDTH_STOPS = [100, 87.5, 75, 62.5, 112.5, 125];
const OPSZ_STOPS = [14, 12, 16, 11, 10, 18, 20, 24, 9, 8, 32, 36, 48, 72];

function clampAxis(values: number[], min: number, max: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of values) {
    const v = Math.max(min, Math.min(max, raw));
    const key = Math.round(v * 10);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v);
    }
  }
  return out;
}

/**
 * Finds the best variable-font axis coordinates (`wght`, `wdth`, `opsz`) for `pdfFont` by testing
 * a tiny sample of used characters first, then returning only the top instance(s) for full check.
 */
export function bestVariationFont(pdfFont: PdfFont, base: LoadedFont, hints: VariationHints = {}): LoadedFont {
  const wghtAxis = base.axes.wght;
  const wdthAxis = base.axes.wdth;
  const opszAxis = base.axes.opsz;
  if (!wghtAxis && !wdthAxis && !opszAxis) return base;

  const info = embeddedInfo(pdfFont);
  const samples: { cp: number; width: number; eg: number; path: string; adv: number }[] = [];
  for (const code of pdfFont.used) {
    const u = pdfFont.unicode(code);
    const cps = u ? Array.from(u) : [];
    const cp = cps.length === 1 ? cps[0].codePointAt(0)! : 0;
    const width = pdfFont.width(code);
    const eg = info ? embeddedGlyph(pdfFont, info, code) : 0;
    const path = info && eg > 0 && eg < info.font.glyphCount ? info.font.path(eg) : '';
    const adv = info && eg > 0 && eg < info.font.glyphCount ? info.font.advance1000(eg) : width;
    if (info && !path) continue;
    if (!info && (!cp || width <= 0)) continue;
    if (cp && !base.glyphFor(cp) && (!eg || eg >= base.glyphCount)) continue;
    samples.push({ cp, width, eg, path, adv });
    if (samples.length >= 4) break;
  }

  const fullVars = (partial: Record<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const tag in base.axes) out[tag] = partial[tag] ?? base.axes[tag].default;
    return out;
  };

  if (!samples.length) {
    const pin: Record<string, number> = {};
    if (wghtAxis && hints.weights?.length) pin.wght = clampAxis(hints.weights, wghtAxis.min, wghtAxis.max)[0];
    if (wdthAxis && hints.widths?.length) pin.wdth = clampAxis(hints.widths, wdthAxis.min, wdthAxis.max)[0];
    if (opszAxis && hints.opsz?.length) pin.opsz = clampAxis(hints.opsz, opszAxis.min, opszAxis.max)[0];
    return Object.keys(pin).length ? base.withVariations(fullVars(pin)) : base;
  }

  const scoreAt = (vars: Record<string, number>): { outlines: number; widths: number; font: LoadedFont } => {
    const cand = base.withVariations(fullVars(vars));
    let outlines = 0;
    let widths = 0;
    for (const s of samples) {
      const gs: number[] = [];
      if (s.cp) {
        const g = cand.glyphFor(s.cp);
        if (g) gs.push(g);
      }
      if (s.eg > 0 && s.eg < cand.glyphCount && !gs.includes(s.eg)) gs.push(s.eg);
      for (const g of gs) {
        const wOk = near(cand.advance1000(g), s.adv) || (s.width > 0 && near(cand.advance1000(g), s.width));
        if (!wOk) continue;
        widths++;
        if (s.path && info && info.font.upem === cand.upem && sameOutline(s.path, cand.path(g), 1.5)) {
          outlines++;
        }
        break;
      }
    }
    return { outlines, widths, font: cand };
  };

  let bestVars: Record<string, number> = {};
  if (wghtAxis) bestVars.wght = clampAxis([...(hints.weights ?? []), wghtAxis.default], wghtAxis.min, wghtAxis.max)[0];
  if (wdthAxis) bestVars.wdth = clampAxis([...(hints.widths ?? []), wdthAxis.default], wdthAxis.min, wdthAxis.max)[0];
  if (opszAxis) bestVars.opsz = clampAxis([...(hints.opsz ?? []), opszAxis.default], opszAxis.min, opszAxis.max)[0];

  let best = scoreAt(bestVars);
  const target = samples.length;
  const done = () => (info ? best.outlines === target : best.widths === target);
  const better = (a: { outlines: number; widths: number }, b: { outlines: number; widths: number }) =>
    a.outlines !== b.outlines ? a.outlines > b.outlines : a.widths > b.widths;

  const sweepAxis = (tag: string, stops: number[]) => {
    if (done()) return;
    for (const val of stops) {
      const next = { ...bestVars, [tag]: val };
      const r = scoreAt(next);
      if (better(r, best)) {
        best = r;
        bestVars = next;
        if (done()) return;
      }
    }
  };

  if (wdthAxis) sweepAxis('wdth', clampAxis([...(hints.widths ?? []), wdthAxis.default, ...WDTH_STOPS], wdthAxis.min, wdthAxis.max));
  if (wghtAxis) {
    sweepAxis('wght', clampAxis([...(hints.weights ?? []), wghtAxis.default, ...WGHT_STOPS], wghtAxis.min, wghtAxis.max));
    if (!done() && best.widths > 0) {
      const c = bestVars.wght ?? wghtAxis.default;
      sweepAxis('wght', clampAxis([c - 25, c + 25, c - 75, c + 75], wghtAxis.min, wghtAxis.max));
    }
  }
  if (opszAxis) sweepAxis('opsz', clampAxis([...(hints.opsz ?? []), opszAxis.default, ...OPSZ_STOPS], opszAxis.min, opszAxis.max));
  if (!done() && wdthAxis && wghtAxis && bestVars.wdth !== wdthAxis.default) {
    sweepAxis('wght', clampAxis([...(hints.weights ?? []), ...WGHT_STOPS], wghtAxis.min, wghtAxis.max));
  }
  return best.font;
}

/** Lazily creates the text-recovery helper for a match. */
export function unshaperOf(match: FontMatch): Unshaper {
  if (!match.unshaper) match.unshaper = new Unshaper(match.font);
  return match.unshaper;
}
