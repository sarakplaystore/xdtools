import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { EditorDocument, PasswordRequiredError } from '../src/engine/document';
import { ROOT, nodeLibrary } from './helpers';

const fixture = (name: string) => new Uint8Array(readFileSync(join(ROOT, 'tests/fixtures', name)));
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

async function open(name: string, password?: string) {
  const doc = await EditorDocument.open(fixture(name), { library: nodeLibrary(), password });
  await doc.resolveFonts();
  return doc;
}

async function reopen(bytes: Uint8Array) {
  const doc = await EditorDocument.open(bytes, { library: nodeLibrary() });
  await doc.resolveFonts();
  return doc;
}

const BOX = { id: 'b1', x: 60, y: 60, text: 'បន្ថែមថ្មី · Added 2026', fontId: 'b:khmeros/KhmerOS_battambang.ttf', size: 12, color: [0.1, 0.3, 0.8] as [number, number, number] };

describe('PDFs from different producers', () => {
  // [file, whether it embeds Khmer fonts]
  const cases: [string, boolean][] = [
    ['chrome-khmer.pdf', true],
    ['sample-khmer.pdf', true],
    ['fpdf2-khmer.pdf', true],
    ['mupdf-khmer.pdf', true],
    ['reportlab-latin.pdf', false],
  ];
  for (const [file, khmerFonts] of cases) {
    test(`${file}: read, edit a line, add a text box, read back`, async () => {
      const doc = await open(file);
      expect(doc.pageCount).toBeGreaterThan(0);
      expect(doc.fonts.length).toBeGreaterThan(0);
      for (const df of doc.fonts) expect(df.match, df.name.clean).not.toBeNull();
      // Embedded Khmer fonts must be identified by their outlines, not merely by name.
      // (Type 3 fonts — e.g. Chrome's synthetic bold — and non-embedded base fonts cannot be.)
      if (khmerFonts) {
        const embedded = doc.fonts.filter((df) => df.font.embedded && df.script === 'khmer');
        expect(embedded.length).toBeGreaterThan(0);
        for (const df of embedded) expect(df.match!.quality, df.name.clean).toBe('exact');
      }

      const lines = doc.lines(0);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.exact)).toBe(true);

      const target = lines.find((l) => l.text.trim().length > 6) ?? lines[0];
      const khmer = /[\u1780-\u17ff]/.test(target.text);
      const newText = khmer ? target.text.slice(0, Math.floor(target.text.length / 2)) + ' សាកល្បងកែអក្សរខ្មែរ ១២៣' : target.text.replace(/\w+$/, '') + 'EDITED text 123';
      const res = await doc.build({ pages: new Map([[0, { lines: new Map([[target.id, { text: newText }]]), boxes: [BOX] }]]) });
      expect(res.outcomes.get(0)!.get(target.id)!.missing).toEqual([]);

      const again = await reopen(res.bytes);
      const texts = again.lines(0).map((l) => norm(l.text));
      expect(texts.some((t) => t.includes(norm(newText)))).toBe(true);
      expect(texts.some((t) => t.includes(norm(BOX.text)))).toBe(true);
      // Every other line is untouched.
      for (const l of lines) if (l.id !== target.id && l.text.trim()) expect(texts, l.text).toContain(norm(l.text));
    });
  }
});

describe('editing the sample certificate', () => {
  test('Khmer text is recovered in logical order', async () => {
    const doc = await open('sample-khmer.pdf');
    const texts = doc.lines(0).map((l) => norm(l.text));
    expect(texts).toContain('ព្រះរាជាណាចក្រកម្ពុជា');
    expect(texts).toContain('ជាតិ សាសនា ព្រះមហាក្សត្រ');
    expect(texts).toContain('លិខិតបញ្ជាក់ការសិក្សា');
    expect(texts.some((t) => t.includes('សិស្សឈ្មោះ សុខ ដារ៉ា ភេទ ប្រុស'))).toBe(true);
    expect(texts.some((t) => t.includes('012 345 678'))).toBe(true);
  });

  test('new text reuses the document fonts (no substitutes)', async () => {
    const doc = await open('sample-khmer.pdf');
    const line = doc.lines(0).find((l) => l.text.includes('សុខ ដារ៉ា'))!;
    const res = await doc.build({ pages: new Map([[0, { lines: new Map([[line.id, { text: line.text.replace('សុខ ដារ៉ា', 'ចាន់ ស្រីនិច្ច') }]]), boxes: [] }]]) });
    const oc = res.outcomes.get(0)!.get(line.id)!;
    expect(oc.via).not.toContain('substitute');
    expect(oc.fonts).toEqual(['Khmer OS Battambang']);
    expect(oc.missing).toEqual([]);
    const again = await reopen(res.bytes);
    const edited = again.lines(0).find((l) => l.text.includes('ចាន់ ស្រីនិច្ច'))!;
    expect(edited).toBeTruthy();
    expect(edited.exact).toBe(true);
    for (const df of again.fonts) expect(df.match?.quality, df.name.clean).toBe('exact');
  });

  test('builds are repeatable and always start from the original', async () => {
    const doc = await open('sample-khmer.pdf');
    const [a, b] = doc.lines(0).filter((l) => l.text.trim().length > 8);
    const first = await doc.build({ pages: new Map([[0, { lines: new Map([[a.id, { text: 'ទីមួយ' }]]), boxes: [] }]]) });
    const second = await doc.build({ pages: new Map([[0, { lines: new Map([[b.id, { text: 'ទីពីរ' }]]), boxes: [] }]]) });
    const t1 = (await reopen(first.bytes)).lines(0).map((l) => norm(l.text));
    const t2 = (await reopen(second.bytes)).lines(0).map((l) => norm(l.text));
    expect(t1).toContain('ទីមួយ');
    expect(t1).toContain(norm(b.text));
    expect(t2).toContain('ទីពីរ');
    expect(t2).toContain(norm(a.text));
    expect(t2).not.toContain('ទីមួយ');
    // No edits at all: text identical to the original.
    const none = await doc.build({ pages: new Map() });
    const t0 = (await reopen(none.bytes)).lines(0).map((l) => norm(l.text));
    expect(t0).toEqual(doc.lines(0).map((l) => norm(l.text)));
  });

  test('deleting a line removes its text', async () => {
    const doc = await open('sample-khmer.pdf');
    const line = doc.lines(0).find((l) => l.text.includes('Certificate of Enrollment'))!;
    const res = await doc.build({ pages: new Map([[0, { lines: new Map([[line.id, { text: '' }]]), boxes: [] }]]) });
    const again = await reopen(res.bytes);
    expect(again.lines(0).some((l) => l.text.includes('Certificate'))).toBe(false);
    expect(again.lines(0).length).toBe(doc.lines(0).length - 1);
  });

  test('centre and end anchoring move the start of the line', async () => {
    const doc = await open('sample-khmer.pdf');
    const line = doc.lines(0).find((l) => norm(l.text) === 'លិខិតបញ្ជាក់ការសិក្សា')!;
    const text = 'លិខិតបញ្ជាក់ការសិក្សា និងអាកប្បកិរិយា';
    const run = async (align: number) => (await doc.build({ pages: new Map([[0, { lines: new Map([[line.id, { text, align }]]), boxes: [] }]]) })).outcomes.get(0)!.get(line.id)!;
    const start = await run(0);
    const centre = await run(0.5);
    const end = await run(1);
    const delta = start.length - line.length;
    expect(delta).toBeGreaterThan(10);
    expect(start.offset).toBe(0);
    expect(centre.offset).toBeCloseTo(-delta / 2, 3);
    expect(end.offset).toBeCloseTo(-delta, 3);
  });

  test('scale, colour and font overrides restyle the whole line', async () => {
    const doc = await open('sample-khmer.pdf');
    const line = doc.lines(0).find((l) => l.text.includes('នាយកសាលា សូមបញ្ជាក់ថា'))!;
    const half = await doc.build({ pages: new Map([[0, { lines: new Map([[line.id, { text: line.text, scale: 0.5 }]]), boxes: [] }]]) });
    expect(half.outcomes.get(0)!.get(line.id)!.length).toBeCloseTo(line.length / 2, 0);
    const styled = await doc.build({ pages: new Map([[0, { lines: new Map([[line.id, { text: line.text, color: [1, 0, 0], fontId: 'b:khmeros/KhmerOS_muollight.ttf' }]]), boxes: [] }]]) });
    expect(styled.outcomes.get(0)!.get(line.id)!.fonts).toEqual(['Khmer OS Muol Light']);
    const again = await reopen(styled.bytes);
    const found = again.lines(0).find((l) => norm(l.text) === norm(line.text))!;
    expect(found).toBeTruthy();
    expect(found.color).toEqual([1, 0, 0]);
  });

  test('characters no font can draw are reported', async () => {
    const doc = await open('sample-khmer.pdf');
    const line = doc.lines(0).find((l) => l.text.includes('Certificate of Enrollment'))!;
    const res = await doc.build({ pages: new Map([[0, { lines: new Map([[line.id, { text: 'Certificate 証明書' }]]), boxes: [] }]]) });
    expect(res.outcomes.get(0)!.get(line.id)!.missing.join('')).toContain('証');
  });
});

describe('password-protected files', () => {
  test('a user password is required, checked, and removed from the edited copy', async () => {
    await expect(EditorDocument.open(fixture('encrypted-user.pdf'), { library: nodeLibrary() })).rejects.toBeInstanceOf(PasswordRequiredError);
    const wrong = await EditorDocument.open(fixture('encrypted-user.pdf'), { library: nodeLibrary(), password: 'nope' }).catch((e) => e);
    expect(wrong).toBeInstanceOf(PasswordRequiredError);
    expect((wrong as PasswordRequiredError).wrong).toBe(true);

    const doc = await open('encrypted-user.pdf', '1234');
    expect(doc.encrypted).toBe(true);
    const line = doc.lines(0).find((l) => l.text.includes('សុខ ដារ៉ា'))!;
    expect(line).toBeTruthy();
    const res = await doc.build({ pages: new Map([[0, { lines: new Map([[line.id, { text: line.text.replace('ដារ៉ា', 'វិបុល') }]]), boxes: [] }]]) });
    const again = await reopen(res.bytes); // opens without a password
    expect(again.encrypted).toBe(false);
    expect(again.lines(0).some((l) => l.text.includes('សុខ វិបុល'))).toBe(true);
  });

  test('files that only restrict permissions open without asking', async () => {
    const doc = await open('encrypted-owner.pdf');
    expect(doc.encrypted).toBe(true);
    expect(doc.lines(0).some((l) => l.text.includes('ព្រះរាជាណាចក្រកម្ពុជា'))).toBe(true);
  });

  test('AES-256 with a non-ASCII password', async () => {
    const doc = await open('encrypted-aes256.pdf', 'សួស្តី');
    expect(doc.lines(0).some((l) => l.text.includes('ព្រះរាជាណាចក្រកម្ពុជា'))).toBe(true);
  });
});

describe('fonts', () => {
  test('a font is loaded once, even when asked for twice at the same time', async () => {
    const lib = nodeLibrary();
    const entry = lib.byId('b:khmeros/KhmerOS_siemreap.ttf')!;
    const [a, b] = await Promise.all([lib.load(entry), lib.load(entry)]);
    expect(a).toBe(b);
    expect(await lib.load(entry)).toBe(a);
  });

  test('a line edit and a new text box in the same typeface share one embedded subset', async () => {
    const doc = await open('sample-khmer.pdf');
    const line = doc.lines(0).find((l) => l.text.includes('សាលារៀន'))!;
    const df = doc.docFont(line.fonts[0])!;
    const box = { ...BOX, fontId: df.match!.entry.id, text: 'ឈ្មោះថ្មី ញ៉ាំ ឌី ឍ ឡើង' };
    const res = await doc.build({ pages: new Map([[0, { lines: new Map([[line.id, { text: 'វិទ្យាល័យ ឈូកស ឋានៈ ឆ្នើម' }]]), boxes: [box] }]]) });
    expect(res.embedded.length).toBe(1);
    expect(res.outcomes.get(0)!.get(line.id)!.missing).toEqual([]);
    expect(res.outcomes.get(0)!.get(box.id)!.missing).toEqual([]);
  });

  test('a font picked by hand is used, marked as chosen, and survives a re-check', async () => {
    const doc = await open('reportlab-latin.pdf');
    const helv = doc.fonts.find((f) => f.name.clean === 'Helvetica')!;
    expect(helv.match!.quality).toBe('substitute');
    const hanuman = doc.library.builtIn().find((e) => e.family === 'Hanuman')!;
    const m = await doc.assignFont(helv, hanuman);
    expect(m.chosen).toBe(true);
    expect(m.quality).toBe('name');
    await doc.resolveFont(helv, { online: false });
    expect(helv.match!.entry.id).toBe(hanuman.id);
    expect(helv.match!.chosen).toBe(true);

    const line = doc.lines(0).find((l) => l.fonts[0] === helv.font)!;
    const res = await doc.build({ pages: new Map([[0, { lines: new Map([[line.id, { text: 'Chosen font សួស្តី' }]]), boxes: [] }]]) });
    expect(res.embedded.map((e) => e.label)).toEqual(['Hanuman']);
    expect(res.outcomes.get(0)!.get(line.id)!.missing).toEqual([]);
  });

  test('an uploaded font file is registered once and matched by its outlines', async () => {
    const doc = await open('mupdf-khmer.pdf');
    const bytes = new Uint8Array(readFileSync(join(ROOT, 'public/fonts/khmeros/KhmerOS_battambang.ttf')));
    const a = doc.library.addUpload(bytes, 'my-font.ttf');
    const b = doc.library.addUpload(bytes, 'my-font.ttf');
    expect(b).toBe(a);
    expect(doc.library.userFonts().length).toBe(1);
    const df = doc.fonts.find((f) => /battambang/i.test(f.name.clean))!;
    const m = await doc.assignFont(df, a);
    expect(m.quality).toBe('exact');
    expect(m.evidence).toBe('outline');
    expect(() => doc.library.addUpload(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'broken.ttf')).toThrow();
  });
});

describe('spaces a word processor leaves around lines', () => {
  async function wordLike() {
    const pdf = await PDFDocument.create();
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const courier = await pdf.embedFont(StandardFonts.Courier);
    const page = pdf.addPage([400, 200]);
    page.drawText('   Hello world      ', { x: 40, y: 150, size: 12, font: helv });
    page.drawText('      ', { x: 40, y: 120, size: 12, font: courier }); // a font that only draws spaces
    page.drawText('Second line ', { x: 40, y: 90, size: 12, font: helv });
    return { bytes: await pdf.save(), width: (t: string) => helv.widthOfTextAtSize(t, 12) };
  }

  test('lines are trimmed, blank rows are not lines, and space-only fonts are flagged', async () => {
    const { bytes, width } = await wordLike();
    const doc = await EditorDocument.open(bytes, { library: nodeLibrary() });
    await doc.resolveFonts();
    const lines = doc.lines(0);
    expect(lines.map((l) => l.text)).toEqual(['Hello world', 'Second line']);
    expect(Math.abs(lines[0].origin[0] - (40 + width('   ')))).toBeLessThan(0.2);
    expect(Math.abs(lines[0].length - width('Hello world'))).toBeLessThan(0.5);
    expect(doc.fonts.find((f) => f.name.clean === 'Courier')!.spacing).toBe(true);
    expect(doc.fonts.find((f) => f.name.clean === 'Helvetica')!.spacing).toBe(false);
  });

  test('editing a trimmed line keeps its position and the rest of the page', async () => {
    const { bytes, width } = await wordLike();
    const doc = await EditorDocument.open(bytes, { library: nodeLibrary() });
    await doc.resolveFonts();
    const [first] = doc.lines(0);
    const res = await doc.build({ pages: new Map([[0, { lines: new Map([[first.id, { text: 'Hello brave new world' }]]), boxes: [] }]]) });
    const again = await reopen(res.bytes);
    const lines = again.lines(0);
    expect(lines.map((l) => norm(l.text))).toEqual(['Hello brave new world', 'Second line']);
    expect(Math.abs(lines[0].origin[0] - (40 + width('   ')))).toBeLessThan(0.2);
    // The new words are drawn with a metric-compatible stand-in for Helvetica.
    expect(Math.abs(lines[0].length - width('Hello brave new world'))).toBeLessThan(2);
  });
});

describe('table cells', () => {
  async function row(border: 'none' | 'stroke' | 'fill') {
    const pdf = await PDFDocument.create();
    const helv = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([400, 200]);
    const x2 = 40 + helv.widthOfTextAtSize('012 345', 12) + 6; // half an em away: closer than a wide word gap
    page.drawText('012 345', { x: 40, y: 100, size: 12, font: helv });
    page.drawText('Phnom Penh', { x: x2, y: 100, size: 12, font: helv });
    if (border === 'stroke') page.drawLine({ start: { x: x2 - 3, y: 92 }, end: { x: x2 - 3, y: 118 }, thickness: 0.5, color: rgb(0, 0, 0) });
    if (border === 'fill') page.drawRectangle({ x: x2 - 3.25, y: 92, width: 0.5, height: 26, color: rgb(0, 0, 0) });
    // An underline must not split anything.
    page.drawLine({ start: { x: 40, y: 98 }, end: { x: 300, y: 98 }, thickness: 0.5, color: rgb(0, 0, 0) });
    const doc = await EditorDocument.open(await pdf.save(), { library: nodeLibrary() });
    await doc.resolveFonts();
    return doc.lines(0).map((l) => l.text);
  }

  test('a border between two pieces of text keeps them separate, however close', async () => {
    expect(await row('none')).toEqual(['012 345 Phnom Penh']);
    expect(await row('stroke')).toEqual(['012 345', 'Phnom Penh']);
    expect(await row('fill')).toEqual(['012 345', 'Phnom Penh']);
  });
});
