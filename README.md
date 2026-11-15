# xdtools

Free tools that run in the browser. The first one is a **PDF editor that handles Khmer properly**:
it changes the text that is already in a PDF, shapes Khmer correctly (subscripts, vowels, signs),
and draws the new text with the same fonts the document already uses.

Nothing is uploaded. Files are read, edited and saved on the visitor's own device.

| Page | Path |
| --- | --- |
| Home | `/` |
| All tools | `/tools` |
| PDF editor | `/tools/pdf-editor` |

The interface is in English and Khmer (switch in the header).

Only the PDF editor is finished. The other seven tiles on the tools page (Photo to PDF, Merge,
Split, Font Finder, Compress, Sign, QR Maker) are placeholders marked "Soon".

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine tests
npm run build      # type-check + production build into dist/
npm run preview    # serve dist/ on http://localhost:4173
```

Needs Node 22.13 or newer. `npm run dev` and `npm run build` first copy the files pdf.js needs at run time
(character maps, standard fonts) from `node_modules` into `public/pdfjs/`, which is not committed.

Deploying: it is a static site. `vercel.json` is set up for Vercel (Vite preset, single-page
rewrites, long cache for fonts); any static host works if unknown paths fall back to `index.html`.

## What the PDF editor does

- **Edit existing text** — tap a line, retype it. Only the drawing instructions of that line are
  rewritten; the rest of the page (other text, pictures, layout) is left as it was.
- **Khmer** — existing Khmer is read back into normal Unicode order from the glyphs in the file
  (many PDFs store it scrambled), and new text is shaped with HarfBuzz, the shaping engine used by
  Chrome and Firefox.
- **Font matching** — each font in the PDF is looked up by name and then confirmed by comparing
  glyph outlines, so a match is a proven match. Sources, in order: a font file you upload, fonts
  installed on the device (Chrome/Edge desktop), the fonts shipped with the site, the Khmer OS
  archive and Google Fonts. When the real font cannot be found the editor says so and uses the
  closest look-alike.
- **Add text**, change **size** and **colour**, pick another font, **delete** a line,
  **undo/redo**.
- **Keep in place** — a line that was centred or right-aligned stays centred or right-aligned when
  its length changes. Text that grew too long can be shrunk to fit.
- **Table cells** — text on either side of a table border is treated separately, so editing one
  cell does not move its neighbours.
- **Password-protected PDFs** — asks for the password; the edited copy is saved without one.

### Limits worth knowing

- Text does not re-wrap. A line that becomes longer than its space runs over unless you use
  "Shrink to fit" or shorten it.
- Scanned pages are pictures: there is no text to edit (you can still add text on top).
- Text inside a drawing that the PDF reuses in several places, hidden OCR text and vertical
  writing are left alone.
- Classic PDF fonts that the file only names (Helvetica, Times, Courier) are drawn with
  metric-compatible stand-ins, exactly as PDF viewers do.
- Looking fonts up online needs a connection; offline, only the shipped fonts are used.

## Fonts shipped with the site

- **Khmer OS 5.0** (12 fonts) — LGPL 2.1 or later, © Danh Hong and Open Forum of Cambodia.
- **Battambang, Hanuman, Kantumruy Pro, Koulen, Moul, Noto Sans Khmer, Siemreap** — SIL Open Font
  License 1.1.
- **Liberation Sans** comes with pdf.js (SIL OFL 1.1).

Details and licence texts: [`public/fonts/NOTICE.txt`](public/fonts/NOTICE.txt).

`src/data/font-catalog.json` (shipped fonts plus the Khmer OS archive on GitHub) is produced by
`scripts/build-font-catalog.mjs`; `src/data/google-fonts.json` lists the Google Fonts families
that can be fetched on demand.

## How the code is laid out

```
src/engine/            the PDF editing engine — no UI, runs in Node and the browser
  pdf/                 content-stream lexer and interpreter, font and CMap reading
  font/                HarfBuzz wrapper, font library, matching, glyphs → Unicode recovery
  edit/                layout of new text, content-stream rewriting, font embedding
  model.ts             lines and clusters of a page
  document.ts          EditorDocument: open → fonts → lines → build
src/tools/pdf-editor/  the editor UI (state store, page view, edit card, fonts drawer)
src/app/, src/pages/   site shell, router, translations, home and tools pages
tests/                 engine tests against PDFs from Chrome, MuPDF, fpdf2, ReportLab, pdf-lib
```

Built with React, Vite, TypeScript, [`@cantoo/pdf-lib`](https://github.com/cantoo-scribe/pdf-lib)
(reading, saving, decryption), [`harfbuzzjs`](https://github.com/harfbuzz/harfbuzzjs) (shaping,
subsetting) and [`pdfjs-dist`](https://github.com/mozilla/pdf.js) (showing pages on screen).
