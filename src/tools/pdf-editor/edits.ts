/** The editor's own picture of what the user changed, and helpers that reason about lines. */
import type { DocEdits, EditorDocument, Line } from '../../engine/document';
import type { CatalogEntry } from '../../engine/font/library';
import type { PageGeom } from './geometry';

export type RGB = [number, number, number];

export interface LineEditState {
  text: string;
  color?: RGB;
  /** Size multiplier chosen by the user. */
  scale?: number;
  fontId?: string;
  weight?: number;
  /** 0 = start stays put, 0.5 = centre, 1 = end. */
  align: number;
  /** Shrink automatically so the line never runs past the space it has. */
  fit?: boolean;
  /** The shrink factor auto-fit settled on. */
  fitScale?: number;
}

export interface BoxState {
  id: string;
  x: number;
  y: number;
  dir: [number, number];
  text: string;
  fontId: string;
  weight: number;
  size: number;
  color: RGB;
}

export interface PageEdits {
  lines: Record<string, LineEditState>;
  boxes: BoxState[];
}

export type Edits = Record<number, PageEdits>;

export type Target = { kind: 'line'; page: number; id: string } | { kind: 'box'; page: number; id: string };

export const EMPTY_PAGE: PageEdits = { lines: {}, boxes: [] };

export const effectiveScale = (e: LineEditState): number => (e.scale ?? 1) * (e.fit ? (e.fitScale ?? 1) : 1);

/** True when an edit leaves its line exactly as it was. */
export function isNoop(e: LineEditState, line: Line): boolean {
  return e.text === line.text && !e.color && !e.fontId && Math.abs((e.scale ?? 1) - 1) < 1e-4 && !e.fit;
}

export function toDocEdits(edits: Edits): DocEdits {
  const pages: DocEdits['pages'] = new Map();
  for (const key of Object.keys(edits)) {
    const pe = edits[+key];
    const lines = new Map<string, { text: string; color?: RGB; scale?: number; fontId?: string; weight?: number; align?: number }>();
    for (const id of Object.keys(pe.lines)) {
      const e = pe.lines[id];
      const scale = effectiveScale(e);
      lines.set(id, { text: e.text, color: e.color, scale: Math.abs(scale - 1) > 1e-4 ? scale : undefined, fontId: e.fontId, weight: e.weight, align: e.align });
    }
    const boxes = pe.boxes.filter((b) => b.text.trim() !== '');
    if (lines.size || boxes.length) pages.set(+key, { lines, boxes });
  }
  return { pages };
}

export function hasEdits(edits: Edits): boolean {
  for (const key of Object.keys(edits)) {
    const pe = edits[+key];
    if (Object.keys(pe.lines).length || pe.boxes.some((b) => b.text.trim() !== '')) return true;
  }
  return false;
}

export function countEdits(edits: Edits): number {
  let n = 0;
  for (const key of Object.keys(edits)) {
    const pe = edits[+key];
    n += Object.keys(pe.lines).length + pe.boxes.filter((b) => b.text.trim() !== '').length;
  }
  return n;
}

/** Changes one page's edits immutably; pages left without edits are dropped. */
export function withPage(edits: Edits, page: number, fn: (pe: PageEdits) => PageEdits): Edits {
  const cur = edits[page] ?? EMPTY_PAGE;
  const next = fn(cur);
  if (next === cur) return edits;
  const out = { ...edits };
  if (!Object.keys(next.lines).length && !next.boxes.length) delete out[page];
  else out[page] = next;
  return out;
}

const dot = (a: readonly [number, number], b: readonly [number, number]) => a[0] * b[0] + a[1] * b[1];

interface Extent {
  s0: number;
  s1: number;
  /** Position of the baseline across the writing direction. */
  base: number;
}

function extentAlong(line: Line, ref: Line): Extent {
  const s0 = dot(line.origin, ref.dir);
  return { s0, s1: s0 + line.length, base: dot(line.origin, ref.normal) };
}

const sameFlow = (a: Line, b: Line) => dot(a.dir, b.dir) > 0.999;

/**
 * How the line sits among its neighbours — so that a centred title stays
 * centred and a right-aligned date keeps its right edge when the text changes.
 */
export function guessAlign(line: Line, lines: Line[], geom: PageGeom | null): number {
  const me = extentAlong(line, line);
  const mid = (me.s0 + me.s1) / 2;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.8;
  let sharesStart = false;
  let sharesEnd = false;
  let sharesCentre = false;
  for (const o of lines) {
    if (o === line || !o.text.trim() || !sameFlow(o, line)) continue;
    const e = extentAlong(o, line);
    // Pieces of the same row (table cells, tab stops) say nothing about alignment.
    if (Math.abs(e.base - me.base) < 0.5 * Math.max(line.size, o.size)) continue;
    if (near(e.s0, me.s0)) sharesStart = true;
    if (near(e.s1, me.s1)) sharesEnd = true;
    if (near((e.s0 + e.s1) / 2, mid)) sharesCentre = true;
  }
  if (sharesStart) return 0;
  if (!sharesCentre && geom) {
    const [x0, y0, x1, y1] = geom.viewBox;
    const corners = [dot([x0, y0], line.dir), dot([x1, y0], line.dir), dot([x1, y1], line.dir), dot([x0, y1], line.dir)];
    const lo = Math.min(...corners);
    const hi = Math.max(...corners);
    if (Math.abs(mid - (lo + hi) / 2) < 0.006 * (hi - lo) && me.s0 - lo > 0.12 * (hi - lo)) sharesCentre = true;
  }
  if (sharesCentre) return 0.5;
  if (sharesEnd) return 1;
  return 0;
}

/**
 * The longest this line may become before it collides with something: the
 * next piece of text on the same row, or the edge of the page's text area.
 */
export function maxLength(line: Line, lines: Line[], align: number, geom: PageGeom | null): number {
  const me = extentAlong(line, line);
  let blockMin = me.s0;
  let blockMax = me.s1;
  let left = -Infinity;
  let right = Infinity;
  for (const o of lines) {
    if (o === line || !o.text.trim() || !sameFlow(o, line)) continue;
    const e = extentAlong(o, line);
    blockMin = Math.min(blockMin, e.s0);
    blockMax = Math.max(blockMax, e.s1);
    if (Math.abs(e.base - me.base) < 0.6 * Math.max(line.size, o.size)) {
      if (e.s0 >= me.s1 - 0.01) right = Math.min(right, e.s0);
      if (e.s1 <= me.s0 + 0.01) left = Math.max(left, e.s1);
    }
  }
  let pageMin = blockMin;
  let pageMax = blockMax;
  if (geom) {
    const [x0, y0, x1, y1] = geom.viewBox;
    const corners = [dot([x0, y0], line.dir), dot([x1, y0], line.dir), dot([x1, y1], line.dir), dot([x0, y1], line.dir)];
    pageMin = Math.min(...corners);
    pageMax = Math.max(...corners);
  }
  const span = Math.max(1, pageMax - pageMin);
  // Mirror the margin of the opposite side when the text block itself stops short.
  const leftMargin = Math.min(Math.max(blockMin - pageMin, 0), 0.12 * span);
  const rightMargin = Math.min(Math.max(pageMax - blockMax, 0), 0.12 * span);
  const gap = 0.35 * line.size;
  const rightLimit = Math.min(right - gap, Math.max(blockMax, pageMax - leftMargin));
  const leftLimit = Math.max(left + gap, Math.min(blockMin, pageMin + rightMargin));
  const after = Math.max(0, rightLimit - me.s1);
  const before = Math.max(0, me.s0 - leftLimit);
  const a = Math.min(1, Math.max(0, align));
  const growth = a <= 0 ? after : a >= 1 ? before : Math.min(before / a, after / (1 - a));
  return line.length + growth;
}

export interface FontOption {
  /** "<catalogue id>|<weight>" */
  value: string;
  label: string;
  group: 'doc' | 'builtin' | 'user';
  entry: CatalogEntry;
  weight: number;
}

export const fontValue = (id: string, weight: number) => `${id}|${weight}`;

/** Fonts offered for new text: the document's own (matched) fonts first, then everything built in. */
export function fontOptions(doc: EditorDocument): FontOption[] {
  const out: FontOption[] = [];
  const seen = new Set<string>();
  const add = (entry: CatalogEntry, weight: number, label: string, group: FontOption['group']) => {
    const value = fontValue(entry.id, weight);
    if (seen.has(value)) return;
    seen.add(value);
    out.push({ value, label, group, entry, weight });
  };
  const styled = (e: CatalogEntry, weight: number) => (e.axes?.wght ? `${e.family}${weight >= 600 ? ' Bold' : ''}` : e.style && e.style !== 'Regular' ? `${e.family} ${e.style}` : e.family);
  for (const df of doc.fonts) {
    const m = df.match;
    if (!m || m.quality === 'substitute' || df.spacing) continue;
    const w = m.entry.axes?.wght ? df.name.weight : m.entry.weight;
    add(m.entry, w, styled(m.entry, w), 'doc');
  }
  for (const e of doc.library.userFonts()) if (e.source === 'upload') add(e, e.weight, styled(e, e.weight), 'user');
  const builtIn = [...doc.library.builtIn()].sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight || +a.italic - +b.italic);
  for (const e of builtIn) {
    if (e.axes?.wght) {
      add(e, 400, styled(e, 400), 'builtin');
      if (e.axes.wght[1] >= 700) add(e, 700, styled(e, 700), 'builtin');
    } else add(e, e.weight, styled(e, e.weight), 'builtin');
  }
  return out;
}

export const rgbToHex = (c: RGB): string => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

export function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0, 0, 0];
}

export const sameColor = (a: RGB | null | undefined, b: RGB | null | undefined): boolean =>
  !!a && !!b && Math.abs(a[0] - b[0]) < 0.004 && Math.abs(a[1] - b[1]) < 0.004 && Math.abs(a[2] - b[2]) < 0.004;
