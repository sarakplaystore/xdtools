/**
 * Model of a font *as the PDF describes it*: how its strings split into
 * character codes, how wide each code is, what Unicode it stands for, and the
 * embedded font program (if any). This is everything needed to follow the
 * text matrix exactly and to re-emit original glyphs untouched.
 */
import { PDFArray, PDFContext, PDFDict, PDFName, PDFNumber, PDFStream } from '@cantoo/pdf-lib';
import { Encodings, Font as StdFont, FontNames } from '@cantoo/pdf-lib/standard-fonts';
import { utf8IfValid } from '../util';
import { CodeSpace, parseCMap } from './cmap';
import { deref, getArray, getDict, getName, getNum, getObj, getStream, nameText, numbersOf, streamData } from './objects';

export interface FontProgram {
  kind: 'truetype' | 'cff' | 'opentype' | 'type1';
  bytes: Uint8Array;
}

export interface FontDescriptorInfo {
  flags: number;
  italicAngle: number;
  stemV: number;
  fontWeight: number;
  ascent: number;
  descent: number;
  capHeight: number;
  fontFamily: string;
  missingWidth: number;
}

let nameTable: Map<string, string> | null = null;
function glyphNames(): Map<string, string> {
  if (nameTable) return nameTable;
  const t = new Map<string, string>();
  const enc = Encodings.WinAnsi;
  for (const cp of enc.supportedCodePoints) {
    try {
      t.set(enc.encodeUnicodeCodePoint(cp).name, String.fromCodePoint(cp));
    } catch {
      /* ignore */
    }
  }
  const extra: Record<string, string> = {
    space: ' ', nbspace: '\u00a0', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', dotlessi: 'ı', dotlessj: 'ȷ',
    Lslash: 'Ł', lslash: 'ł', fraction: '⁄', minus: '−', hungarumlaut: '˝', ogonek: '˛', caron: 'ˇ', breve: '˘',
    dotaccent: '˙', ring: '˚', quotesingle: "'", grave: '`', Euro: '€', sfthyphen: '\u00ad', middot: '·',
    Zcaron: 'Ž', zcaron: 'ž', Scaron: 'Š', scaron: 'š', OE: 'Œ', oe: 'œ', Ydieresis: 'Ÿ', florin: 'ƒ',
    Delta: 'Δ', Omega: 'Ω', mu: 'μ', pi: 'π', approxequal: '≈', notequal: '≠', lessequal: '≤', greaterequal: '≥',
    infinity: '∞', partialdiff: '∂', summation: '∑', product: '∏', radical: '√', integral: '∫', lozenge: '◊',
    apple: '\uf8ff', nonbreakingspace: '\u00a0', hyphenminus: '-', figuredash: '‒', horizontalbar: '―',
  };
  for (const k in extra) if (!t.has(k)) t.set(k, extra[k]);
  nameTable = t;
  return t;
}

/** Glyph name → Unicode text (Adobe glyph-naming conventions, compact subset). */
export function glyphNameToUnicode(name: string): string | undefined {
  const t = glyphNames();
  const direct = t.get(name);
  if (direct !== undefined) return direct;
  let m = /^uni((?:[0-9A-Fa-f]{4})+)$/.exec(name);
  if (m) {
    let s = '';
    for (let i = 0; i < m[1].length; i += 4) s += String.fromCharCode(parseInt(m[1].slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    if (cp <= 0x10ffff) return String.fromCodePoint(cp);
  }
  const dot = name.indexOf('.');
  if (dot > 0) return glyphNameToUnicode(name.slice(0, dot));
  if (name.includes('_')) {
    const parts = name.split('_').map(glyphNameToUnicode);
    if (parts.every((p) => p !== undefined)) return parts.join('');
  }
  return undefined;
}

const STD_UPPER: Record<number, string> = {
  0x27: '’', 0x60: '‘', 0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa4: '⁄', 0xa5: '¥', 0xa6: 'ƒ', 0xa7: '§', 0xa8: '¤',
  0xa9: "'", 0xaa: '“', 0xab: '«', 0xac: '‹', 0xad: '›', 0xae: 'fi', 0xaf: 'fl', 0xb1: '–', 0xb2: '†', 0xb3: '‡',
  0xb4: '·', 0xb6: '¶', 0xb7: '•', 0xb8: '‚', 0xb9: '„', 0xba: '”', 0xbb: '»', 0xbc: '…', 0xbd: '‰', 0xbf: '¿',
  0xc1: '`', 0xc2: '´', 0xc3: 'ˆ', 0xc4: '˜', 0xc5: '¯', 0xc6: '˘', 0xc7: '˙', 0xc8: '¨', 0xca: '˚', 0xcb: '¸',
  0xcd: '˝', 0xce: '˛', 0xcf: 'ˇ', 0xd0: '—', 0xe1: 'Æ', 0xe3: 'ª', 0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xeb: 'º',
  0xf1: 'æ', 0xf5: 'ı', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß',
};

function decodeTable(label: string): (string | undefined)[] {
  const bytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) bytes[i] = i;
  let s: string;
  try {
    s = new TextDecoder(label).decode(bytes);
  } catch {
    s = new TextDecoder('windows-1252').decode(bytes);
  }
  const out: (string | undefined)[] = new Array(256);
  const chars = Array.from(s);
  for (let i = 32; i < 256; i++) out[i] = chars[i];
  out[0x7f] = undefined;
  return out;
}

function baseEncoding(name: string | undefined): (string | undefined)[] {
  if (name === 'MacRomanEncoding') return decodeTable('macintosh');
  if (name === 'StandardEncoding') {
    const out: (string | undefined)[] = new Array(256);
    for (let i = 32; i < 127; i++) out[i] = String.fromCharCode(i);
    for (const k in STD_UPPER) out[+k] = STD_UPPER[k];
    return out;
  }
  return decodeTable('windows-1252');
}

function std14Name(baseFont: string): keyof typeof FontNames | null {
  const n = baseFont.replace(/^[A-Z]{6}\+/, '').toLowerCase().replace(/[\s,_-]/g, '');
  const bold = /bold|black|heavy/.test(n);
  const ital = /italic|oblique/.test(n);
  if (n.includes('courier')) return bold ? (ital ? 'CourierBoldOblique' : 'CourierBold') : ital ? 'CourierOblique' : 'Courier';
  if (n.includes('times')) return bold ? (ital ? 'TimesRomanBoldItalic' : 'TimesRomanBold') : ital ? 'TimesRomanItalic' : 'TimesRoman';
  if (n.includes('helvetica') || n.includes('arial')) return bold ? (ital ? 'HelveticaBoldOblique' : 'HelveticaBold') : ital ? 'HelveticaOblique' : 'Helvetica';
  if (n === 'symbol') return 'Symbol';
  if (n.includes('zapfdingbats')) return 'ZapfDingbats';
  return null;
}

let fontSeq = 0;

export class PdfFont {
  /** Stable identity within the document (object number, or a synthetic id for inline dicts). */
  readonly id: string;
  baseFont = '';
  subtype = '';
  composite = false;
  type3 = false;
  vertical = false;
  /** False when we cannot split strings into codes or measure them (exotic CMaps). */
  supported = true;
  embedded = false;
  codeLen = 1;
  defaultWidth = 0;
  toUnicode: Map<number, string> | null = null;
  encodingName = '';
  /** CID → glyph index for TrueType CID fonts; null means identity. */
  cidToGid: Uint16Array | null = null;
  desc: FontDescriptorInfo = { flags: 0, italicAngle: 0, stemV: 0, fontWeight: 0, ascent: 0, descent: 0, capHeight: 0, fontFamily: '', missingWidth: 0 };
  /** Every character code this document actually draws with the font. */
  readonly used = new Set<number>();
  /** True for non-embedded standard fonts, where the whole encoding is drawable. */
  std14 = false;

  private widths = new Map<number, number>();
  private encUni: (string | undefined)[] | null = null;
  private codeSpaces: CodeSpace[] | null = null;
  private cidMap: Map<number, number> | null = null;
  private cidRanges: { lo: number; hi: number; cid: number }[] = [];
  private glyphScale = 1;
  private programStream: { kind: FontProgram['kind']; stream: PDFStream } | null = null;
  private programCache: FontProgram | null | undefined;

  constructor(ctx: PDFContext, dict: PDFDict, id?: string) {
    this.id = id ?? `inline-${++fontSeq}`;
    try {
      this.init(ctx, dict);
    } catch {
      this.supported = false;
    }
  }

  private init(ctx: PDFContext, dict: PDFDict) {
    this.subtype = getName(ctx, dict, 'Subtype') ?? '';
    this.baseFont = utf8IfValid(getName(ctx, dict, 'BaseFont') ?? getName(ctx, dict, 'Name') ?? '');
    const tu = getStream(ctx, dict, 'ToUnicode');
    if (tu) {
      const cm = parseCMap(streamData(tu));
      if (cm.uni.size) this.toUnicode = cm.uni;
    }
    if (this.subtype === 'Type0') this.initComposite(ctx, dict);
    else this.initSimple(ctx, dict);
  }

  private readDescriptor(ctx: PDFContext, fd: PDFDict | undefined) {
    if (!fd) return;
    const d = this.desc;
    d.flags = getNum(ctx, fd, 'Flags') ?? 0;
    d.italicAngle = getNum(ctx, fd, 'ItalicAngle') ?? 0;
    d.stemV = getNum(ctx, fd, 'StemV') ?? 0;
    d.fontWeight = getNum(ctx, fd, 'FontWeight') ?? 0;
    d.ascent = getNum(ctx, fd, 'Ascent') ?? 0;
    d.descent = getNum(ctx, fd, 'Descent') ?? 0;
    d.capHeight = getNum(ctx, fd, 'CapHeight') ?? 0;
    d.missingWidth = getNum(ctx, fd, 'MissingWidth') ?? 0;
    const fam = getObj(ctx, fd, 'FontFamily');
    if (fam && 'decodeText' in fam) {
      try {
        d.fontFamily = (fam as unknown as { decodeText(): string }).decodeText();
      } catch {
        /* ignore */
      }
    }
    if (!this.baseFont) this.baseFont = getName(ctx, fd, 'FontName') ?? '';
    this.baseFont = utf8IfValid(this.baseFont);
    const ff = getStream(ctx, fd, 'FontFile');
    const ff2 = getStream(ctx, fd, 'FontFile2');
    const ff3 = getStream(ctx, fd, 'FontFile3');
    if (ff2) this.programStream = { kind: 'truetype', stream: ff2 };
    else if (ff3) {
      const st = getName(ctx, ff3.dict, 'Subtype');
      this.programStream = { kind: st === 'OpenType' ? 'opentype' : 'cff', stream: ff3 };
    } else if (ff) this.programStream = { kind: 'type1', stream: ff };
    this.embedded = !!this.programStream;
  }

  private initComposite(ctx: PDFContext, dict: PDFDict) {
    this.composite = true;
    this.codeLen = 2;
    const encObj = getObj(ctx, dict, 'Encoding');
    if (encObj instanceof PDFName) {
      this.encodingName = nameText(encObj) ?? '';
      if (this.encodingName === 'Identity-V') this.vertical = true;
      else if (this.encodingName !== 'Identity-H') this.supported = false;
    } else if (encObj instanceof PDFStream) {
      this.encodingName = 'embedded';
      const cm = parseCMap(streamData(encObj));
      if (cm.useCMap && !/^Identity-/.test(cm.useCMap)) this.supported = false;
      if (cm.codeSpaces.length) this.codeSpaces = cm.codeSpaces;
      if (cm.cid.size || cm.cidRanges.length) {
        this.cidMap = cm.cid;
        this.cidRanges = cm.cidRanges;
      }
      if (cm.wmode === 1 || getNum(ctx, encObj.dict, 'WMode') === 1) this.vertical = true;
      if (this.codeSpaces && this.codeSpaces.every((c) => c.len === 1)) this.codeLen = 1;
    } else this.supported = false;
    if (this.vertical) this.supported = false;

    const descArr = getArray(ctx, dict, 'DescendantFonts');
    const desc = descArr ? deref(ctx, descArr.get(0)) : undefined;
    if (!(desc instanceof PDFDict)) {
      this.supported = false;
      return;
    }
    this.readDescriptor(ctx, getDict(ctx, desc, 'FontDescriptor'));
    this.defaultWidth = getNum(ctx, desc, 'DW') ?? 1000;
    const w = getArray(ctx, desc, 'W');
    if (w) {
      for (let i = 0; i < w.size(); ) {
        const first = deref(ctx, w.get(i));
        const second = deref(ctx, w.get(i + 1));
        if (!(first instanceof PDFNumber)) break;
        const c = first.asNumber();
        if (second instanceof PDFArray) {
          const ws = numbersOf(ctx, second);
          for (let k = 0; k < ws.length; k++) this.widths.set(c + k, ws[k]);
          i += 2;
        } else if (second instanceof PDFNumber) {
          const third = deref(ctx, w.get(i + 2));
          const wv = third instanceof PDFNumber ? third.asNumber() : 0;
          const last = Math.min(second.asNumber(), c + 0xffff);
          for (let k = c; k <= last; k++) this.widths.set(k, wv);
          i += 3;
        } else break;
      }
    }
    const c2g = getObj(ctx, desc, 'CIDToGIDMap');
    if (c2g instanceof PDFStream) {
      const b = streamData(c2g);
      const map = new Uint16Array(b.length >> 1);
      for (let i = 0; i < map.length; i++) map[i] = (b[2 * i] << 8) | b[2 * i + 1];
      this.cidToGid = map;
    }
  }

  private initSimple(ctx: PDFContext, dict: PDFDict) {
    this.type3 = this.subtype === 'Type3';
    const fd = getDict(ctx, dict, 'FontDescriptor');
    this.readDescriptor(ctx, fd);
    if (this.type3) {
      const fm = numbersOf(ctx, getArray(ctx, dict, 'FontMatrix'));
      this.glyphScale = (fm.length >= 1 && fm[0] ? fm[0] : 0.001) * 1000;
    }
    const first = getNum(ctx, dict, 'FirstChar') ?? 0;
    const wArr = getArray(ctx, dict, 'Widths');
    const ws = numbersOf(ctx, wArr);
    for (let i = 0; i < ws.length; i++) this.widths.set(first + i, ws[i] * this.glyphScale);
    this.defaultWidth = this.desc.missingWidth * this.glyphScale;

    // Encoding → Unicode
    const encObj = getObj(ctx, dict, 'Encoding');
    const symbolic = (this.desc.flags & 4) !== 0 && (this.desc.flags & 32) === 0;
    let table: (string | undefined)[];
    let baseName: string | undefined;
    if (encObj instanceof PDFName) baseName = nameText(encObj);
    else if (encObj instanceof PDFDict) baseName = getName(ctx, encObj, 'BaseEncoding');
    this.encodingName = baseName ?? (encObj instanceof PDFDict ? 'custom' : '');
    if (baseName) table = baseEncoding(baseName);
    else if (this.subtype === 'TrueType' || symbolic) table = baseEncoding('WinAnsiEncoding');
    else table = baseEncoding('StandardEncoding');
    if (encObj instanceof PDFDict) {
      const diffs = getArray(ctx, encObj, 'Differences');
      if (diffs) {
        let code = 0;
        for (let i = 0; i < diffs.size(); i++) {
          const o = deref(ctx, diffs.get(i));
          if (o instanceof PDFNumber) code = o.asNumber();
          else if (o instanceof PDFName) {
            const nm = nameText(o) ?? '';
            if (code >= 0 && code < 256) table[code] = glyphNameToUnicode(nm);
            code++;
          }
        }
      }
    }
    this.encUni = table;

    if (!wArr && !this.type3) {
      const std = std14Name(this.baseFont);
      if (std) {
        this.std14 = !this.embedded;
        try {
          const afm = StdFont.load(FontNames[std]);
          const enc = Encodings.WinAnsi;
          for (let code = 32; code < 256; code++) {
            const u = table[code];
            if (!u) continue;
            try {
              const nm = enc.encodeUnicodeCodePoint(u.codePointAt(0)!).name;
              const wv = afm.getWidthOfGlyph(nm);
              if (typeof wv === 'number') this.widths.set(code, wv);
            } catch {
              /* not in WinAnsi */
            }
          }
        } catch {
          this.supported = false;
        }
      } else this.supported = false;
    }
  }

  /** Splits a string operand into character codes. */
  decode(bytes: Uint8Array): number[] {
    const out: number[] = [];
    if (!this.composite || this.codeLen === 1) {
      for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
      return out;
    }
    if (this.codeSpaces && !this.codeSpaces.every((c) => c.len === 2)) {
      let i = 0;
      while (i < bytes.length) {
        let matched = false;
        let v = 0;
        for (let len = 1; len <= 4 && i + len <= bytes.length; len++) {
          v = v * 256 + bytes[i + len - 1];
          if (this.codeSpaces.some((c) => c.len === len && v >= c.lo && v <= c.hi)) {
            out.push(v);
            this.lenOf.set(v, len);
            i += len;
            matched = true;
            break;
          }
        }
        if (!matched) {
          out.push(bytes[i]);
          this.lenOf.set(bytes[i], 1);
          i++;
        }
      }
      return out;
    }
    for (let i = 0; i + 1 < bytes.length; i += 2) out.push((bytes[i] << 8) | bytes[i + 1]);
    if (bytes.length & 1) out.push(bytes[bytes.length - 1]);
    return out;
  }
  private lenOf = new Map<number, number>();

  /** Byte length of a code inside a string operand. */
  codeLength(code: number): number {
    if (!this.composite) return 1;
    return this.lenOf.get(code) ?? this.codeLen;
  }

  codeBytes(code: number): Uint8Array {
    const len = this.codeLength(code);
    const out = new Uint8Array(len);
    for (let i = len - 1, v = code; i >= 0; i--, v = Math.floor(v / 256)) out[i] = v & 0xff;
    return out;
  }

  cid(code: number): number {
    if (!this.composite) return code;
    if (this.cidMap) {
      const direct = this.cidMap.get(code);
      if (direct !== undefined) return direct;
      for (const r of this.cidRanges) if (code >= r.lo && code <= r.hi) return r.cid + code - r.lo;
    }
    return code;
  }

  /** Glyph index in the embedded TrueType program for a code (CID fonts only). */
  gid(code: number): number {
    const cid = this.cid(code);
    if (this.cidToGid) return cid < this.cidToGid.length ? this.cidToGid[cid] : 0;
    return cid;
  }

  /** Advance width of a code in thousandths of text-space units. */
  width(code: number): number {
    const w = this.widths.get(this.composite ? this.cid(code) : code);
    return w !== undefined ? w : this.defaultWidth;
  }

  hasWidth(code: number): boolean {
    return this.widths.has(this.composite ? this.cid(code) : code);
  }

  /** Word spacing (Tw) applies only to the single-byte code 32. */
  isWordSpace(code: number): boolean {
    return code === 32 && this.codeLength(code) === 1;
  }

  /** Best-effort Unicode for a code, from /ToUnicode then the font's encoding. */
  unicode(code: number): string | undefined {
    const u = this.toUnicode?.get(code);
    if (u !== undefined) return u;
    if (this.encUni && code < 256) return this.encUni[code];
    return undefined;
  }

  /** Unicode → code for the codes that are known to be drawable (used, or all of a standard font). */
  reverseUnicode(): Map<string, number> {
    const out = new Map<string, number>();
    const consider = (code: number) => {
      const u = this.unicode(code);
      if (u && !out.has(u)) out.set(u, code);
    };
    for (const code of this.used) consider(code);
    if (this.std14 && this.encUni) for (let code = 32; code < 256; code++) if (this.widths.has(code)) consider(code);
    return out;
  }

  get program(): FontProgram | null {
    if (this.programCache !== undefined) return this.programCache;
    this.programCache = null;
    if (this.programStream) {
      const bytes = streamData(this.programStream.stream);
      if (bytes.length > 0) this.programCache = { kind: this.programStream.kind, bytes };
    }
    return this.programCache;
  }

  /** The BaseFont without its six-letter subset tag. */
  get cleanName(): string {
    return this.baseFont.replace(/^[A-Z]{6}\+/, '');
  }
}
