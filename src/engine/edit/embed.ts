/** Writes a subset of a full font into the PDF as a Type 0 (Identity-H) font. */
import { PDFContext, PDFRef, PDFString } from '@cantoo/pdf-lib';
import { subsetFont } from '../font/hb';
import { fmt, hex4, toLatin1Bytes, utf16beHex } from '../util';
import type { NewFontUse } from './layout';

export interface FontRefs {
  type0: PDFRef;
  cid: PDFRef;
  descriptor: PDFRef;
  file: PDFRef;
  toUnicode: PDFRef;
}

export function allocFontRefs(ctx: PDFContext): FontRefs {
  return { type0: ctx.nextRef(), cid: ctx.nextRef(), descriptor: ctx.nextRef(), file: ctx.nextRef(), toUnicode: ctx.nextRef() };
}

export function deleteFontObjects(ctx: PDFContext, refs: FontRefs): void {
  for (const r of Object.values(refs)) ctx.delete(r);
}

const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' };

function toUnicodeCMap(uni: Map<number, string>): string {
  const entries = [...uni].filter(([, t]) => t.length > 0).sort((a, b) => a[0] - b[0]);
  let body = '';
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    body += `${chunk.length} beginbfchar\n${chunk.map(([g, t]) => `<${hex4(g)}> <${utf16beHex(t)}>`).join('\n')}\nendbfchar\n`;
  }
  return (
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    body +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n'
  );
}

export async function writeFont(ctx: PDFContext, use: NewFontUse, refs: FontRefs, tag: string): Promise<{ name: string; bytes: number }> {
  const font = use.font;
  const gids = [...use.gids].sort((a, b) => a - b);
  const subset = await subsetFont(font.bytes, gids, font.variations, font.index);
  const m = font.metrics;
  const k = 1000 / m.upem;

  let ps = (font.psName || font.family || 'Font').replace(/[^A-Za-z0-9-]/g, '');
  const wght = font.variations.wght;
  if (wght !== undefined) {
    const style = WEIGHT_NAMES[Math.round(wght / 100) * 100] ?? 'Regular';
    ps = `${ps.replace(/-(Regular|Bold|Italic|Light|Medium|Thin|Black|SemiBold|ExtraBold|ExtraLight)$/i, '')}-${style}`;
  }
  const name = `${tag}+${ps || 'Font'}`;

  // /W: runs of consecutive glyph ids share one array.
  const w: (number | number[])[] = [];
  for (let i = 0; i < gids.length; ) {
    let j = i;
    const run: number[] = [];
    while (j < gids.length && gids[j] === gids[i] + (j - i)) run.push(Number(fmt(font.advance1000(gids[j++]), 3)));
    w.push(gids[i], run);
    i = j;
  }

  const cff = font.isCff;
  ctx.assign(refs.file, ctx.flateStream(subset, cff ? { Subtype: 'OpenType' } : { Length1: subset.length }));
  ctx.assign(
    refs.descriptor,
    ctx.obj({
      Type: 'FontDescriptor', FontName: name, Flags: 4 | (m.fixedPitch ? 1 : 0) | (m.italicAngle ? 64 : 0),
      FontBBox: m.bbox.map((v) => Math.round(v * k)), ItalicAngle: m.italicAngle, Ascent: Math.round(m.ascent * k),
      Descent: Math.round(m.descent * k), CapHeight: Math.round(m.capHeight * k), StemV: m.weightClass >= 600 ? 120 : 80,
      [cff ? 'FontFile3' : 'FontFile2']: refs.file,
    }),
  );
  ctx.assign(
    refs.cid,
    ctx.obj({
      Type: 'Font', Subtype: cff ? 'CIDFontType0' : 'CIDFontType2', BaseFont: name,
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: refs.descriptor, DW: 1000, W: w, ...(cff ? {} : { CIDToGIDMap: 'Identity' }),
    }),
  );
  ctx.assign(refs.toUnicode, ctx.flateStream(toLatin1Bytes(toUnicodeCMap(use.uni))));
  ctx.assign(
    refs.type0,
    ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: name, Encoding: 'Identity-H', DescendantFonts: [refs.cid], ToUnicode: refs.toUnicode }),
  );
  return { name, bytes: subset.length };
}
