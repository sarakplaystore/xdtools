/** Thin, defensive accessors over pdf-lib's low-level object model. */
import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';

export const N = (s: string) => PDFName.of(s);

export function deref(ctx: PDFContext, o: PDFObject | undefined | null): PDFObject | undefined {
  let cur = o ?? undefined;
  for (let i = 0; i < 16 && cur instanceof PDFRef; i++) cur = ctx.lookup(cur);
  return cur;
}

export function getObj(ctx: PDFContext, d: PDFDict, key: string): PDFObject | undefined {
  return deref(ctx, d.get(N(key)));
}

export function getDict(ctx: PDFContext, d: PDFDict, key: string): PDFDict | undefined {
  const o = getObj(ctx, d, key);
  if (o instanceof PDFDict) return o;
  if (o instanceof PDFStream) return o.dict;
  return undefined;
}

export function getArray(ctx: PDFContext, d: PDFDict, key: string): PDFArray | undefined {
  const o = getObj(ctx, d, key);
  return o instanceof PDFArray ? o : undefined;
}

export function getStream(ctx: PDFContext, d: PDFDict, key: string): PDFStream | undefined {
  const o = getObj(ctx, d, key);
  return o instanceof PDFStream ? o : undefined;
}

export function getNum(ctx: PDFContext, d: PDFDict, key: string): number | undefined {
  const o = getObj(ctx, d, key);
  return o instanceof PDFNumber ? o.asNumber() : undefined;
}

export function nameText(o: PDFObject | undefined): string | undefined {
  if (!(o instanceof PDFName)) return undefined;
  try {
    return o.decodeText();
  } catch {
    return o.asString().replace(/^\//, '');
  }
}

export function getName(ctx: PDFContext, d: PDFDict, key: string): string | undefined {
  return nameText(getObj(ctx, d, key));
}

export function numbersOf(ctx: PDFContext, arr: PDFArray | undefined): number[] {
  const out: number[] = [];
  if (!arr) return out;
  for (let i = 0; i < arr.size(); i++) {
    const o = deref(ctx, arr.get(i));
    out.push(o instanceof PDFNumber ? o.asNumber() : 0);
  }
  return out;
}

export function stringBytes(o: PDFObject | undefined): Uint8Array | undefined {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.asBytes();
  return undefined;
}

/** Decoded (unfiltered) bytes of a stream object; empty on unsupported filters. */
export function streamData(s: PDFStream): Uint8Array {
  try {
    if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
    const anyS = s as unknown as { getUnencodedContents?: () => Uint8Array; getContents: () => Uint8Array };
    if (typeof anyS.getUnencodedContents === 'function') return anyS.getUnencodedContents();
    return anyS.getContents();
  } catch {
    return new Uint8Array(0);
  }
}

export function refKey(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFRef ? `${o.objectNumber} ${o.generationNumber}` : undefined;
}
