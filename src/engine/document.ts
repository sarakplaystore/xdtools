/**
 * EditorDocument — the engine's public face.
 *
 *   const doc = await EditorDocument.open(bytes, { library });
 *   await doc.resolveFonts();
 *   const lines = doc.lines(0);
 *   const { bytes: edited } = await doc.build({ pages: new Map([[0, { lines: new Map([[lines[0].id, { text: 'សួស្តី' }]]), boxes: [] }]]) });
 */
import { PDFArray, PDFContext, PDFDict, PDFDocument, PDFObject, PDFPageLeaf, PDFRef, PDFStream } from '@cantoo/pdf-lib';
import { CompileEnv, LineEdit, LineOutcome, Replacement, TextBox, compilePage } from './edit/compile';
import { FontRefs, allocFontRefs, deleteFontObjects, writeFont } from './edit/embed';
import type { NewFontUse } from './edit/layout';
import { LoadedFont } from './font/hb';
import { Candidate, CatalogEntry, FontCategory, FontLibrary, SCRIPT_FALLBACK } from './font/library';
import { FontMatch, MatchQuality, bestVariationFont, embeddedFont, makeMatch } from './font/match';
import { ScrapeCandidate, ScrapePhase, scrapeClues, scrapePlan } from './font/scrape';
import { ParsedFontName, parseFontName } from './font/names';
import { Line, buildLines } from './model';
import { PdfFont } from './pdf/fonts';
import { InterpEnv, RGB, Rule, Scope, ShowOp, interpret } from './pdf/interp';
import { parseContent } from './pdf/lexer';
import { N, deref, getArray, getDict, getName, numbersOf, streamData } from './pdf/objects';
import { IDENTITY, Mat, concatBytes, tick, toLatin1Bytes } from './util';

export class PasswordRequiredError extends Error {
  constructor(readonly wrong: boolean) {
    super(wrong ? 'Wrong password' : 'This PDF is protected with a password');
  }
}

export interface DocFont {
  id: string;
  font: PdfFont;
  name: ParsedFontName;
  script: 'khmer' | 'latin';
  /** Pages (0-based) that draw text with this font. */
  pages: number[];
  match: FontMatch | null;
  state: 'pending' | 'searching' | 'done';
  /** Only ever draws spaces here (Word does this with Calibri): nothing to match, nothing to warn about. */
  spacing: boolean;
}

export interface TextBoxInput {
  id: string;
  x: number;
  y: number;
  dir?: [number, number];
  text: string;
  /** Catalogue entry id of the font to use. */
  fontId: string;
  weight?: number;
  size: number;
  color: RGB;
}

export interface LineEditInput {
  text: string;
  color?: RGB;
  scale?: number;
  fontId?: string;
  weight?: number;
  /** 0 = keep the start fixed (default), 0.5 = centre, 1 = end. */
  align?: number;
}

export interface DocEdits {
  pages: Map<number, { lines: Map<string, LineEditInput>; boxes: TextBoxInput[] }>;
}

export interface BuildResult {
  bytes: Uint8Array;
  outcomes: Map<number, Map<string, LineOutcome>>;
  /** Fonts embedded for the new text. */
  embedded: { name: string; label: string; glyphs: number; bytes: number }[];
}

/** A content stream plus what the document needs to write it back. */
interface DocScope extends Scope {
  /** Forms: the stream's reference and its original object. */
  ref: PDFRef | null;
  original: PDFStream | null;
  page: PageState | null;
  /** The /Resources dictionary in force (its own, or inherited from the stream that draws it). */
  resources: PDFDict | undefined;
  forms: Map<string, { scope: DocScope; matrix: Mat } | null>;
  modified: boolean;
}

interface PageState {
  index: number;
  node: PDFPageLeaf;
  scope: DocScope;
  shows: ShowOp[];
  /** Straight rulings drawn on the page (table borders): they separate pieces of text. */
  rules: Rule[];
  lines: Line[] | null;
  origContents: PDFObject | undefined;
  hadContents: boolean;
  newRef: PDFRef | null;
}

interface NewFontState extends NewFontUse {
  refs: FontRefs | null;
  tag: string;
  label: string;
}

const KHMER = /[\u1780-\u17ff]/;
/** Text that leaves no ink: spaces of every kind and zero-width characters. */
const BLANK_TEXT = /^[\s\u00a0\u200b-\u200d\u2060\ufeff]+$/;
const KHMER_NAME = /khmer|kh[\s-]|battambang|siemreap|mo?ul|bokor|koulen|hanuman|content|kantumruy|nokora|angkor|dangrek|suwannaphum|limon|daunpenh|moolboran|fasthand|freehand|taprom|metal|bayon|chenla|preahvihear|odormeanchey|akbalthom/i;

export interface OpenOptions {
  library: FontLibrary;
  password?: string;
  onProgress?: (stage: string, done: number, total: number) => void;
}

const SCRAPE_CONCURRENCY = 3;

export interface ScrapeProgress {
  phase: ScrapePhase;
  /** Candidates of this phase tested so far / in total. */
  done: number;
  total: number;
  current: string;
  /** Candidates tested for this font overall. */
  probed: number;
  /** Family name of the best match so far ('' when none). */
  best: string;
}

export interface ScrapeOptions {
  signal?: AbortSignal;
  onProgress?(p: ScrapeProgress): void;
  /** Called whenever a better match is found (the document has already been updated). */
  onMatch?(df: DocFont, m: FontMatch): void;
}

export interface ScrapeResult {
  quality: MatchQuality | 'none';
  exact: boolean;
  phase: ScrapePhase | null;
  probed: number;
  aborted: boolean;
}

export class EditorDocument {
  readonly fonts: DocFont[] = [];
  /** The file was encrypted; the edited copy is saved without encryption. */
  encrypted = false;
  private pages: PageState[] = [];
  private fontByKey = new Map<string, PdfFont>();
  private fontByDict = new WeakMap<PDFDict, PdfFont>();
  private docFontOf = new Map<PdfFont, DocFont>();
  private formScopes = new Map<string, DocScope>();
  private newFonts = new Map<LoadedFont, NewFontState>();
  private fallbackFonts: { font: LoadedFont; label: string }[] = [];
  private resNames = new Set<string>();
  private addedRes: [PDFDict, string][] = [];
  private resPrefix = 'XdF';
  private modelVersion = 0;

  private constructor(
    private pdf: PDFDocument,
    readonly library: FontLibrary,
  ) {}

  private get ctx(): PDFContext {
    return this.pdf.context;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** Bumps whenever recovered text may have changed (a font match was updated). */
  get version(): number {
    return this.modelVersion;
  }

  static async open(bytes: Uint8Array, opts: OpenOptions): Promise<EditorDocument> {
    let pdf: PDFDocument;
    let encrypted = false;
    const base = { updateMetadata: false, throwOnInvalidObject: false };
    try {
      pdf = await PDFDocument.load(bytes, opts.password !== undefined ? { ...base, password: opts.password } : base);
      encrypted = opts.password !== undefined;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (!/encrypt|password/i.test(msg)) throw err;
      if (opts.password !== undefined) throw new PasswordRequiredError(true);
      try {
        // Many "protected" PDFs only restrict printing/copying and open with an empty password.
        pdf = await PDFDocument.load(bytes, { ...base, password: '' });
        encrypted = true;
      } catch {
        throw new PasswordRequiredError(false);
      }
    }
    const doc = new EditorDocument(pdf, opts.library);
    doc.encrypted = encrypted;
    await doc.scan(opts.onProgress);
    return doc;
  }

  private fontFor(raw: PDFObject | undefined): PdfFont | null {
    const dict = deref(this.ctx, raw);
    if (!(dict instanceof PDFDict)) return null;
    if (raw instanceof PDFRef) {
      const key = `${raw.objectNumber}`;
      let f = this.fontByKey.get(key);
      if (!f) {
        f = new PdfFont(this.ctx, dict, key);
        this.fontByKey.set(key, f);
      }
      return f;
    }
    let f = this.fontByDict.get(dict);
    if (!f) {
      f = new PdfFont(this.ctx, dict);
      this.fontByDict.set(dict, f);
    }
    return f;
  }

  private fontDictOf(scope: DocScope, create: boolean): PDFDict | undefined {
    let res = scope.resources;
    if (!res) {
      if (!create) return undefined;
      res = this.ctx.obj({}) as PDFDict;
      if (scope.page) scope.page.node.set(N('Resources'), res);
      else scope.original?.dict.set(N('Resources'), res);
      scope.resources = res;
    }
    let fd = deref(this.ctx, res.get(N('Font')));
    if (!(fd instanceof PDFDict)) {
      if (!create) return undefined;
      fd = this.ctx.obj({}) as PDFDict;
      res.set(N('Font'), fd);
    }
    return fd as PDFDict;
  }

  private noteNames(scope: DocScope) {
    const fd = this.fontDictOf(scope, false);
    if (fd) for (const key of fd.keys()) this.resNames.add(key.decodeText());
  }

  private interpEnv: InterpEnv = {
    font: (scope, name) => {
      const fd = this.fontDictOf(scope as DocScope, false);
      return fd ? this.fontFor(fd.get(N(name))) : null;
    },
    form: (scope, name) => {
      const sc = scope as DocScope;
      const cached = sc.forms.get(name);
      if (cached !== undefined) return cached;
      let result: { scope: DocScope; matrix: Mat } | null = null;
      const xobjects = sc.resources ? deref(this.ctx, sc.resources.get(N('XObject'))) : undefined;
      const raw = xobjects instanceof PDFDict ? xobjects.get(N(name)) : undefined;
      const obj = deref(this.ctx, raw);
      if (raw instanceof PDFRef && obj instanceof PDFStream && getName(this.ctx, obj.dict, 'Subtype') === 'Form') {
        const key = `${raw.objectNumber} ${raw.generationNumber}`;
        let fs = this.formScopes.get(key);
        if (!fs) {
          const data = streamData(obj);
          fs = {
            id: `form:${key}`, kind: 'form', data, ops: parseContent(data), uses: 0, ref: raw, original: obj, page: null,
            resources: getDict(this.ctx, obj.dict, 'Resources') ?? sc.resources, forms: new Map(), modified: false,
          };
          this.formScopes.set(key, fs);
          this.noteNames(fs);
        }
        const m = numbersOf(this.ctx, getArray(this.ctx, obj.dict, 'Matrix'));
        result = { scope: fs, matrix: m.length === 6 ? (m as Mat) : IDENTITY };
      }
      sc.forms.set(name, result);
      return result;
    },
  };

  private async scan(onProgress?: OpenOptions['onProgress']): Promise<void> {
    const pages = this.pdf.getPages();
    for (let i = 0; i < pages.length; i++) {
      const node = pages[i].node;
      const contents = deref(this.ctx, node.get(N('Contents')));
      const streams: PDFStream[] = [];
      if (contents instanceof PDFStream) streams.push(contents);
      else if (contents instanceof PDFArray) {
        for (let k = 0; k < contents.size(); k++) {
          const st = deref(this.ctx, contents.get(k));
          if (st instanceof PDFStream) streams.push(st);
        }
      }
      const parts: Uint8Array[] = [];
      for (const st of streams) parts.push(streamData(st), Uint8Array.of(10));
      const data = concatBytes(parts);
      let resources: PDFDict | undefined;
      try {
        resources = node.Resources();
      } catch {
        resources = undefined;
      }
      const scope: DocScope = {
        id: `page:${i}`, kind: 'page', data, ops: parseContent(data), uses: 0, ref: null, original: null, page: null,
        resources, forms: new Map(), modified: false,
      };
      const page: PageState = {
        index: i, node, scope, shows: [], rules: [], lines: null,
        origContents: node.get(N('Contents')), hadContents: node.has(N('Contents')), newRef: null,
      };
      scope.page = page;
      this.noteNames(scope);
      page.shows = interpret(scope, this.interpEnv, undefined, page.rules);
      this.pages.push(page);
      for (const sh of page.shows) {
        let df = this.docFontOf.get(sh.font);
        if (!df) {
          const name = parseFontName(sh.font.baseFont || 'Unnamed font');
          df = { id: sh.font.id, font: sh.font, name, script: KHMER_NAME.test(name.clean) ? 'khmer' : 'latin', pages: [], match: null, state: 'pending', spacing: false };
          this.docFontOf.set(sh.font, df);
          this.fonts.push(df);
        }
        if (df.pages[df.pages.length - 1] !== i) df.pages.push(i);
      }
      if (i % 8 === 7) {
        onProgress?.('Reading pages', i + 1, pages.length);
        await tick();
      }
    }
    for (const df of this.fonts) {
      let codes = 0;
      let blank = 0;
      for (const code of df.font.used) {
        codes++;
        const u = df.font.unicode(code);
        if (u && BLANK_TEXT.test(u)) blank++;
      }
      df.spacing = codes > 0 && blank === codes;
    }
    for (const df of this.fonts) {
      if (df.script === 'khmer') continue;
      for (const code of df.font.used) {
        const u = df.font.unicode(code);
        if (u && KHMER.test(u)) {
          df.script = 'khmer';
          break;
        }
      }
    }
    while ([...this.resNames].some((n) => n.startsWith(this.resPrefix))) this.resPrefix += 'x';
  }

  private rank(m: FontMatch): number {
    return (m.quality === 'exact' ? 20 : m.quality === 'name' ? 10 : 0) + m.score;
  }

  private async tryCandidates(df: DocFont, cands: Candidate[], best: FontMatch | null): Promise<FontMatch | null> {
    for (const c of cands.slice(0, 10)) {
      let font: LoadedFont;
      try {
        font = await this.library.load(c.entry, df.name.weight);
      } catch {
        continue;
      }
      if (font.embeddingRestricted) continue;
      const m = makeMatch(df.font, c.entry, font, c.alias);
      if (!best || this.rank(m) > this.rank(best)) best = m;
      if (m.quality === 'exact' && m.score >= 0.98) break;
    }
    return best;
  }

  private applyMatch(df: DocFont, match: FontMatch | null) {
    df.match = match;
    this.modelVersion++;
    for (const p of df.pages) this.pages[p].lines = null;
  }

  private setMatch(df: DocFont, match: FontMatch | null) {
    this.applyMatch(df, match);
    df.state = 'done';
  }

  /** True when a page has text this editor leaves alone (drawn by a form that is used more than once). */
  hasSharedText(pageIndex: number): boolean {
    return !!this.pages[pageIndex]?.shows.some((sh) => !sh.invisible && sh.scope.uses > 1);
  }

  /** Finds (and verifies) a real font for one PDF font. */
  async resolveFont(df: DocFont, opts: { online?: boolean } = {}): Promise<void> {
    df.state = 'searching';
    // A font the user picked by hand stays, unless the real one turns up.
    const kept = df.match?.chosen ? df.match : null;
    let best: FontMatch | null = null;
    try {
      const local = await this.library.candidates(df.name, { online: false });
      best = await this.tryCandidates(df, local, best);
      const settled = () => !!best && best.quality === 'exact' && best.score >= 0.98;
      if (!settled() && opts.online !== false && this.library.onlineEnabled) {
        const all = await this.library.candidates(df.name, { online: true });
        best = await this.tryCandidates(df, all.filter((c) => !local.some((l) => l.entry.id === c.entry.id)), best);
      }
      if (!best && this.library.onlineEnabled && opts.online !== false) {
        // Nothing by that name: for other scripts, Google's Noto family at least draws the text.
        let sample = '';
        for (const code of df.font.used) sample += df.font.unicode(code) ?? '';
        const hit = SCRIPT_FALLBACK.find(([re]) => re.test(sample));
        if (hit) best = await this.tryCandidates(df, (await this.library.googleFamily(hit[1], df.name.weight, df.name.italic)).map((entry) => ({ entry, alias: true })), best);
      }
      if (!best) {
        const cat: FontCategory | undefined = /mo?ul|bokor|koulen|metal|angkor|dangrek|bayon/i.test(df.name.clean) ? 'display' : /hand/i.test(df.name.clean) ? 'hand' : undefined;
        for (const entry of this.library.fallbacks(df.script, { cat, weight: df.name.weight, italic: df.name.italic })) {
          best = await this.tryCandidates(df, [{ entry, alias: true }], best);
          if (best) break;
        }
      }
    } finally {
      this.setMatch(df, kept && best?.quality !== 'exact' ? kept : best);
    }
  }

  /** Resolves every font the document draws text with. */
  async resolveFonts(opts: { online?: boolean; onProgress?: (done: number, total: number, current: string) => void } = {}): Promise<void> {
    await this.loadFallbacks();
    const todo = this.fonts.filter((f) => f.state !== 'done');
    let done = 0;
    await Promise.all(
      todo.map(async (df) => {
        await this.resolveFont(df, opts);
        opts.onProgress?.(++done, todo.length, df.name.clean);
      }),
    );
  }

  private async loadFallbacks(): Promise<void> {
    if (this.fallbackFonts.length) return;
    const out: { font: LoadedFont; label: string }[] = [];
    for (const script of ['khmer', 'latin'] as const) {
      for (const entry of this.library.fallbacks(script)) {
        try {
          out.push({ font: await this.library.load(entry), label: entry.family });
          break;
        } catch {
          /* try the next one */
        }
      }
    }
    this.fallbackFonts = out;
  }

  /** Uses a specific catalogue font (upload, device, pick) for a PDF font. */
  async assignFont(df: DocFont, entry: CatalogEntry): Promise<FontMatch> {
    const font = await this.library.load(entry, df.name.weight);
    if (font.embeddingRestricted) throw new Error('This font does not permit embedding');
    const m = makeMatch(df.font, entry, font, false);
    if (m.quality !== 'exact') m.quality = 'name';
    m.chosen = true;
    this.setMatch(df, m);
    return m;
  }

  /**
   * Tests one scrape candidate against a PDF font. Remote files are measured transiently: a
   * rejected font is dropped at once, so nothing is kept unless it wins.
   */
  private async testCandidate(df: DocFont, c: ScrapeCandidate, weight: number, signal?: AbortSignal): Promise<{ match: FontMatch; bytes?: Uint8Array } | null> {
    const e = c.entry;
    const remote = !!(e.gh || e.npm);
    let bytes: Uint8Array | undefined;
    let font: LoadedFont;
    if (remote) {
      bytes = await this.library.probeEntry(e, signal);
      font = new LoadedFont(bytes, {}, e.faceIndex ?? 0);
    } else {
      font = await this.library.load(e, weight);
    }
    if (font.embeddingRestricted) return null;
    if (Object.keys(font.axes).length) font = bestVariationFont(df.font, font, { weights: [weight] });
    const entry = Object.keys(font.variations).length ? { ...e, vars: { ...font.variations } } : e;
    return { match: makeMatch(df.font, entry, font, c.alias, c.blind), bytes };
  }

  /**
   * "Scrape until matched": tests candidate fonts phase by phase for one PDF font and stops at the
   * first exact match. Progress is reported as it goes; `opts.signal` stops the work at any point,
   * keeping the best match found so far.
   */
  async scrapeFont(df: DocFont, opts: ScrapeOptions = {}): Promise<ScrapeResult> {
    const clues = scrapeClues(df.font, df.name);
    const weight = clues.name.weight;
    const kept = df.match?.chosen ? df.match : null;
    const isExact = (m: FontMatch | null) => !!m && m.quality === 'exact' && m.score >= 0.98;
    let best: FontMatch | null = df.match;
    let bestBytes: Uint8Array | undefined;
    let phase: ScrapePhase | null = null;
    let probed = 0;
    let done = 0;
    let total = 0;
    let current = '';
    const seen = new Set<string>();
    const report = () => opts.onProgress?.({ phase: phase ?? 'local', done, total, current, probed, best: best?.entry.family ?? '' });

    df.state = 'searching';
    try {
      const plan = scrapePlan(this.library, clues, { signal: opts.signal, best: () => best, done: () => isExact(best) });
      for await (const step of plan) {
        if (opts.signal?.aborted || isExact(best)) break;
        phase = step.phase;
        done = 0;
        total = 0;
        current = '';
        report();
        const items = await step.discover();
        if (opts.signal?.aborted) break;
        total = items.length;
        report();
        let next = 0;
        const worker = async () => {
          while (!opts.signal?.aborted && !isExact(best)) {
            const c = items[next++];
            if (!c) return;
            if (seen.has(c.entry.id)) {
              done++;
              continue;
            }
            seen.add(c.entry.id);
            probed++;
            current = c.entry.family;
            let hit: { match: FontMatch; bytes?: Uint8Array } | null = null;
            try {
              hit = await this.testCandidate(df, c, weight, opts.signal);
            } catch (err) {
              if (opts.signal?.aborted) return;
              hit = null; // unreadable or unreachable: simply not a match
            }
            done++;
            if (hit && (!best || this.rank(hit.match) > this.rank(best)) && (!kept || hit.match.quality === 'exact')) {
              best = hit.match;
              bestBytes = hit.bytes;
              this.applyMatch(df, best);
              opts.onMatch?.(df, best);
            }
            report();
          }
        };
        await Promise.all(Array.from({ length: Math.min(SCRAPE_CONCURRENCY, Math.max(1, items.length)) }, worker));
      }
    } finally {
      if (kept && !isExact(best)) best = kept;
      if (best !== df.match) this.applyMatch(df, best);
      df.state = 'done';
    }
    const aborted = !!opts.signal?.aborted;
    const exact = isExact(best);
    if (exact && bestBytes && best && (best.entry.gh || best.entry.npm)) {
      // Keep the winning remote font for offline re-opens and future scrapes.
      this.library.adopt(best.entry, best.font, bestBytes, true);
    }
    return { quality: best?.quality ?? 'none', exact, phase, probed, aborted };
  }

  /** Compares a PDF font's glyph outlines with every built-in font (finds renamed fonts). */
  async deepSearch(df: DocFont): Promise<boolean> {
    if (!embeddedFont(df.font)) return false;
    let best = df.match;
    for (const entry of this.library.builtIn()) {
      const m = await this.tryCandidates(df, [{ entry, alias: false }], null);
      if (m && m.quality === 'exact' && (!best || this.rank(m) > this.rank(best))) best = m;
      if (best && best.quality === 'exact' && best.score >= 0.98) break;
    }
    if (best && best !== df.match) {
      this.setMatch(df, best);
      return true;
    }
    return false;
  }

  docFont(font: PdfFont): DocFont | undefined {
    return this.docFontOf.get(font);
  }

  private matchOf = (font: PdfFont): FontMatch | null => this.docFontOf.get(font)?.match ?? null;

  /** Editable lines of a page (0-based), in content order. */
  lines(pageIndex: number): Line[] {
    const p = this.pages[pageIndex];
    if (!p) return [];
    if (!p.lines) p.lines = buildLines(p.shows, this.matchOf, p.rules);
    return p.lines;
  }

  private newFont = (font: LoadedFont): NewFontUse => {
    let st = this.newFonts.get(font);
    if (!st) {
      const n = this.newFonts.size;
      const tag = 'XDT' + String.fromCharCode(65 + (Math.floor(n / 676) % 26), 65 + (Math.floor(n / 26) % 26), 65 + (n % 26));
      st = { resName: `${this.resPrefix}${n + 1}`, font, gids: new Set(), uni: new Map(), refs: null, tag, label: font.family };
      this.newFonts.set(font, st);
    }
    return st;
  };

  private restoreScope(scope: DocScope) {
    if (!scope.modified) return;
    const page = scope.page;
    if (page) {
      if (page.hadContents && page.origContents) page.node.set(N('Contents'), page.origContents);
      else page.node.delete(N('Contents'));
      if (page.newRef) this.ctx.delete(page.newRef);
      page.newRef = null;
    } else if (scope.ref && scope.original) this.ctx.assign(scope.ref, scope.original);
    scope.modified = false;
  }

  private writeScope(scope: DocScope, repl: Replacement[], append: string) {
    const ctx = this.ctx;
    const parts: Uint8Array[] = [];
    if (append) parts.push(toLatin1Bytes('q\n'));
    let cursor = 0;
    for (const r of repl) {
      if (r.start < cursor) continue;
      // Whitespace on both sides: the neighbouring tokens may have relied on a delimiter we replaced.
      parts.push(scope.data.subarray(cursor, r.start), toLatin1Bytes(`\n${r.text}\n`));
      cursor = r.end;
    }
    parts.push(scope.data.subarray(cursor));
    if (append) parts.push(toLatin1Bytes('\nQ\n' + append));
    const bytes = concatBytes(parts);
    const page = scope.page;
    if (page) {
      if (!page.newRef) page.newRef = ctx.nextRef();
      ctx.assign(page.newRef, ctx.flateStream(bytes));
      page.node.set(N('Contents'), page.newRef);
    } else if (scope.ref && scope.original) {
      const dict: Record<string, PDFObject> = {};
      for (const [k, v] of scope.original.dict.entries()) {
        const key = k.decodeText();
        if (key !== 'Length' && key !== 'Filter' && key !== 'DecodeParms') dict[key] = v;
      }
      ctx.assign(scope.ref, ctx.flateStream(bytes, dict));
    }
    scope.modified = true;
  }

  /** Applies the given edits (to the document as originally opened) and serialises it. */
  async build(edits: DocEdits, opts: { compress?: boolean } = {}): Promise<BuildResult> {
    await this.loadFallbacks();
    const ctx = this.ctx;
    for (const st of this.newFonts.values()) {
      st.gids = new Set();
      st.uni = new Map();
    }
    // Undo the font-resource entries a previous build added.
    for (const [dict, name] of this.addedRes) dict.delete(N(name));
    this.addedRes = [];

    const env: CompileEnv = { matchOf: this.matchOf, fallbacks: this.fallbackFonts, newFont: this.newFont };
    const outcomes = new Map<number, Map<string, LineOutcome>>();
    const plans = new Map<DocScope, { repl: Replacement[]; append: string }>();
    const fontNeeds = new Map<DocScope, Set<string>>();
    const need = (scope: DocScope, names: Iterable<string>) => {
      let set = fontNeeds.get(scope);
      if (!set) fontNeeds.set(scope, (set = new Set()));
      for (const n of names) set.add(n);
    };

    for (const page of this.pages) {
      const pe = edits.pages.get(page.index);
      if (!pe) continue;
      const lineEdits: { line: Line; edit: LineEdit }[] = [];
      const boxes: TextBox[] = [];
      const lines = this.lines(page.index);
      for (const [id, e] of pe.lines) {
        const line = lines.find((l) => l.id === id);
        if (!line) continue;
        const edit: LineEdit = { text: e.text.replace(/[\r\n]+/g, ' '), align: e.align };
        if (e.color || e.scale || e.fontId) {
          edit.style = { color: e.color, scale: e.scale };
          if (e.fontId) {
            const entry = this.library.byId(e.fontId);
            if (entry) edit.style.font = { font: await this.library.load(entry, e.weight), label: entry.family };
          }
        }
        lineEdits.push({ line, edit });
      }
      for (const b of pe.boxes) {
        const entry = this.library.byId(b.fontId);
        if (!entry || !b.text) continue;
        const font = await this.library.load(entry, b.weight);
        boxes.push({ id: b.id, x: b.x, y: b.y, dir: b.dir ?? [1, 0], text: b.text.replace(/[\r\n]+/g, ' '), font, fontLabel: entry.family, size: b.size, color: b.color });
      }
      if (!lineEdits.length && !boxes.length) continue;
      const plan = compilePage(lineEdits, boxes, env);
      outcomes.set(page.index, plan.outcomes);
      for (const [scope, repl] of plan.replacements) plans.set(scope as DocScope, { repl, append: '' });
      if (plan.append) {
        const cur = plans.get(page.scope);
        if (cur) cur.append = plan.append;
        else plans.set(page.scope, { repl: [], append: plan.append });
        need(page.scope, plan.appendFonts);
      }
      for (const [scope, names] of plan.fontsUsed) need(scope as DocScope, names);
    }

    for (const page of this.pages) if (!plans.has(page.scope)) this.restoreScope(page.scope);
    for (const scope of this.formScopes.values()) if (!plans.has(scope)) this.restoreScope(scope);
    for (const [scope, plan] of plans) this.writeScope(scope, plan.repl, plan.append);

    const embedded: BuildResult['embedded'] = [];
    const byRes = new Map<string, NewFontState>();
    for (const st of this.newFonts.values()) {
      byRes.set(st.resName, st);
      if (!st.gids.size) {
        if (st.refs) {
          deleteFontObjects(ctx, st.refs);
          st.refs = null;
        }
        continue;
      }
      if (!st.refs) st.refs = allocFontRefs(ctx);
      const info = await writeFont(ctx, st, st.refs, st.tag);
      embedded.push({ name: info.name, label: st.label, glyphs: st.gids.size, bytes: info.bytes });
    }
    for (const [scope, names] of fontNeeds) {
      for (const res of names) {
        const st = byRes.get(res);
        if (!st || !st.refs) continue; // an existing resource of the PDF, nothing to add
        const fd = this.fontDictOf(scope, true)!;
        fd.set(N(res), st.refs.type0);
        this.addedRes.push([fd, res]);
      }
    }
    const bytes = await this.pdf.save({ useObjectStreams: !!opts.compress, addDefaultPage: false, updateFieldAppearances: false });
    return { bytes, outcomes, embedded };
  }
}

export type { Line, LineOutcome, CatalogEntry, ScrapePhase };
