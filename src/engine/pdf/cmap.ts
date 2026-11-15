/** Parser for embedded CMap streams: /ToUnicode maps and (simple) /Encoding CMaps. */
import { latin1 } from '../util';

export interface CodeSpace {
  /** Code length in bytes. */
  len: number;
  lo: number;
  hi: number;
}

export interface CMapData {
  codeSpaces: CodeSpace[];
  /** code → Unicode string (from bfchar / bfrange). */
  uni: Map<number, string>;
  /** code → CID (from cidchar / cidrange). */
  cid: Map<number, number>;
  cidRanges: { lo: number; hi: number; cid: number }[];
  wmode: number;
  useCMap: string | null;
}

function hexToUtf16(h: string): string {
  if (h.length <= 2) return String.fromCharCode(parseInt(h || '0', 16));
  if (h.length % 4 !== 0) h = h.padStart(Math.ceil(h.length / 4) * 4, '0');
  let s = '';
  for (let i = 0; i < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  return s;
}

export function parseCMap(bytes: Uint8Array): CMapData {
  const text = latin1(bytes);
  const out: CMapData = { codeSpaces: [], uni: new Map(), cid: new Map(), cidRanges: [], wmode: 0, useCMap: null };
  const re = /<([0-9A-Fa-f\s]*)>|\[|\]|\/[^\s<>\[\]()\/%]+|[A-Za-z][A-Za-z0-9_.-]*|-?\d+(?:\.\d+)?/g;
  type Tok = { t: 'hex'; v: string } | { t: 'kw' | 'name' | 'num' | 'open' | 'close'; v: string };
  const toks: Tok[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) toks.push({ t: 'hex', v: m[1].replace(/\s+/g, '') });
    else if (m[0] === '[') toks.push({ t: 'open', v: '[' });
    else if (m[0] === ']') toks.push({ t: 'close', v: ']' });
    else if (m[0][0] === '/') toks.push({ t: 'name', v: m[0].slice(1) });
    else if (/^-?\d/.test(m[0])) toks.push({ t: 'num', v: m[0] });
    else toks.push({ t: 'kw', v: m[0] });
  }
  let i = 0;
  const until = (end: string, fn: () => void) => {
    while (i < toks.length && !(toks[i].t === 'kw' && toks[i].v === end)) {
      const before = i;
      fn();
      if (i === before) i++;
    }
    i++;
  };
  while (i < toks.length) {
    const tk = toks[i++];
    if (tk.t === 'name' && tk.v === 'WMode' && toks[i]?.t === 'num') out.wmode = parseInt(toks[i].v, 10) || 0;
    if (tk.t !== 'kw') continue;
    switch (tk.v) {
      case 'usecmap': {
        const prev = toks[i - 2];
        if (prev && prev.t === 'name') out.useCMap = prev.v;
        break;
      }
      case 'begincodespacerange':
        until('endcodespacerange', () => {
          const a = toks[i], b = toks[i + 1];
          if (a?.t === 'hex' && b?.t === 'hex') {
            out.codeSpaces.push({ len: Math.max(1, a.v.length >> 1), lo: parseInt(a.v, 16), hi: parseInt(b.v, 16) });
            i += 2;
          }
        });
        break;
      case 'beginbfchar':
        until('endbfchar', () => {
          const a = toks[i], b = toks[i + 1];
          if (a?.t === 'hex' && b?.t === 'hex') {
            out.uni.set(parseInt(a.v, 16), hexToUtf16(b.v));
            i += 2;
          } else if (a?.t === 'hex' && b?.t === 'name') {
            i += 2; // glyph-name destination: not usable here
          }
        });
        break;
      case 'beginbfrange':
        until('endbfrange', () => {
          const a = toks[i], b = toks[i + 1], c = toks[i + 2];
          if (a?.t !== 'hex' || b?.t !== 'hex') return;
          const lo = parseInt(a.v, 16);
          const hi = Math.min(parseInt(b.v, 16), lo + 0xffff);
          if (c?.t === 'hex') {
            const base = hexToUtf16(c.v);
            const head = base.slice(0, -1);
            const last = base.charCodeAt(base.length - 1);
            for (let code = lo; code <= hi; code++) out.uni.set(code, head + String.fromCharCode((last + code - lo) & 0xffff));
            i += 3;
          } else if (c?.t === 'open') {
            i += 3;
            let code = lo;
            while (i < toks.length && toks[i].t !== 'close') {
              const d = toks[i++];
              if (d.t === 'hex' && code <= hi) out.uni.set(code, hexToUtf16(d.v));
              code++;
            }
            i++;
          }
        });
        break;
      case 'begincidchar':
        until('endcidchar', () => {
          const a = toks[i], b = toks[i + 1];
          if (a?.t === 'hex' && b?.t === 'num') {
            out.cid.set(parseInt(a.v, 16), parseInt(b.v, 10));
            i += 2;
          }
        });
        break;
      case 'begincidrange':
        until('endcidrange', () => {
          const a = toks[i], b = toks[i + 1], c = toks[i + 2];
          if (a?.t === 'hex' && b?.t === 'hex' && c?.t === 'num') {
            out.cidRanges.push({ lo: parseInt(a.v, 16), hi: parseInt(b.v, 16), cid: parseInt(c.v, 10) });
            i += 3;
          }
        });
        break;
    }
  }
  return out;
}
