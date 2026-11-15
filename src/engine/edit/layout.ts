/**
 * Lays out new text: decides which font draws each piece (the PDF's own
 * embedded glyphs when they suffice, otherwise the matched full font, otherwise
 * a fallback), shapes it with HarfBuzz and returns positioned glyphs ready to
 * be written into a content stream.
 */
import type { LoadedFont } from '../font/hb';
import type { FontMatch } from '../font/match';
import type { PdfFont } from '../pdf/fonts';

/** All numbers are in thousandths of an em. */
export interface OutGlyph {
  bytes: Uint8Array;
  /** Advance the viewer will apply by itself (the PDF font's declared width). */
  nat: number;
  /** Advance the shaper wants. */
  adv: number;
  dx: number;
  dy: number;
}

export interface OutSegment {
  fontRes: string;
  glyphs: OutGlyph[];
  /** Glyph ranges that need /ActualText to be read back correctly. */
  spans: { from: number; to: number; text: string }[];
  width: number;
  /** What drew this segment — reported to the UI. */
  via: 'embedded' | 'matched' | 'substitute';
  fontLabel: string;
}

/** A font that will be embedded (as a subset) because new text needs it. */
export interface NewFontUse {
  resName: string;
  font: LoadedFont;
  gids: Set<number>;
  /** glyph id → text, for the /ToUnicode map. */
  uni: Map<number, string>;
}

export interface CascadeItem {
  /** Font resource already present in the page (null for fonts we add). */
  pdfFont: PdfFont | null;
  resName: string | null;
  match: FontMatch | null;
  /** Full font used for shaping; null when only the embedded subset is usable. */
  full: LoadedFont | null;
  label: string;
  substitute: boolean;
}

export interface LayoutEnv {
  newFont(font: LoadedFont): NewFontUse;
}

const KHMER = /[\u1780-\u17ff\u19e0-\u19ff]/;
const COMPLEX = /[\u0590-\u08ff\u0900-\u0dff\u1000-\u109f\u1780-\u17ff\u19e0-\u19ff]/;
const MARK = /^[\p{M}\u200c\u200d]$/u;
const LINKERS = new Set([0x17d2, 0x1039, 0x094d, 0x09cd, 0x0a4d, 0x0acd, 0x0b4d, 0x0bcd, 0x0c4d, 0x0ccd, 0x0d4d, 0x0dca, 0x1a60, 0xa9c0]);
const COMMON = /^[\s\d!-/:-@[-`{-~\u00a0\u2000-\u206f]+$/;

/** True when `ch` attaches to what precedes it (so text must not be cut in front of it). */
export function attachesBackward(ch: string): boolean {
  return MARK.test(ch);
}

/** True when `ch` joins what follows it into the same cluster (Khmer coeng and similar). */
export function joinsForward(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return LINKERS.has(cp) || cp === 0x200d;
}

/** Splits text into orthographic clusters (base + marks, coeng-linked consonants kept together). */
export function splitClusters(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let link = false;
  for (const ch of text) {
    if (cur && !link && !attachesBackward(ch)) {
      out.push(cur);
      cur = '';
    }
    cur += ch;
    link = joinsForward(ch);
  }
  if (cur) out.push(cur);
  return out;
}

const simpleOnlyCache = new WeakMap<PdfFont, boolean>();
/** A PDF font whose own Unicode table can be trusted for reuse: it draws no complex-script text. */
function isSimpleScriptFont(f: PdfFont): boolean {
  let v = simpleOnlyCache.get(f);
  if (v === undefined) {
    v = true;
    for (const code of f.used) {
      const u = f.unicode(code);
      if (u && COMPLEX.test(u)) {
        v = false;
        break;
      }
    }
    simpleOnlyCache.set(f, v);
  }
  return v;
}

function reuseCovers(f: PdfFont, text: string): boolean {
  if (COMPLEX.test(text) || !isSimpleScriptFont(f)) return false;
  const rev = f.reverseUnicode();
  for (const ch of text) if (!rev.has(ch)) return false;
  return true;
}

function itemCovers(item: CascadeItem, cluster: string): boolean {
  if (item.full) return item.full.covers(cluster);
  return !!item.pdfFont && reuseCovers(item.pdfFont, cluster);
}

export interface LayoutResult {
  segments: OutSegment[];
  width: number;
  /** Characters no available font could draw. */
  missing: string[];
}

export function layoutText(text: string, cascade: CascadeItem[], env: LayoutEnv): LayoutResult {
  const missing: string[] = [];
  const segments: OutSegment[] = [];
  if (!text || !cascade.length) return { segments, width: 0, missing };

  // 1. Assign a cascade item to every cluster.
  const khmerOrder = [...cascade].sort((a, b) => Number(!!b.full?.glyphFor(0x1780)) - Number(!!a.full?.glyphFor(0x1780)));
  const runs: { item: CascadeItem; text: string }[] = [];
  let prev: CascadeItem | null = null;
  for (const cl of splitClusters(text)) {
    let item: CascadeItem | undefined;
    if (COMMON.test(cl) && prev && itemCovers(prev, cl)) item = prev;
    else item = (KHMER.test(cl) ? khmerOrder : cascade).find((it) => itemCovers(it, cl));
    if (!item) {
      item = cascade.find((it) => it.full) ?? cascade[0];
      missing.push(cl);
    }
    const last = runs[runs.length - 1];
    if (last && last.item === item) last.text += cl;
    else runs.push({ item, text: cl });
    prev = item;
  }

  // 2. Shape each run and choose how its glyphs are addressed.
  for (const run of runs) {
    const { item } = run;
    const full = item.full;
    if (!full) {
      // Only the embedded subset is available: plain one-to-one text in the PDF's own font.
      const f = item.pdfFont!;
      const rev = f.reverseUnicode();
      const glyphs: OutGlyph[] = [];
      for (const ch of run.text) {
        const code = rev.get(ch);
        if (code === undefined) continue;
        const w = f.width(code);
        glyphs.push({ bytes: f.codeBytes(code), nat: w, adv: w, dx: 0, dy: 0 });
      }
      segments.push({ fontRes: item.resName!, glyphs, spans: [], width: glyphs.reduce((a, g) => a + g.adv, 0), via: 'embedded', fontLabel: item.label });
      continue;
    }
    const shaped = full.shape(run.text);
    const k = 1000 / full.upem;
    // Cluster groups → text slices (for ActualText and ToUnicode).
    const starts = [...new Set(shaped.map((g) => g.cluster))].sort((a, b) => a - b);
    const sliceOf = (cluster: number) => {
      const i = starts.indexOf(cluster);
      return run.text.slice(cluster, i + 1 < starts.length ? starts[i + 1] : run.text.length);
    };

    // Reuse glyphs that are already embedded in the PDF when every glyph is there.
    const siblings = cascade.filter((it) => it.pdfFont && it.resName && it.match && it.match.font === full && it.match.evidence === 'outline');
    let reuse: { item: CascadeItem; code: number }[] | null = siblings.length ? [] : null;
    if (reuse) {
      let lastSib = null as CascadeItem | null;
      for (const g of shaped) {
        let hit = null as { item: CascadeItem; code: number } | null;
        const order: CascadeItem[] = lastSib ? [lastSib, ...siblings.filter((s) => s !== lastSib)] : siblings;
        for (const sib of order) {
          const code = sib.match!.gidToCode.get(g.gid);
          if (code !== undefined) {
            hit = { item: sib, code };
            break;
          }
        }
        if (!hit) {
          reuse = null;
          break;
        }
        reuse.push(hit);
        lastSib = hit.item;
      }
    }
    if (!reuse && item.pdfFont && item.resName && (!item.match || item.match.evidence !== 'outline') && reuseCovers(item.pdfFont, run.text)) {
      // No verified full font, but the PDF's own font has every character: keep the original glyphs.
      const f = item.pdfFont;
      const rev = f.reverseUnicode();
      const glyphs: OutGlyph[] = [];
      for (const ch of run.text) {
        const code = rev.get(ch)!;
        const w = f.width(code);
        glyphs.push({ bytes: f.codeBytes(code), nat: w, adv: w, dx: 0, dy: 0 });
      }
      segments.push({ fontRes: item.resName, glyphs, spans: [], width: glyphs.reduce((a, g) => a + g.adv, 0), via: 'embedded', fontLabel: item.label });
      continue;
    }

    let seg: OutSegment | null = null;
    let use: NewFontUse | null = null;
    let segStartGlyph = 0;
    const flushSpans = (s: OutSegment, from: number, to: number, base: number) => {
      // group glyphs [from,to) of `shaped` by cluster; base = index offset into s.glyphs
      let i = from;
      while (i < to) {
        let j = i + 1;
        while (j < to && shaped[j].cluster === shaped[i].cluster) j++;
        const txt = sliceOf(shaped[i].cluster);
        const cps = Array.from(txt);
        let simple = j - i === 1 && cps.length === 1;
        if (simple) {
          if (use) simple = full.glyphFor(cps[0].codePointAt(0)!) === shaped[i].gid;
          else simple = reuse![i].item.pdfFont!.unicode(reuse![i].code) === txt;
        }
        if (!simple) {
          const lastSpan = s.spans[s.spans.length - 1];
          if (lastSpan && lastSpan.to === i - base) {
            lastSpan.to = j - base;
            lastSpan.text += txt;
          } else s.spans.push({ from: i - base, to: j - base, text: txt });
        }
        i = j;
      }
    };
    for (let gi = 0; gi < shaped.length; gi++) {
      const g = shaped[gi];
      let fontRes: string;
      let bytes: Uint8Array;
      let nat: number;
      if (reuse) {
        const r = reuse[gi];
        fontRes = r.item.resName!;
        bytes = r.item.pdfFont!.codeBytes(r.code);
        nat = r.item.pdfFont!.width(r.code);
      } else {
        use = use ?? env.newFont(full);
        fontRes = use.resName;
        bytes = Uint8Array.of(g.gid >> 8, g.gid & 0xff);
        nat = full.advance1000(g.gid);
        use.gids.add(g.gid);
      }
      // Never split a cluster across segments.
      const sameCluster = gi > 0 && shaped[gi - 1].cluster === g.cluster;
      if (!seg || (seg.fontRes !== fontRes && !sameCluster)) {
        if (seg) flushSpans(seg, segStartGlyph, gi, segStartGlyph);
        seg = { fontRes, glyphs: [], spans: [], width: 0, via: reuse ? 'embedded' : item.substitute ? 'substitute' : 'matched', fontLabel: item.label };
        segments.push(seg);
        segStartGlyph = gi;
      }
      seg.glyphs.push({ bytes, nat, adv: g.ax * k, dx: g.dx * k, dy: g.dy * k });
      seg.width += g.ax * k;
    }
    if (seg) flushSpans(seg, segStartGlyph, shaped.length, segStartGlyph);
    if (use) {
      // ToUnicode entries for glyphs that stand for exactly one cluster.
      let i = 0;
      while (i < shaped.length) {
        let j = i + 1;
        while (j < shaped.length && shaped[j].cluster === shaped[i].cluster) j++;
        if (j - i === 1 && !use.uni.has(shaped[i].gid)) use.uni.set(shaped[i].gid, sliceOf(shaped[i].cluster));
        i = j;
      }
    }
  }
  return { segments, width: segments.reduce((a, s) => a + s.width, 0), missing };
}
