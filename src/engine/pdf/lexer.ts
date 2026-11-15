/**
 * Content-stream tokenizer.
 *
 * Turns the bytes of a PDF content stream into a flat list of operators, each
 * with its operands and — crucially for editing — the exact byte range it
 * occupies, so a single operator can later be replaced without touching the
 * rest of the stream.
 */
import { fmt, hex } from '../util';

export class PName {
  constructor(public readonly name: string) {}
}
export class PStr {
  constructor(public readonly bytes: Uint8Array) {}
}
export class PDict {
  constructor(public readonly map: Map<string, PObj>) {}
}
export type PObj = number | boolean | null | PName | PStr | PObj[] | PDict;

export interface Op {
  /** Operator keyword, e.g. "Tj", "BT", "cm". Inline images are reported as a single "BI". */
  op: string;
  args: PObj[];
  /** Byte offset of the first operand (or of the keyword when there are none). */
  start: number;
  /** Byte offset just past the keyword. */
  end: number;
}

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const isRegular = (c: number) => !WS[c] && !DELIM[c];

export function parseContent(data: Uint8Array): Op[] {
  const n = data.length;
  const ops: Op[] = [];
  let pos = 0;

  const skipWs = () => {
    while (pos < n) {
      const c = data[pos];
      if (WS[c]) pos++;
      else if (c === 0x25) {
        while (pos < n && data[pos] !== 10 && data[pos] !== 13) pos++;
      } else break;
    }
  };

  const readRegular = (): string => {
    const s = pos;
    while (pos < n && isRegular(data[pos])) pos++;
    let out = '';
    for (let i = s; i < pos; i++) out += String.fromCharCode(data[i]);
    return out;
  };

  const readName = (): PName => {
    pos++; // '/'
    let out = '';
    while (pos < n && isRegular(data[pos])) {
      const c = data[pos];
      if (c === 0x23 && pos + 2 < n) {
        const v = parseInt(String.fromCharCode(data[pos + 1], data[pos + 2]), 16);
        if (!Number.isNaN(v)) {
          out += String.fromCharCode(v);
          pos += 3;
          continue;
        }
      }
      out += String.fromCharCode(c);
      pos++;
    }
    return new PName(out);
  };

  const readLiteralString = (): PStr => {
    pos++; // '('
    const out: number[] = [];
    let depth = 1;
    while (pos < n) {
      let c = data[pos++];
      if (c === 0x5c) {
        if (pos >= n) break;
        c = data[pos++];
        switch (c) {
          case 0x6e: out.push(10); break;
          case 0x72: out.push(13); break;
          case 0x74: out.push(9); break;
          case 0x62: out.push(8); break;
          case 0x66: out.push(12); break;
          case 13: if (data[pos] === 10) pos++; break; // line continuation
          case 10: break;
          default:
            if (c >= 0x30 && c <= 0x37) {
              let v = c - 0x30;
              for (let k = 0; k < 2 && pos < n && data[pos] >= 0x30 && data[pos] <= 0x37; k++) v = v * 8 + (data[pos++] - 0x30);
              out.push(v & 0xff);
            } else out.push(c);
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else if (c === 13) {
        if (data[pos] === 10) pos++;
        out.push(10);
      } else out.push(c);
    }
    return new PStr(Uint8Array.from(out));
  };

  const hexVal = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1);

  const readHexString = (): PStr => {
    pos++; // '<'
    const out: number[] = [];
    let hi = -1;
    while (pos < n) {
      const c = data[pos++];
      if (c === 0x3e) break;
      const v = hexVal(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi << 4);
    return new PStr(Uint8Array.from(out));
  };

  const readNumber = (): number => {
    const s = readRegular();
    let v = parseFloat(s);
    if (Number.isNaN(v)) v = parseFloat(s.replace(/^[+-]+/, (m) => (m.includes('-') ? '-' : ''))) || 0;
    return v;
  };

  const isNumStart = (c: number) => (c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e;

  /** Reads one object; returns undefined at a closing delimiter or a keyword (left unread). */
  const readObject = (): PObj | undefined => {
    skipWs();
    if (pos >= n) return undefined;
    const c = data[pos];
    if (c === 0x2f) return readName();
    if (c === 0x28) return readLiteralString();
    if (c === 0x3c) {
      if (data[pos + 1] === 0x3c) {
        pos += 2;
        const map = new Map<string, PObj>();
        for (;;) {
          skipWs();
          if (pos >= n) break;
          if (data[pos] === 0x3e) {
            pos += data[pos + 1] === 0x3e ? 2 : 1;
            break;
          }
          if (data[pos] !== 0x2f) {
            // malformed: skip a token and keep going
            const before = pos;
            readObject();
            if (pos === before) pos++;
            continue;
          }
          const key = readName().name;
          const val = readObject();
          map.set(key, val === undefined ? null : val);
        }
        return new PDict(map);
      }
      return readHexString();
    }
    if (c === 0x5b) {
      pos++;
      const arr: PObj[] = [];
      for (;;) {
        skipWs();
        if (pos >= n) break;
        if (data[pos] === 0x5d) {
          pos++;
          break;
        }
        const before = pos;
        const v = readObject();
        if (v !== undefined) arr.push(v);
        else if (pos === before) {
          // keyword or stray delimiter inside an array: consume it
          if (isRegular(data[pos])) readRegular();
          else pos++;
        }
      }
      return arr;
    }
    if (isNumStart(c)) return readNumber();
    if (isRegular(c)) {
      const save = pos;
      const kw = readRegular();
      if (kw === 'true') return true;
      if (kw === 'false') return false;
      if (kw === 'null') return null;
      pos = save;
    }
    return undefined;
  };

  const skipInlineImage = (dict: Map<string, PObj>) => {
    // pos is just past "ID"; exactly one whitespace byte separates it from the data.
    if (pos < n && WS[data[pos]]) {
      if (data[pos] === 13 && data[pos + 1] === 10) pos += 2;
      else pos++;
    }
    const len = dict.get('L') ?? dict.get('Length');
    if (typeof len === 'number' && len >= 0 && pos + len <= n) {
      const p = pos + len;
      let q = p;
      while (q < n && WS[data[q]]) q++;
      if (data[q] === 0x45 && data[q + 1] === 0x49) {
        pos = q + 2;
        return;
      }
    }
    for (let i = pos; i + 1 < n; i++) {
      if (data[i] !== 0x45 || data[i + 1] !== 0x49) continue;
      if (i > pos && !WS[data[i - 1]]) continue;
      if (i + 2 < n && !WS[data[i + 2]]) continue;
      // What follows must look like content-stream text, not binary image data.
      let ok = true;
      for (let k = i + 2; k < Math.min(n, i + 14); k++) {
        const b = data[k];
        if (!(WS[b] || (b >= 0x20 && b < 0x7f))) {
          ok = false;
          break;
        }
      }
      if (ok) {
        pos = i + 2;
        return;
      }
    }
    pos = n;
  };

  let args: PObj[] = [];
  let argStart = -1;
  for (;;) {
    skipWs();
    if (pos >= n) break;
    const tokStart = pos;
    const obj = readObject();
    if (obj !== undefined) {
      if (argStart < 0) argStart = tokStart;
      args.push(obj);
      continue;
    }
    if (pos >= n) break;
    const c = data[pos];
    if (!isRegular(c)) {
      pos++; // stray delimiter
      continue;
    }
    const kw = readRegular();
    if (kw === 'BI') {
      const map = new Map<string, PObj>();
      for (;;) {
        skipWs();
        if (pos >= n) break;
        if (data[pos] === 0x2f) {
          const key = readName().name;
          const val = readObject();
          map.set(key, val === undefined ? null : val);
        } else if (isRegular(data[pos])) {
          const k2 = readRegular();
          if (k2 === 'ID') break;
        } else pos++;
      }
      skipInlineImage(map);
      ops.push({ op: 'BI', args: [new PDict(map)], start: tokStart, end: pos });
      args = [];
      argStart = -1;
      continue;
    }
    ops.push({ op: kw, args, start: argStart >= 0 ? argStart : tokStart, end: pos });
    args = [];
    argStart = -1;
  }
  return ops;
}

function serializeName(name: string): string {
  let s = '/';
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i) & 0xff;
    if (c < 0x21 || c > 0x7e || DELIM[c] || c === 0x23) s += '#' + hex([c]);
    else s += String.fromCharCode(c);
  }
  return s;
}

/** Serialises a parsed operand back to PDF syntax. */
export function serialize(obj: PObj): string {
  if (obj === null) return 'null';
  if (typeof obj === 'number') return fmt(obj, 6);
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (obj instanceof PName) return serializeName(obj.name);
  if (obj instanceof PStr) return `<${hex(obj.bytes)}>`;
  if (Array.isArray(obj)) return `[${obj.map(serialize).join(' ')}]`;
  let s = '<<';
  for (const [k, v] of obj.map) s += `${serializeName(k)} ${serialize(v)} `;
  return s + '>>';
}
