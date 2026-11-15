/** Font-name normalisation: turning a PDF /BaseFont into lookup keys plus style hints. */

export const normKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface ParsedFontName {
  /** BaseFont exactly as stored (may carry a subset tag such as "ABCDEE+"). */
  raw: string;
  /** Without the subset tag. */
  clean: string;
  /** Lookup keys, most specific first ("khmerosmuollight" before "khmerosmuol"). */
  keys: string[];
  weight: number;
  italic: boolean;
}

const STYLE_WORDS: [string, number | null, boolean][] = [
  ['extralight', 200, false], ['ultralight', 200, false], ['extrabold', 800, false], ['ultrabold', 800, false],
  ['semibold', 600, false], ['demibold', 600, false], ['regular', 400, false], ['oblique', null, true],
  ['italic', null, true], ['medium', 500, false], ['normal', 400, false], ['black', 900, false],
  ['heavy', 900, false], ['light', 300, false], ['thin', 100, false], ['bold', 700, false], ['book', 400, false],
  ['psmt', null, false], ['mt', null, false], ['ps', null, false],
];

export function parseFontName(baseFont: string): ParsedFontName {
  const clean = baseFont.replace(/^[A-Z]{6}\+/, '').trim();
  let key = normKey(clean);
  const keys = [key];
  let weight = 400;
  let italic = false;
  for (let guard = 0; guard < 6; guard++) {
    let stripped = false;
    for (const [word, w, it] of STYLE_WORDS) {
      if (key.length > word.length + 2 && key.endsWith(word)) {
        key = key.slice(0, -word.length);
        if (w !== null && weight === 400) weight = w;
        if (it) italic = true;
        if (!keys.includes(key)) keys.push(key);
        stripped = true;
        break;
      }
    }
    if (!stripped) break;
  }
  return { raw: baseFont, clean, keys, weight, italic };
}

/** "NotoSansKhmer" → "Noto Sans Khmer". */
export function splitCamel(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/_/g, ' ').trim();
}

const STYLE_WEIGHTS: Record<string, number> = {
  thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400,
  medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900,
};

/** Reads weight/italic out of a style name such as "SemiBoldItalic". */
export function styleFromName(style: string): { weight: number; italic: boolean } {
  const s = normKey(style);
  const italic = /italic|oblique/.test(s);
  const rest = s.replace(/italic|oblique/g, '');
  return { weight: STYLE_WEIGHTS[rest] ?? 400, italic };
}
