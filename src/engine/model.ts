/**
 * Page text model: groups the raw text-showing operators of a page into
 * visual lines, and each line into clusters — the smallest pieces of text
 * that can be kept or replaced independently, each tied to its glyphs.
 */
import type { FontMatch } from './font/match';
import { unshaperOf } from './font/match';
import type { PdfFont } from './pdf/fonts';
import type { MarkedSpan, RGB, Rule, ShowOp } from './pdf/interp';
import { apply, applyLinear, mul } from './util';

export interface GlyphRef {
  show: ShowOp;
  /** Index into show.elems. */
  ei: number;
  code: number;
  /** Pen position along the line, in user-space units from the line origin. */
  s: number;
  /** Advance along the line. */
  adv: number;
  /** Offset perpendicular to the baseline (raised/lowered marks). */
  dy: number;
}

export interface Cluster {
  text: string;
  /** Empty for a "virtual" space: a gap that reads as a space but has no glyph. */
  glyphs: GlyphRef[];
  s0: number;
  s1: number;
  /** True when `text` is known to be exactly what these glyphs represent. */
  verified: boolean;
  /** The /ActualText sequence this cluster came from, if any. */
  span: MarkedSpan | null;
}

export interface Line {
  id: string;
  index: number;
  /** Baseline start in PDF user space. */
  origin: [number, number];
  dir: [number, number];
  normal: [number, number];
  /** Dominant font size in user-space units. */
  size: number;
  clusters: Cluster[];
  text: string;
  /** Pen distance from origin to the end of the line. */
  length: number;
  fonts: PdfFont[];
  color: RGB | null;
  ascent: number;
  descent: number;
  /** Every cluster's text is verified. */
  exact: boolean;
}

interface Chunk {
  dir: [number, number];
  normal: [number, number];
  base: [number, number];
  pen: [number, number];
  size: number;
  glyphs: { show: ShowOp; ei: number; code: number; p: [number, number]; adv: number }[];
}

/**
 * An empty jump along the baseline wider than this (in ems) starts a new line: the next table cell,
 * a tab stop, the other column. Space glyphs do not count as a jump, so loosely justified text
 * stays together, while editing one table cell never pushes its neighbours.
 */
const JUMP = 1;

const COMPLEX = /[\u0590-\u08ff\u0900-\u0dff\u1000-\u109f\u1780-\u17ff\u19e0-\u19ff]/;
const hypot = (v: [number, number]) => Math.hypot(v[0], v[1]);
const dot = (a: [number, number], b: [number, number]) => a[0] * b[0] + a[1] * b[1];

/** Splits the page's show operators into runs of glyphs that sit on one visual line. */
function buildChunks(shows: ShowOp[]): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (const show of shows) {
    // Invisible text (OCR layers) and forms drawn more than once are left alone.
    if (show.invisible || show.scope.uses > 1) continue;
    const m = mul(show.tm, show.ctm);
    const ux = applyLinear(m, 1, 0);
    const uy = applyLinear(m, 0, 1);
    const lx = hypot(ux);
    if (lx < 1e-9) continue;
    const flow = show.size * show.th < 0 ? -1 : 1;
    const dir: [number, number] = [(ux[0] / lx) * flow, (ux[1] / lx) * flow];
    const size = Math.abs(show.size) * hypot(uy);
    if (size < 1e-6) continue;
    let first = true;
    for (let ei = 0; ei < show.elems.length; ei++) {
      const e = show.elems[ei];
      if (e.kind !== 'g') continue;
      const p = apply(m, e.x, 0);
      const adv = e.adv * lx * flow;
      let join = false;
      if (cur) {
        const S = Math.max(cur.size, size);
        const along = dot([p[0] - cur.pen[0], p[1] - cur.pen[1]], cur.dir);
        const perp = dot([p[0] - cur.base[0], p[1] - cur.base[1]], cur.normal);
        const sameDir = dot(dir, cur.dir) > 0.9995;
        // Within one operator glyphs always flow on; between operators allow small
        // back-steps (marks placed by explicit moves) but not a jump to a new line.
        join = sameDir && Math.abs(perp) < 0.75 * S && along <= JUMP * S && along >= (first ? -2.5 * S : -6 * S);
      }
      if (!join || !cur) {
        cur = { dir, normal: [-dir[1], dir[0]], base: p, pen: p, size, glyphs: [] };
        chunks.push(cur);
      }
      cur.glyphs.push({ show, ei, code: e.code, p, adv });
      const end: [number, number] = [p[0] + dir[0] * adv, p[1] + dir[1] * adv];
      // Only advance the pen forwards: marks drawn "behind" must not pull it back.
      if (dot([end[0] - cur.pen[0], end[1] - cur.pen[1]], cur.dir) > 0 || cur.glyphs.length === 1) cur.pen = end;
      if (cur.glyphs.length === 1) cur.size = size;
      first = false;
    }
  }
  return chunks;
}

export type MatchLookup = (font: PdfFont) => FontMatch | null;

function buildClusters(glyphs: GlyphRef[], matchOf: MatchLookup): Cluster[] {
  const out: Cluster[] = [];
  const seenSpans = new Set<MarkedSpan>();
  const push = (text: string, gs: GlyphRef[], verified: boolean, span: MarkedSpan | null = null) =>
    out.push({ text, glyphs: gs, s0: 0, s1: 0, verified, span });
  let i = 0;
  while (i < glyphs.length) {
    const g = glyphs[i];
    const span = g.show.span;
    if (span) {
      let j = i + 1;
      while (j < glyphs.length && glyphs[j].show.span === span) j++;
      const first = !seenSpans.has(span);
      seenSpans.add(span);
      push(first ? (span.actualText ?? '') : '', glyphs.slice(i, j), true, span);
      i = j;
      continue;
    }
    const match = matchOf(g.show.font);
    if (match && match.verified > 0) {
      // A run of glyphs that all belong to the same real font (possibly through several
      // PDF font objects): recover the text from the glyphs themselves.
      const gids: number[] = [];
      const xs: number[] = [];
      let j = i;
      while (j < glyphs.length && !glyphs[j].show.span) {
        const mj = glyphs[j].show.font === g.show.font ? match : matchOf(glyphs[j].show.font);
        if (!mj || mj.font !== match.font) break;
        gids.push(mj.codeToGid.get(glyphs[j].code) ?? -1);
        xs.push(glyphs[j].s);
        j++;
      }
      const unshaper = unshaperOf(match);
      for (const c of unshaper.unshape(gids, xs)) {
        const gs = glyphs.slice(i + c.start, i + c.end);
        // A glyph with no known text cannot be spelled out by the guess: the guess would silently
        // lose it (a subscript consonant or vowel disappears from the line).
        const unknownGlyph = gs.some((_, k) => !unshaper.textOf(gids[c.start + k]));
        if (c.verified) push(c.text, gs, true);
        else if (match.evidence !== 'outline' || unknownGlyph || gs.every((_, k) => gids[c.start + k] === -1)) {
          // Not provable from the glyphs: fall back to the PDF's own Unicode table.
          const text = gs.map((x) => x.show.font.unicode(x.code) ?? '').join('');
          push(text, gs, text !== '' && !COMPLEX.test(text));
        } else push(c.text, gs, false);
      }
      i = j;
      continue;
    }
    const text = g.show.font.unicode(g.code) ?? '';
    push(text, [g], text !== '' && !COMPLEX.test(text));
    i++;
  }
  // Glyphs that carry no text of their own ride along with their neighbour.
  const merged: Cluster[] = [];
  for (const c of out) {
    if (c.text === '' && merged.length) {
      const prev = merged[merged.length - 1];
      prev.glyphs = prev.glyphs.concat(c.glyphs);
      if (!c.span) prev.verified = prev.verified && c.verified;
    } else merged.push(c);
  }
  if (merged.length > 1 && merged[0].text === '') {
    merged[1].glyphs = merged[0].glyphs.concat(merged[1].glyphs);
    merged.shift();
  }
  return merged;
}

function finishLine(index: number, chunk: Chunk, from: number, to: number, matchOf: MatchLookup): Line {
  const origin = chunk.glyphs[from].p;
  const { dir, normal } = chunk;
  const glyphs: GlyphRef[] = [];
  for (let i = from; i < to; i++) {
    const g = chunk.glyphs[i];
    const d: [number, number] = [g.p[0] - origin[0], g.p[1] - origin[1]];
    glyphs.push({ show: g.show, ei: g.ei, code: g.code, s: dot(d, dir), adv: g.adv, dy: dot(d, normal) });
  }
  // Dominant size / font / colour by glyph count.
  const sizeCount = new Map<number, number>();
  const fontCount = new Map<PdfFont, number>();
  for (const g of glyphs) {
    const sh = g.show;
    const sz = Math.round(Math.abs(sh.size) * hypot(applyLinear(mul(sh.tm, sh.ctm), 0, 1)) * 100) / 100;
    sizeCount.set(sz, (sizeCount.get(sz) ?? 0) + 1);
    fontCount.set(sh.font, (fontCount.get(sh.font) ?? 0) + 1);
  }
  const size = [...sizeCount].sort((a, b) => b[1] - a[1])[0][0];
  const fonts = [...fontCount].sort((a, b) => b[1] - a[1]).map((f) => f[0]);

  const clusters = buildClusters(glyphs, matchOf);
  const starts = clusters.map((c) => c.glyphs.reduce((m, g) => Math.min(m, g.s), Infinity));
  const withGaps: Cluster[] = [];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    c.s0 = starts[i];
    let ink = c.s0;
    for (const g of c.glyphs) ink = Math.max(ink, g.s + g.adv);
    const hasNext = i + 1 < clusters.length;
    c.s1 = hasNext ? starts[i + 1] : ink;
    withGaps.push(c);
    if (hasNext && starts[i + 1] - ink > 0.22 * size && !/\s$/.test(c.text) && !/^\s/.test(clusters[i + 1].text)) {
      c.s1 = ink;
      withGaps.push({ text: ' ', glyphs: [], s0: ink, s1: starts[i + 1], verified: true, span: null });
    }
    if (c.s1 < c.s0) c.s1 = c.s0;
  }
  const mainFont = fonts[0];
  const asc = mainFont.desc.ascent > 0 ? mainFont.desc.ascent / 1000 : 0.9;
  const desc = mainFont.desc.descent < 0 ? -mainFont.desc.descent / 1000 : 0.3;
  const last = withGaps[withGaps.length - 1];
  const firstShow = glyphs.find((g) => (g.show.font.unicode(g.code) ?? 'x').trim() !== '')?.show ?? glyphs[0].show;
  return {
    id: `L${index}`, index, origin, dir, normal, size, clusters: withGaps,
    text: withGaps.map((c) => c.text).join(''), length: last.s1, fonts, color: firstShow.fill,
    ascent: Math.min(1.35, Math.max(0.7, asc)) * size, descent: Math.min(0.85, Math.max(0.2, desc)) * size,
    exact: withGaps.every((c) => c.verified),
  };
}

/** Text that leaves no ink: spaces of every kind and zero-width characters. */
const BLANK_TEXT = /^[\s\u00a0\u200b-\u200d\u2060\ufeff]+$/;

/**
 * A space (or other inkless glyph) that stands on its own. Lines are trimmed of these at both ends:
 * word processors end almost every line with one, and a whole row of them is not text anyone edits.
 * They stay in the page untouched.
 */
function isLooseBlank(g: Chunk['glyphs'][number]): boolean {
  if (g.show.span) return false; // part of an /ActualText sequence: keep the sequence whole
  const u = g.show.font.unicode(g.code);
  return !!u && BLANK_TEXT.test(u);
}

/**
 * True when a ruling (table border, column separator) crosses the text line between two pen
 * positions: whatever follows belongs to the next cell, however small the gap.
 */
function ruleBetween(rules: Rule[], chunk: Chunk, from: number, to: number): boolean {
  const { base, dir, normal, size } = chunk;
  for (const r of rules) {
    const ax = r[0] - base[0];
    const ay = r[1] - base[1];
    const bx = r[2] - base[0];
    const by = r[3] - base[1];
    const t0 = ax * dir[0] + ay * dir[1];
    const t1 = bx * dir[0] + by * dir[1];
    if (Math.min(t0, t1) < from - 0.05 * size || Math.max(t0, t1) > to + 0.05 * size) continue;
    const u0 = ax * normal[0] + ay * normal[1];
    const u1 = bx * normal[0] + by * normal[1];
    // Upright relative to the text, and tall enough to cut through its x-height band.
    if (Math.abs(t1 - t0) > 0.25 * Math.abs(u1 - u0)) continue;
    if (Math.min(u0, u1) <= 0.2 * size && Math.max(u0, u1) >= 0.45 * size) return true;
  }
  return false;
}

/** Builds the editable lines of a page from its interpreted show operators. */
export function buildLines(shows: ShowOp[], matchOf: MatchLookup, rules: Rule[] = []): Line[] {
  const lines: Line[] = [];
  for (const chunk of buildChunks(shows)) {
    // Split at wide gaps inside a chunk (tab stops, table cells drawn by one operator).
    let from = 0;
    let pen = -Infinity;
    for (let i = 0; i <= chunk.glyphs.length; i++) {
      const g = chunk.glyphs[i];
      let split = i === chunk.glyphs.length;
      if (g && i > from) {
        const s = dot([g.p[0] - chunk.base[0], g.p[1] - chunk.base[1]], chunk.dir);
        if (s - pen > JUMP * chunk.size) split = true;
        else if (rules.length && s - pen > 0.12 * chunk.size && ruleBetween(rules, chunk, pen, s)) split = true;
      }
      if (split && i > from) {
        let a = from;
        let b = i;
        while (b > a && isLooseBlank(chunk.glyphs[b - 1])) b--;
        while (a < b && isLooseBlank(chunk.glyphs[a])) a++;
        if (b > a) lines.push(finishLine(lines.length, chunk, a, b, matchOf));
        from = i;
        pen = -Infinity;
      }
      if (g) {
        const s = dot([g.p[0] - chunk.base[0], g.p[1] - chunk.base[1]], chunk.dir);
        pen = Math.max(pen, s + g.adv);
      }
    }
  }
  return lines;
}
