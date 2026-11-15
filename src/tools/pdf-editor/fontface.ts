/** Makes engine fonts usable in CSS, so text fields show the same typeface the PDF will get. */
import type { CSSProperties } from 'react';
import type { LoadedFont } from '../../engine/font/hb';

const families = new WeakMap<Uint8Array, string>();
let counter = 0;

export function fontStyle(font: LoadedFont | null | undefined): CSSProperties {
  if (!font || typeof FontFace === 'undefined') return {};
  let family = families.get(font.bytes);
  if (!family) {
    family = `xdf${++counter}`;
    families.set(font.bytes, family);
    try {
      const face = new FontFace(family, font.bytes as BufferSource);
      face
        .load()
        .then((loaded) => document.fonts.add(loaded))
        .catch(() => {});
    } catch {
      /* the browser refused the font; fall back to the page font */
    }
  }
  const style: CSSProperties = { fontFamily: `"${family}", var(--font)` };
  const vars = Object.entries(font.variations);
  if (vars.length) style.fontVariationSettings = vars.map(([tag, v]) => `"${tag}" ${v}`).join(', ');
  return style;
}
