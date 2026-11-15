/** Small shared helpers: PDF matrices, number formatting, byte utilities. */

/** PDF matrix [a b c d e f] acting on row vectors: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** Returns m × n, i.e. "apply m first, then n" (PDF order, e.g. Tm × CTM). */
export function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Applies only the linear part (no translation) — for direction/size vectors. */
export function applyLinear(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

export function invert(m: Mat): Mat | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export function translate(tx: number, ty: number): Mat {
  return [1, 0, 0, 1, tx, ty];
}

/** Formats a number for a PDF content stream: fixed decimals, no exponent, no trailing zeros. */
export function fmt(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return '0';
  let s = n.toFixed(digits);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0' || s === '') return '0';
  return s;
}

export function fmtMat(m: Mat): string {
  return `${fmt(m[0], 6)} ${fmt(m[1], 6)} ${fmt(m[2], 6)} ${fmt(m[3], 6)} ${fmt(m[4], 4)} ${fmt(m[5], 4)}`;
}

export function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let s = '';
  for (let i = start; i < end; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 8192)) as unknown as number[]);
  }
  return s;
}

export function toLatin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const HEX = '0123456789ABCDEF';
export function hex(bytes: Uint8Array | number[]): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return s;
}

export function hex4(n: number): string {
  return HEX[(n >> 12) & 15] + HEX[(n >> 8) & 15] + HEX[(n >> 4) & 15] + HEX[n & 15];
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** UTF-16BE hex with BOM — the form used for /ActualText and ToUnicode destinations. */
export function utf16beHex(text: string, bom = false): string {
  let s = bom ? 'FEFF' : '';
  for (let i = 0; i < text.length; i++) s += hex4(text.charCodeAt(i));
  return s;
}

/** Decodes a PDF text string (UTF-16BE with BOM, UTF-8 with BOM, else PDFDocEncoding≈Latin-1). */
export function decodePdfText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i + 1] << 8) | bytes[i]);
    return s;
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return latin1(bytes);
}

/** FNV-1a 32-bit hash of a string, as 8 hex chars. Used for glyph-outline fingerprints. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Yields to the event loop so long jobs do not freeze the page. */
export function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** PDF names are bytes; producers that put non-ASCII font names in them use UTF-8. Undo the Latin-1 reading. */
export function utf8IfValid(s: string): string {
  if (!/[\u0080-\u00ff]/.test(s) || /[^\u0000-\u00ff]/.test(s)) return s;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  } catch {
    return s;
  }
}
