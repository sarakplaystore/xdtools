/** Page geometry: mapping between PDF user space and on-screen page pixels. */
export type Mat = [number, number, number, number, number, number];
export type Pt = [number, number];

export interface PageGeom {
  /** Page size in CSS pixels at scale 1. */
  width: number;
  height: number;
  /** PDF user space → page pixels at scale 1 (includes the page's rotation and crop box). */
  transform: Mat;
  /** Visible box of the page in PDF user space. */
  viewBox: [number, number, number, number];
}

export function toScreen(g: PageGeom, scale: number, x: number, y: number): Pt {
  const m = g.transform;
  return [(m[0] * x + m[2] * y + m[4]) * scale, (m[1] * x + m[3] * y + m[5]) * scale];
}

/** Screen-space vector → PDF-space vector. */
export function vecToPdf(g: PageGeom, scale: number, dx: number, dy: number): Pt {
  const [a, b, c, d] = g.transform;
  const det = a * d - b * c || 1;
  const x = dx / scale;
  const y = dy / scale;
  return [(d * x - c * y) / det, (-b * x + a * y) / det];
}

export function toPdf(g: PageGeom, scale: number, x: number, y: number): Pt {
  return vecToPdf(g, scale, x - g.transform[4] * scale, y - g.transform[5] * scale);
}

/** The PDF-space direction that reads left-to-right on screen (differs on rotated pages). */
export function screenRightDir(g: PageGeom): Pt {
  const v = vecToPdf(g, 1, 1, 0);
  const n = Math.hypot(v[0], v[1]) || 1;
  // Snap away floating-point dust so upright pages get exactly [1, 0].
  const snap = (t: number) => (Math.abs(t) < 1e-9 ? 0 : Math.abs(Math.abs(t) - 1) < 1e-9 ? Math.sign(t) : t);
  return [snap(v[0] / n), snap(v[1] / n)];
}

/** A strip along a baseline: from `start` to `start + length`, `ascent` above and `descent` below. */
export interface Band {
  origin: Pt;
  dir: Pt;
  normal: Pt;
  start: number;
  length: number;
  ascent: number;
  descent: number;
}

/** Corners of a band on screen: top-left, top-right, bottom-right, bottom-left (in reading orientation). */
export function bandQuad(g: PageGeom, scale: number, b: Band): Pt[] {
  const at = (s: number, n: number): Pt =>
    toScreen(g, scale, b.origin[0] + b.dir[0] * s + b.normal[0] * n, b.origin[1] + b.dir[1] * s + b.normal[1] * n);
  const s0 = b.start;
  const s1 = b.start + b.length;
  return [at(s0, b.ascent), at(s1, b.ascent), at(s1, -b.descent), at(s0, -b.descent)];
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function bounds(pts: Pt[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export const pointsAttr = (pts: Pt[]) => pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
