/**
 * Reverse glyph → text map for a font.
 *
 * A PDF stores shaped text as glyph ids. To recover what was typed we need to
 * know, for every glyph, which characters produce it: directly through the
 * cmap, or indirectly through GSUB substitutions (ligatures such as coeng
 * forms, contextual variants, decomposed vowel parts).
 */
import type { LoadedFont } from './hb';

interface Rule {
  out: number;
  seq: number[];
  /** Derived from a one-to-many substitution: only a hint, used when nothing better exists. */
  weak: boolean;
}

function parseGsubRules(t: Uint8Array | undefined): Rule[] {
  const rules: Rule[] = [];
  if (!t || t.length < 10) return rules;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const len = t.length;
  const u16 = (o: number) => (o + 2 <= len ? dv.getUint16(o) : 0);
  const i16 = (o: number) => (o + 2 <= len ? dv.getInt16(o) : 0);
  const u32 = (o: number) => (o + 4 <= len ? dv.getUint32(o) : 0);

  const coverage = (o: number): number[] => {
    const out: number[] = [];
    const format = u16(o);
    if (format === 1) {
      const n = u16(o + 2);
      for (let i = 0; i < n; i++) out.push(u16(o + 4 + 2 * i));
    } else if (format === 2) {
      const n = u16(o + 2);
      for (let i = 0; i < n; i++) {
        const s = u16(o + 4 + 6 * i);
        const e = u16(o + 6 + 6 * i);
        for (let g = s; g <= e && out.length < 70000; g++) out.push(g);
      }
    }
    return out;
  };

  const subtable = (type: number, o: number, depth = 0): void => {
    const format = u16(o);
    if (type === 7) {
      if (format === 1 && depth < 2) subtable(u16(o + 2), o + u32(o + 4), depth + 1);
      return;
    }
    if (type === 1) {
      const cov = coverage(o + u16(o + 2));
      if (format === 1) {
        const delta = i16(o + 4);
        for (const g of cov) rules.push({ out: (g + delta) & 0xffff, seq: [g], weak: false });
      } else if (format === 2) {
        const n = u16(o + 4);
        for (let i = 0; i < n && i < cov.length; i++) rules.push({ out: u16(o + 6 + 2 * i), seq: [cov[i]], weak: false });
      }
    } else if (type === 2 && format === 1) {
      const cov = coverage(o + u16(o + 2));
      const n = u16(o + 4);
      for (let i = 0; i < n && i < cov.length; i++) {
        const so = o + u16(o + 6 + 2 * i);
        const k = u16(so);
        for (let j = 0; j < k; j++) rules.push({ out: u16(so + 2 + 2 * j), seq: j === 0 ? [cov[i]] : [], weak: k > 1 });
      }
    } else if (type === 3 && format === 1) {
      const cov = coverage(o + u16(o + 2));
      const n = u16(o + 4);
      for (let i = 0; i < n && i < cov.length; i++) {
        const so = o + u16(o + 6 + 2 * i);
        const k = u16(so);
        for (let j = 0; j < k; j++) rules.push({ out: u16(so + 2 + 2 * j), seq: [cov[i]], weak: false });
      }
    } else if (type === 4 && format === 1) {
      const cov = coverage(o + u16(o + 2));
      const n = u16(o + 4);
      for (let i = 0; i < n && i < cov.length; i++) {
        const so = o + u16(o + 6 + 2 * i);
        const k = u16(so);
        for (let j = 0; j < k; j++) {
          const lo = so + u16(so + 2 + 2 * j);
          const comp = u16(lo + 2);
          const seq = [cov[i]];
          for (let c = 1; c < comp; c++) seq.push(u16(lo + 4 + 2 * (c - 1)));
          rules.push({ out: u16(lo), seq, weak: false });
        }
      }
    }
  };

  const lookupList = u16(8);
  const count = u16(lookupList);
  for (let i = 0; i < count; i++) {
    const lo = lookupList + u16(lookupList + 2 + 2 * i);
    const type = u16(lo);
    const subCount = u16(lo + 4);
    for (let s = 0; s < subCount; s++) subtable(type, lo + u16(lo + 6 + 2 * s));
  }
  return rules;
}

const isPrivateUse = (cp: number) => (cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000;

/** glyph id → candidate source strings, best first. */
export function buildGlyphTextMap(font: LoadedFont): Map<number, string[]> {
  const rev = new Map<number, string[]>();
  const privateUse = new Map<number, string[]>();
  for (const [gid, cps] of font.reverseCmap()) {
    const sorted = [...cps].sort((a, b) => a - b);
    const real = sorted.filter((cp) => !isPrivateUse(cp)).map((cp) => String.fromCodePoint(cp));
    const pua = sorted.filter(isPrivateUse).map((cp) => String.fromCodePoint(cp));
    if (real.length) rev.set(gid, real);
    if (pua.length) privateUse.set(gid, pua);
  }
  const rules = parseGsubRules(font.table('GSUB'));
  const applyRules = (weak: boolean): boolean => {
    let changed = false;
    for (const r of rules) {
      if (r.weak !== weak) continue;
      let s = '';
      let ok = true;
      for (const g of r.seq) {
        const alts = rev.get(g);
        if (!alts) {
          ok = false;
          break;
        }
        s += alts[0];
      }
      if (!ok) continue;
      const cur = rev.get(r.out);
      if (!cur) {
        rev.set(r.out, [s]);
        changed = true;
      } else if (!weak && cur.length < 4 && !cur.includes(s)) {
        cur.push(s);
        changed = true;
      }
    }
    return changed;
  };
  const settle = () => {
    for (let round = 0; round < 6; round++) {
      const a = applyRules(false);
      const b = applyRules(true);
      if (!a && !b) break;
    }
  };
  // Real characters first: fonts often expose helper glyphs (vowel halves…) at private-use
  // code points too, but text should come back as the characters a person would type.
  settle();
  let added = false;
  for (const [gid, pua] of privateUse) {
    const cur = rev.get(gid);
    if (!cur) {
      rev.set(gid, pua);
      added = true;
    } else for (const p of pua) if (cur.length < 4) cur.push(p);
  }
  if (added) settle();
  return rev;
}
