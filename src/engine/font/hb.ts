/**
 * HarfBuzz bindings used by the engine: font loading, text shaping, glyph
 * outline fingerprints and subsetting (with variable-font instancing).
 */
import * as hb from 'harfbuzzjs';
import { hashString } from '../util';

export interface ShapedGlyph {
  gid: number;
  /** UTF-16 index of the first character of the cluster this glyph belongs to. */
  cluster: number;
  /** Advance and offsets in font units. */
  ax: number;
  dx: number;
  dy: number;
}

export interface FontMetrics {
  upem: number;
  ascent: number;
  descent: number;
  capHeight: number;
  bbox: [number, number, number, number];
  italicAngle: number;
  weightClass: number;
  /** OS/2 fsType: embedding permission bits. */
  fsType: number;
  fixedPitch: boolean;
}

const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const i16 = (b: Uint8Array, o: number) => {
  const v = u16(b, o);
  return v & 0x8000 ? v - 0x10000 : v;
};
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

export function looksLikeFont(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const tag = u32(bytes, 0);
  return tag === 0x00010000 || tag === 0x4f54544f /* OTTO */ || tag === 0x74727565 /* true */ || tag === 0x74746366 /* ttcf */;
}

export class LoadedFont {
  readonly face: hb.Face;
  readonly font: hb.Font;
  readonly upem: number;
  readonly family: string;
  readonly subfamily: string;
  readonly fullName: string;
  readonly psName: string;
  readonly glyphCount: number;
  readonly isCff: boolean;
  readonly axes: Record<string, { min: number; default: number; max: number }>;
  readonly metrics: FontMetrics;
  private coverage = new Map<number, number>();
  private prints = new Map<number, string>();
  private reverse: Map<number, number[]> | null = null;

  constructor(
    readonly bytes: Uint8Array,
    readonly variations: Record<string, number> = {},
    readonly index = 0,
  ) {
    if (!looksLikeFont(bytes)) throw new Error('Not a TrueType/OpenType font');
    this.face = new hb.Face(new hb.Blob(bytes), index);
    this.font = new hb.Font(this.face);
    this.upem = this.face.upem || 1000;
    const nm = (id: number) => {
      try {
        return this.face.getName(id, 'en') || '';
      } catch {
        return '';
      }
    };
    this.family = nm(16) || nm(1);
    this.subfamily = nm(17) || nm(2);
    this.fullName = nm(4);
    this.psName = nm(6);
    const maxp = this.face.referenceTable('maxp');
    this.glyphCount = maxp && maxp.length >= 6 ? u16(maxp, 4) : 0;
    this.isCff = !!this.face.referenceTable('CFF ') || !!this.face.referenceTable('CFF2');
    this.axes = {};
    try {
      const infos = this.face.getAxisInfos();
      for (const tag in infos) this.axes[tag] = { min: infos[tag].min, default: infos[tag].default, max: infos[tag].max };
    } catch {
      /* static font */
    }
    const vars: hb.Variation[] = [];
    for (const tag in variations) {
      if (!this.axes[tag]) continue;
      const v = hb.Variation.fromString(`${tag}=${variations[tag]}`);
      if (v) vars.push(v);
    }
    if (vars.length) this.font.setVariations(vars);
    this.metrics = this.readMetrics();
  }

  private readMetrics(): FontMetrics {
    const head = this.face.referenceTable('head');
    const os2 = this.face.referenceTable('OS/2');
    const post = this.face.referenceTable('post');
    const ext = this.font.hExtents();
    const bbox: [number, number, number, number] = head && head.length >= 44 ? [i16(head, 36), i16(head, 38), i16(head, 40), i16(head, 42)] : [0, ext.descender, this.upem, ext.ascender];
    let capHeight = 0;
    let weightClass = 400;
    let fsType = 0;
    if (os2 && os2.length >= 10) {
      weightClass = u16(os2, 4);
      fsType = u16(os2, 8);
      if (u16(os2, 0) >= 2 && os2.length >= 90) capHeight = i16(os2, 88);
    }
    let italicAngle = 0;
    let fixedPitch = false;
    if (post && post.length >= 16) {
      italicAngle = i16(post, 4) + u16(post, 6) / 65536;
      fixedPitch = u32(post, 12) !== 0;
    }
    return {
      upem: this.upem, ascent: ext.ascender, descent: ext.descender, capHeight: capHeight || Math.round(ext.ascender * 0.7),
      bbox, italicAngle, weightClass, fsType, fixedPitch,
    };
  }

  /** Nominal glyph for a code point, 0 when the font does not cover it. */
  glyphFor(cp: number): number {
    let g = this.coverage.get(cp);
    if (g === undefined) {
      g = this.font.nominalGlyph(cp) ?? 0;
      this.coverage.set(cp, g);
    }
    return g;
  }

  covers(text: string): boolean {
    for (const ch of text) {
      const cp = ch.codePointAt(0)!;
      if (cp === 0x200b || cp === 0x200c || cp === 0x200d) continue;
      if (!this.glyphFor(cp)) return false;
    }
    return true;
  }

  /** Advance of a glyph in font units. */
  advance(gid: number): number {
    return this.font.glyphHAdvance(gid);
  }

  /** Advance in thousandths of an em — the unit PDF widths use. */
  advance1000(gid: number): number {
    return (this.font.glyphHAdvance(gid) * 1000) / this.upem;
  }

  shape(text: string): ShapedGlyph[] {
    const buf = new hb.Buffer();
    buf.addText(text);
    buf.guessSegmentProperties();
    hb.shape(this.font, buf);
    const res = buf.getGlyphInfosAndPositions();
    const out: ShapedGlyph[] = new Array(res.length);
    for (let i = 0; i < res.length; i++) {
      const g = res[i];
      out[i] = { gid: g.codepoint, cluster: g.cluster, ax: g.xAdvance ?? 0, dx: g.xOffset ?? 0, dy: g.yOffset ?? 0 };
    }
    return out;
  }

  path(gid: number): string {
    try {
      return this.font.glyphToPath(gid) || '';
    } catch {
      return '';
    }
  }

  /** Outline + advance fingerprint, comparable across subsets of the same font. */
  fingerprint(gid: number): string {
    let p = this.prints.get(gid);
    if (p === undefined) {
      const path = this.path(gid);
      // Blank glyphs (spaces, spacers, joiners) are identified by their advance alone.
      p = path ? `${hashString(path)}:${Math.round(this.advance1000(gid))}` : `blank:${Math.round(this.advance1000(gid))}`;
      this.prints.set(gid, p);
    }
    return p;
  }

  /** glyph → code points that map to it through the font's cmap. */
  reverseCmap(): Map<number, number[]> {
    if (this.reverse) return this.reverse;
    const rev = new Map<number, number[]>();
    let cps: Uint32Array;
    try {
      cps = this.face.collectUnicodes();
    } catch {
      cps = new Uint32Array(0);
    }
    for (const cp of cps) {
      const g = this.glyphFor(cp);
      if (!g) continue;
      const list = rev.get(g);
      if (list) list.push(cp);
      else rev.set(g, [cp]);
    }
    this.reverse = rev;
    return rev;
  }

  table(tag: string): Uint8Array | undefined {
    return this.face.referenceTable(tag);
  }

  /** True when the font's licence bits forbid embedding it in documents. */
  get embeddingRestricted(): boolean {
    return (this.metrics.fsType & 0x000f) === 0x0002;
  }

  /** A second handle on the same font data at a different variable-font instance. */
  withVariations(variations: Record<string, number>): LoadedFont {
    return new LoadedFont(this.bytes, variations, this.index);
  }
}

/* ------------------------------------------------------------------ */
/* Subsetting (hb-subset, raw WebAssembly build shipped with harfbuzzjs) */

type SubsetExports = {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  _initialize?: () => void;
  hb_blob_create(ptr: number, len: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(b: number): void;
  hb_blob_get_length(b: number): number;
  hb_blob_get_data(b: number, lenPtr: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(f: number): void;
  hb_face_reference_blob(f: number): number;
  hb_set_add(set: number, v: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(i: number): void;
  hb_subset_input_glyph_set(i: number): number;
  hb_subset_input_set(i: number, which: number): number;
  hb_subset_input_set_flags(i: number, flags: number): void;
  hb_subset_input_pin_axis_location(i: number, face: number, tag: number, value: number): number;
  hb_subset_or_fail(face: number, input: number): number;
};

type WasmSource = ArrayBuffer | Uint8Array;
let subsetLoader: (() => Promise<WasmSource>) | null = null;
let subsetModule: Promise<SubsetExports> | null = null;

/** Tells the engine how to obtain harfbuzz-subset.wasm (fetch in browsers, fs in Node). */
export function setSubsetWasmLoader(loader: () => Promise<WasmSource>): void {
  subsetLoader = loader;
  subsetModule = null;
}

async function getSubsetModule(): Promise<SubsetExports> {
  if (!subsetModule) {
    if (!subsetLoader) throw new Error('Subset module loader not configured');
    const loader = subsetLoader;
    subsetModule = (async () => {
      const src = await loader();
      const { instance } = await WebAssembly.instantiate(src as BufferSource, {});
      const ex = instance.exports as unknown as SubsetExports;
      ex._initialize?.();
      return ex;
    })();
    subsetModule.catch(() => {
      subsetModule = null;
    });
  }
  return subsetModule;
}

const tagNum = (s: string) => ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;

const DROP_TABLES = ['GSUB', 'GPOS', 'GDEF', 'BASE', 'JSTF', 'kern', 'DSIG', 'hdmx', 'VDMX', 'LTSH', 'PCLT', 'meta', 'TSI0', 'TSI1', 'TSI2', 'TSI3', 'TSI5', 'FFTM', 'Silf', 'Glat', 'Gloc', 'Sill', 'Feat'];

/**
 * Produces a subset holding only `gids`, keeping the original glyph ids (so
 * the PDF can address glyphs by the ids the shaper returned). Variable fonts
 * are frozen at `variations`, since PDF cannot embed variable fonts.
 */
export async function subsetFont(bytes: Uint8Array, gids: Iterable<number>, variations: Record<string, number> = {}): Promise<Uint8Array> {
  const X = await getSubsetModule();
  const ptr = X.malloc(bytes.length);
  new Uint8Array(X.memory.buffer).set(bytes, ptr);
  const blob = X.hb_blob_create(ptr, bytes.length, 2 /* WRITABLE */, 0, 0);
  const face = X.hb_face_create(blob, 0);
  const input = X.hb_subset_input_create_or_fail();
  try {
    if (!input) throw new Error('Subsetter unavailable');
    // RETAIN_GIDS | NOTDEF_OUTLINE | NO_LAYOUT_CLOSURE
    X.hb_subset_input_set_flags(input, 0x2 | 0x40 | 0x200);
    const glyphs = X.hb_subset_input_glyph_set(input);
    X.hb_set_add(glyphs, 0);
    for (const g of gids) X.hb_set_add(glyphs, g);
    const drop = X.hb_subset_input_set(input, 3 /* DROP_TABLE_TAG */);
    for (const t of DROP_TABLES) X.hb_set_add(drop, tagNum(t.padEnd(4, ' ')));
    for (const tag in variations) X.hb_subset_input_pin_axis_location(input, face, tagNum(tag), variations[tag]);
    const out = X.hb_subset_or_fail(face, input);
    if (!out) throw new Error('Font subsetting failed');
    const ob = X.hb_face_reference_blob(out);
    const len = X.hb_blob_get_length(ob);
    const dptr = X.hb_blob_get_data(ob, 0);
    const result = new Uint8Array(X.memory.buffer, dptr, len).slice();
    X.hb_blob_destroy(ob);
    X.hb_face_destroy(out);
    return result;
  } finally {
    if (input) X.hb_subset_input_destroy(input);
    X.hb_face_destroy(face);
    X.hb_blob_destroy(blob);
    X.free(ptr);
  }
}
