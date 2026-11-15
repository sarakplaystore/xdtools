/**
 * "Un-shaping": recovering the Unicode text behind a run of shaped glyphs.
 *
 * Khmer is written in clusters whose glyphs are reordered, fused and replaced
 * by the shaping engine, so the per-glyph Unicode tables inside PDFs are
 * routinely wrong for it. When the original font is known we can do better:
 * map each glyph back to its characters (cmap + GSUB), undo the reordering
 * with the rules of the Khmer shaping model, and then *prove* the result by
 * shaping it again and checking that exactly the same glyphs come out.
 */
import { buildGlyphTextMap } from './gsub';
import type { LoadedFont } from './hb';

export interface RecoveredCluster {
  text: string;
  /** Glyph index range [start, end) in the input sequence. */
  start: number;
  end: number;
  /** True when re-shaping `text` reproduces these glyphs exactly. */
  verified: boolean;
}

const COENG = '\u17d2';
const RO = '\u179a';
const MARK = /^[\p{M}\u200c\u200d]/u;
const SPLIT_VOWELS = /[\u17be\u17bf\u17c0\u17c4\u17c5]/;
const isPreVowel = (s: string) => s === '\u17c1' || s === '\u17c2' || s === '\u17c3';
const isVowelOrSign = (c: number) => (c >= 0x17b6 && c <= 0x17c8) || c === 0x17cb || (c >= 0x17cd && c <= 0x17d1) || c === 0x17dd;

type ItemKind = 'pre' | 'base' | 'post' | 'unknown';
interface Solved {
  text: string;
  verified: boolean;
}
interface Item {
  gid: number;
  alts: string[];
  kind: ItemKind;
}

function classify(s: string | undefined): ItemKind {
  if (s === undefined) return 'unknown';
  if (s === '') return 'post';
  if (isPreVowel(s) || s === COENG + RO) return 'pre';
  if (MARK.test(s)) return 'post';
  return 'base';
}

function canonicalOrder(text: string): string {
  const cps = Array.from(text);
  if (cps.length < 3) return text;
  const tokens: { s: string; cls: number }[] = [];
  for (let i = 1; i < cps.length; i++) {
    const ch = cps[i];
    const c = ch.codePointAt(0)!;
    if (ch === COENG && i + 1 < cps.length) {
      tokens.push({ s: ch + cps[i + 1], cls: cps[i + 1] === RO ? 3 : 2 });
      i++;
    } else if (c === 0x17cc) tokens.push({ s: ch, cls: 1 });
    else if (c === 0x17c9 || c === 0x17ca) tokens.push({ s: ch, cls: 4 });
    else if (c >= 0x17b6 && c <= 0x17c5) tokens.push({ s: ch, cls: 5 });
    else if (isVowelOrSign(c)) tokens.push({ s: ch, cls: 6 });
    else tokens.push({ s: ch, cls: 7 });
  }
  const sorted = tokens.map((t, i) => ({ ...t, i })).sort((a, b) => a.cls - b.cls || a.i - b.i);
  return cps[0] + sorted.map((t) => t.s).join('');
}

export class Unshaper {
  private rev: Map<number, string[]>;
  private cache = new Map<string, Solved>();
  private direct = new Map<number, Solved>();

  constructor(readonly font: LoadedFont) {
    this.rev = buildGlyphTextMap(font);
  }

  /** Candidate source strings for one glyph. */
  textOf(gid: number): string[] | undefined {
    return this.rev.get(gid);
  }

  /**
   * True when shaping `text` yields exactly the glyphs in `gids`. Order inside a
   * cluster is not compared: producers disagree on it (some write pre-base glyphs
   * after their base and step back), while the set of glyphs is what gets drawn.
   */
  private shapesTo(text: string, gids: number[]): boolean {
    if (!text) return false;
    const out = this.font.shape(text);
    if (out.length !== gids.length) return false;
    if (out.length === 1) return out[0].gid === gids[0] || this.font.fingerprint(out[0].gid) === this.font.fingerprint(gids[0]);
    const a = out.map((g) => this.font.fingerprint(g.gid)).sort();
    const b = gids.map((g) => this.font.fingerprint(g)).sort();
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  private candidates(pre: string[], base: string, post: string[]): string[] {
    const out: string[] = [];
    const push = (s: string) => {
      if (s && !out.includes(s)) out.push(s);
    };
    const baseChars = Array.from(base);
    const first = baseChars[0] ?? '';
    const rest = baseChars.slice(1).join('');
    const tail = [rest, ...post].filter((s) => s !== '');
    let pv: string | null = pre.find(isPreVowel) ?? null;
    const cr: string | null = pre.find((s) => s === COENG + RO) ?? null;
    const others = pre.filter((s) => !isPreVowel(s) && s !== COENG + RO).join('');
    if (pv === '\u17c1' && SPLIT_VOWELS.test(tail.join(''))) pv = null; // left half of a two-part vowel

    // Spellings that draw the same glyphs are tried most-canonical first:
    //   េ + ី  → ើ      េ + ា → ោ      lowered "ុ" next to another vowel → the shifter it really is.
    const literal = Array.from(tail.join(''));
    const variants: { chars: string[]; pv: string | null }[] = [];
    let vowelFix: { chars: string[]; pv: string | null } | null = null;
    if (pv === '\u17c1') {
      const at = literal.findIndex((c) => c === '\u17b8' || c === '\u17b6');
      if (at >= 0) {
        const chars = [...literal];
        chars[at] = chars[at] === '\u17b8' ? '\u17be' : '\u17c4';
        vowelFix = { chars, pv: null };
      }
    }
    const shifterFix = (v: { chars: string[]; pv: string | null }) => {
      const at = v.chars.indexOf('\u17bb');
      if (at < 0) return null;
      const otherVowel = v.pv !== null || v.chars.some((c, i) => i !== at && c >= '\u17b6' && c <= '\u17c5');
      if (!otherVowel) return null;
      const order = 'សហអ'.includes(first) ? ['\u17ca', '\u17c9'] : ['\u17c9', '\u17ca'];
      return order.map((sh) => {
        const chars = [...v.chars];
        chars[at] = sh;
        return { chars, pv: v.pv };
      });
    };
    if (vowelFix) variants.push(...(shifterFix(vowelFix) ?? []), vowelFix);
    variants.push(...(shifterFix({ chars: literal, pv }) ?? []));
    for (const v of variants) push(canonicalOrder(others + first + (cr ?? '') + v.chars.join('') + (v.pv ?? '')));

    const build = (roFirst: boolean): string => {
      const g = [...tail];
      if (cr) {
        let at = 0;
        if (!roFirst) for (let i = 0; i < g.length; i++) if (g[i].startsWith(COENG)) at = i + 1;
        g.splice(at, 0, cr);
      }
      if (pv) {
        let at = g.length;
        for (let i = 0; i < g.length; i++) {
          if (isVowelOrSign(g[i].codePointAt(0)!)) {
            at = i;
            break;
          }
        }
        g.splice(at, 0, pv);
      }
      return others + first + g.join('');
    };
    const a = build(false);
    push(canonicalOrder(a));
    push(a);
    push(build(true));
    return out;
  }

  private solveUnit(items: Item[]): Solved {
    const gids = items.map((i) => i.gid);
    if (items.length === 1) {
      const g = gids[0];
      let d = this.direct.get(g);
      if (d === undefined) {
        d = { text: items[0].alts[0] ?? '', verified: false };
        for (const alt of items[0].alts) {
          if (alt && this.shapesTo(alt, gids)) {
            d = { text: alt, verified: true };
            break;
          }
        }
        this.direct.set(g, d);
      }
      return d;
    }
    const key = gids.join(',');
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let found: string | null = null;
    let guess: string | null = null;
    const baseIdx = items.findIndex((i) => i.kind === 'base');
    // Try the best alternative of every glyph first, then single-glyph swaps.
    const choices: number[][] = [items.map(() => 0)];
    for (let i = 0; i < items.length; i++) {
      for (let a = 1; a < Math.min(items[i].alts.length, 3); a++) {
        const c = items.map(() => 0);
        c[i] = a;
        choices.push(c);
      }
    }
    outer: for (const choice of choices) {
      const pre: string[] = [];
      const post: string[] = [];
      let base = '';
      items.forEach((it, i) => {
        const str = it.alts[choice[i]] ?? '';
        if (i === baseIdx) base = str;
        else if (it.kind === 'pre') pre.push(str);
        else post.push(str);
      });
      if (baseIdx < 0) base = post.shift() ?? pre.shift() ?? '';
      for (const cand of this.candidates(pre, base, post)) {
        if (guess === null) guess = cand;
        if (this.shapesTo(cand, gids)) {
          found = cand;
          break outer;
        }
      }
    }
    const res: Solved = found !== null ? { text: found, verified: true } : { text: guess ?? items.map((i) => i.alts[0] ?? '').join(''), verified: false };
    this.cache.set(key, res);
    return res;
  }

  /**
   * Recovers text for a run of glyph ids in stream order (ids in this font's own
   * numbering; -1 marks a glyph that could not be identified). `xs` gives each
   * glyph's pen position along the line and lets pre-base glyphs be attributed
   * to the right cluster whichever order the producer wrote them in. The result
   * partitions the input into clusters.
   */
  unshape(gids: number[], xs?: number[]): RecoveredCluster[] {
    const items: Item[] = [];
    for (let i = 0; i < gids.length; i++) {
      const alts = this.rev.get(gids[i]) ?? [];
      items.push({ gid: gids[i], alts, kind: gids[i] < 0 ? 'unknown' : classify(alts[0]) });
    }
    // A bare coeng followed by a consonant glyph acts as one subscript unit.
    for (let i = 0; i + 1 < items.length; i++) {
      if (items[i].alts[0] === COENG && items[i + 1].kind === 'base') {
        items[i].kind = items[i + 1].alts[0] === RO ? 'pre' : 'post';
        items[i + 1].kind = items[i].kind;
      }
    }
    const units: [number, number][] = [];
    let start = -1;
    let hasBase = false;
    let baseX = 0;
    const close = (end: number) => {
      if (start >= 0 && end > start) units.push([start, end]);
      start = -1;
      hasBase = false;
    };
    for (let i = 0; i < items.length; i++) {
      const k = items[i].kind;
      if (k === 'unknown') {
        close(i);
        units.push([i, i + 1]);
      } else if (k === 'pre') {
        // Drawn to the left of the current base → it is that base's own pre-base glyph,
        // written after it; otherwise it opens the next cluster.
        const ownedByCurrent = start >= 0 && hasBase && !!xs && xs[i] < baseX - 1e-6;
        if (!ownedByCurrent) {
          if (start >= 0 && hasBase) close(i);
          if (start < 0) start = i;
        }
      } else if (k === 'base') {
        if (start >= 0 && hasBase) close(i);
        if (start < 0) start = i;
        hasBase = true;
        baseX = xs ? xs[i] : 0;
      } else if (start < 0) {
        start = i;
        hasBase = true; // stray mark: stands on its own
        baseX = xs ? xs[i] : 0;
      }
    }
    close(items.length);
    units.sort((a, b) => a[0] - b[0]);

    const out: RecoveredCluster[] = [];
    for (const [s, e] of units) {
      const unit = items.slice(s, e);
      if (unit.some((u) => u.kind === 'unknown')) out.push({ text: unit.map((u) => u.alts[0] ?? '').join(''), start: s, end: e, verified: false });
      else out.push({ ...this.solveUnit(unit), start: s, end: e });
    }
    return out;
  }
}
