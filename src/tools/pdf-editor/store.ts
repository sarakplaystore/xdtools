/**
 * Editor session state, kept outside React: opening files, font matching,
 * the edit history, and the build → render pipeline. Components subscribe to
 * immutable snapshots.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { DocFont, EditorDocument, Line, LineOutcome, PasswordRequiredError } from '../../engine/document';
import { getLibrary } from '../../engine/platform.browser';
import { Edits, countEdits, effectiveScale, guessAlign, hasEdits, maxLength, toDocEdits, withPage } from './edits';
import type { PageGeom } from './geometry';
import { ViewerFilesGoneError, closePdf, loadPdf, pageGeom } from './pdfjs';

export type Stage =
  /** `lost` = the page files were replaced by a newer deployment, so the tab must reload. */
  | { kind: 'idle'; error?: boolean; lost?: boolean }
  | { kind: 'loading'; step: 'open' | 'fonts' | 'online' | 'render'; detail?: string }
  | { kind: 'password'; wrong: boolean }
  | { kind: 'ready' };

export interface View {
  pdf: PDFDocumentProxy;
  /** Per page: a signature of the edits baked into `pdf` ('' = original page). */
  stamps: string[];
  outcomes: Map<number, Map<string, LineOutcome>>;
  /** The edits `pdf` was built from. */
  edits: Edits;
}

export interface Snapshot {
  stage: Stage;
  fileName: string;
  doc: EditorDocument | null;
  pageCount: number;
  geoms: (PageGeom | null)[];
  view: View | null;
  edits: Edits;
  changes: number;
  canUndo: boolean;
  canRedo: boolean;
  /** Bumps whenever a font match (or a search state) changes. */
  fontsVersion: number;
  /** A background search for better fonts is still running. */
  searching: boolean;
  busy: boolean;
  buildFailed: boolean;
  /**
   * The open file needs viewer files from a newer deployment; the preview cannot update and a
   * changed edit would not appear. Downloading still works, so say so rather than fail silently.
   */
  viewerGone: boolean;
  saving: boolean;
  /** There are changes that have not been downloaded yet. */
  unsaved: boolean;
}

const INITIAL: Snapshot = {
  stage: { kind: 'idle' }, fileName: '', doc: null, pageCount: 0, geoms: [], view: null, edits: {}, changes: 0,
  canUndo: false, canRedo: false, fontsVersion: 0, searching: false, busy: false, buildFailed: false, viewerGone: false, saving: false, unsaved: false,
};

interface Session {
  doc: EditorDocument;
  name: string;
  /** pdf.js document of the unedited file. */
  basePdf: PDFDocumentProxy;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Fonts for which a wider search could still find the real thing. */
const improvable = (df: DocFont) => !df.spacing && (!df.match || (df.match.quality !== 'exact' && !(df.font.type3 && df.match.quality === 'name')));

type DeviceFont = Parameters<EditorDocument['library']['addDeviceFonts']>[0][number];

export type FontActionError = 'not-a-font' | 'restricted' | 'unsupported' | 'denied' | 'none' | 'failed';

export class EditorStore {
  private snap: Snapshot = INITIAL;
  private listeners = new Set<() => void>();
  private session: Session | null = null;
  private pending: { name: string; bytes: Uint8Array } | null = null;
  private openToken = 0;
  private skipOnline: (() => void) | null = null;

  private past: Edits[] = [];
  private future: Edits[] = [];
  private lastTag = '';
  private lastTagTime = 0;

  private buildTimer = 0;
  private building = false;
  private dirty = false;
  private lastBuildMs = 80;
  private fitRounds = 0;
  /** Serialises everything that calls doc.build(). */
  private chain: Promise<unknown> = Promise.resolve();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snap;

  private patch(p: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...p };
    for (const fn of this.listeners) fn();
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // ---------------------------------------------------------------- files

  async open(input: File | { name: string; bytes: Uint8Array }, password?: string): Promise<void> {
    const token = ++this.openToken;
    this.release();
    this.patch({ ...INITIAL, stage: { kind: 'loading', step: 'open' }, fileName: input.name });
    try {
      const bytes = input instanceof File ? new Uint8Array(await input.arrayBuffer()) : input.bytes;
      this.pending = { name: input.name, bytes };
      await nextFrame(); // let the progress UI paint before the heavy parsing starts
      const doc = await EditorDocument.open(bytes, { library: getLibrary(), password });
      if (token !== this.openToken) return;
      if (!doc.pageCount) throw new Error('No pages');

      this.patch({ stage: { kind: 'loading', step: 'fonts' } });
      await doc.resolveFonts({ online: false });
      if (token !== this.openToken) return;

      // Fonts that are not built in: look for them online, but never keep the user waiting long.
      const weak = doc.fonts.filter(improvable);
      let background: Promise<unknown> | null = null;
      if (weak.length && doc.library.onlineEnabled && navigator.onLine !== false) {
        this.patch({ stage: { kind: 'loading', step: 'online', detail: weak.map((f) => f.name.clean).slice(0, 3).join(', ') } });
        const all = Promise.all(weak.map((df) => doc.resolveFont(df, { online: true }).catch(() => {})));
        const skipped = new Promise<boolean>((r) => (this.skipOnline = () => r(true)));
        const late = await Promise.race([all.then(() => false), sleep(6000).then(() => true), skipped]);
        this.skipOnline = null;
        if (token !== this.openToken) return;
        if (late) background = all;
      }

      this.patch({ stage: { kind: 'loading', step: 'render' } });
      // Protected files are shown from a decrypted copy, so the viewer never needs the password.
      const viewBytes = doc.encrypted ? (await doc.build({ pages: new Map() })).bytes : bytes;
      const pdf = await loadPdf(viewBytes);
      if (token !== this.openToken) {
        closePdf(pdf);
        return;
      }
      const pageCount = Math.min(doc.pageCount, pdf.numPages);
      const geoms: (PageGeom | null)[] = new Array(pageCount).fill(null);
      geoms[0] = await pageGeom(pdf, 0);
      this.session = { doc, name: input.name, basePdf: pdf };
      this.pending = null;
      this.patch({
        stage: { kind: 'ready' }, doc, pageCount, geoms, searching: !!background,
        view: { pdf, stamps: new Array(pageCount).fill(''), outcomes: new Map(), edits: {} },
      });
      void this.loadGeoms(pdf, token);
      if (background) {
        void background.then(() => {
          if (token !== this.openToken) return;
          this.patch({ searching: false });
          this.fontsChanged();
        });
      }
    } catch (err) {
      if (token !== this.openToken) return;
      if (err instanceof PasswordRequiredError) this.patch({ stage: { kind: 'password', wrong: err.wrong } });
      else {
        console.error(err);
        this.pending = null;
        this.patch({ ...INITIAL, stage: { kind: 'idle', error: true, lost: err instanceof ViewerFilesGoneError } });
      }
    }
  }

  /** Retries the file that asked for a password. */
  unlock(password: string): void {
    if (this.pending) void this.open(this.pending, password);
  }

  /** Stops waiting for the online font search; it carries on in the background. */
  skipSearch(): void {
    this.skipOnline?.();
  }

  private async loadGeoms(pdf: PDFDocumentProxy, token: number): Promise<void> {
    const total = this.snap.pageCount;
    let batch: [number, PageGeom][] = [];
    const flush = () => {
      if (!batch.length || token !== this.openToken) return;
      const geoms = this.snap.geoms.slice();
      for (const [i, g] of batch) geoms[i] = g;
      batch = [];
      this.patch({ geoms });
    };
    for (let i = 1; i < total; i++) {
      if (token !== this.openToken) return;
      try {
        batch.push([i, await pageGeom(pdf, i)]);
      } catch {
        /* the page stays at the size of page 1 */
      }
      if (batch.length >= 12) flush();
    }
    flush();
  }

  private release(): void {
    clearTimeout(this.buildTimer);
    this.dirty = false;
    const s = this.session;
    this.session = null;
    this.past = [];
    this.future = [];
    this.lastTag = '';
    if (s) {
      const view = this.snap.view;
      if (view && view.pdf !== s.basePdf) closePdf(view.pdf);
      closePdf(s.basePdf);
    }
  }

  close(): void {
    this.openToken++;
    this.pending = null;
    this.release();
    this.patch({ ...INITIAL });
  }

  // ---------------------------------------------------------------- edits

  /** Editable lines of a page. The array is stable until a font match changes. */
  lines(page: number): Line[] {
    return this.session ? this.session.doc.lines(page) : [];
  }

  /**
   * Applies a change to the edits. Changes that share a `tag` and follow each
   * other closely (typing in one field) collapse into a single undo step.
   */
  update(fn: (edits: Edits) => Edits, opts: { tag?: string; silent?: boolean; now?: boolean } = {}): void {
    if (!this.session) return;
    const prev = this.snap.edits;
    const next = fn(prev);
    if (next === prev) return;
    if (!opts.silent) {
      const t = Date.now();
      const merge = !!opts.tag && opts.tag === this.lastTag && t - this.lastTagTime < 1500;
      if (!merge) {
        this.past.push(prev);
        if (this.past.length > 300) this.past.shift();
      }
      this.future = [];
      this.lastTag = opts.tag ?? '';
      this.lastTagTime = t;
      this.fitRounds = 0;
    }
    this.patch({ edits: next, changes: countEdits(next), canUndo: this.past.length > 0, canRedo: this.future.length > 0, unsaved: true });
    this.schedule(opts.now);
  }

  /** Ends the current run of mergeable changes (the next one starts a new undo step). */
  breakUndoRun(): void {
    this.lastTag = '';
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.snap.edits);
    this.restore(prev);
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.snap.edits);
    this.restore(next);
  }

  private restore(edits: Edits) {
    this.lastTag = '';
    this.fitRounds = 0;
    this.patch({ edits, changes: countEdits(edits), canUndo: this.past.length > 0, canRedo: this.future.length > 0, unsaved: true });
    this.schedule(true);
  }

  // ---------------------------------------------------------------- build → view

  private schedule(now = false): void {
    this.dirty = true;
    clearTimeout(this.buildTimer);
    const delay = now ? 0 : Math.min(700, Math.max(90, this.lastBuildMs * 0.8));
    this.buildTimer = window.setTimeout(() => void this.pump(), delay);
  }

  private async pump(): Promise<void> {
    if (this.building) return; // the running pump picks the new state up
    this.building = true;
    this.patch({ busy: true });
    try {
      while (this.dirty && this.session) {
        this.dirty = false;
        await this.buildOnce(this.session);
      }
    } finally {
      this.building = false;
      this.patch({ busy: false });
    }
  }

  private async buildOnce(session: Session): Promise<void> {
    const edits = this.snap.edits;
    const fontsVersion = this.snap.fontsVersion;
    const started = performance.now();
    try {
      let pdf = session.basePdf;
      let outcomes: View['outcomes'] = new Map();
      if (hasEdits(edits)) {
        const res = await this.exclusive(() => session.doc.build(toDocEdits(edits)));
        if (this.session !== session) return;
        pdf = await loadPdf(res.bytes);
        outcomes = res.outcomes;
        if (this.session !== session) {
          closePdf(pdf);
          return;
        }
      }
      const stamps: string[] = [];
      for (let i = 0; i < this.snap.pageCount; i++) stamps.push(edits[i] ? `${JSON.stringify(edits[i])}#${fontsVersion}` : '');
      const old = this.snap.view;
      this.patch({ view: { pdf, stamps, outcomes, edits }, buildFailed: false });
      // Pages may still be drawing from the previous document; let them finish.
      if (old && old.pdf !== session.basePdf && old.pdf !== pdf) setTimeout(() => closePdf(old.pdf), 5000);
      this.lastBuildMs = performance.now() - started;
      this.autoFit(session, edits, outcomes);
    } catch (err) {
      console.error(err);
      if (this.session !== session) return;
      // A preview that cannot be built is not lost work: the changes are all in this.snap.edits.
      if (err instanceof ViewerFilesGoneError) this.patch({ viewerGone: true });
      else this.patch({ buildFailed: true });
    }
  }

  /** Lines set to "fit": nudge their shrink factor until they just fit the space they have. */
  private autoFit(session: Session, built: Edits, outcomes: View['outcomes']): void {
    if (this.snap.edits !== built || this.fitRounds >= 4) return;
    let next = built;
    for (const key of Object.keys(built)) {
      const page = +key;
      const lines = session.doc.lines(page);
      for (const id of Object.keys(built[page].lines)) {
        const e = built[page].lines[id];
        if (!e.fit) continue;
        const line = lines.find((l) => l.id === id);
        if (!line) continue;
        const current = e.fitScale ?? 1;
        const length = outcomes.get(page)?.get(id)?.length ?? line.length * effectiveScale(e);
        const room = maxLength(line, lines, e.align, this.snap.geoms[page] ?? this.snap.geoms[0]);
        if (length <= 0 || room <= 0) continue;
        let wanted = Math.min(1, (room / length) * current);
        wanted = Math.max(0.3, Math.round(wanted * 1000) / 1000);
        // Ignore changes too small to see; they would only make the line flicker between two states.
        if (Math.abs(wanted - current) < 0.004) continue;
        next = withPage(next, page, (pe) => ({ ...pe, lines: { ...pe.lines, [id]: { ...e, fitScale: wanted } } }));
      }
    }
    if (next !== built) {
      this.fitRounds++;
      this.patch({ edits: next });
      this.schedule(true);
    }
  }

  // ---------------------------------------------------------------- fonts

  private fontsChanged(): void {
    this.patch({ fontsVersion: this.snap.fontsVersion + 1 });
    if (hasEdits(this.snap.edits)) this.schedule(true);
  }

  /** Looks for the real font on the web (Khmer OS archive, Google Fonts). */
  async searchOnline(fonts: DocFont[]): Promise<void> {
    const s = this.session;
    const todo = fonts.filter((df) => df.state !== 'searching');
    if (!s || !todo.length) return;
    const run = Promise.all(todo.map((df) => s.doc.resolveFont(df, { online: true }).catch(() => {})));
    this.fontsChanged();
    await run;
    if (this.session === s) this.fontsChanged();
  }

  /** Compares glyph shapes against every built-in font (finds fonts whose name was changed). */
  async deepSearch(fonts: DocFont[]): Promise<boolean> {
    const s = this.session;
    const todo = fonts.filter((df) => df.state !== 'searching');
    if (!s || !todo.length) return false;
    for (const df of todo) df.state = 'searching';
    this.fontsChanged();
    let found = false;
    try {
      for (const df of todo) found = (await s.doc.deepSearch(df)) || found;
    } catch (err) {
      console.error(err);
    } finally {
      for (const df of todo) df.state = 'done';
      if (this.session === s) this.fontsChanged();
    }
    return found;
  }

  /** Re-checks fonts that are not exact against whatever the library now holds (uploads, device fonts). */
  private async recheck(s: Session, except: DocFont[] = []): Promise<void> {
    await Promise.all(s.doc.fonts.filter((f) => !except.includes(f) && improvable(f)).map((f) => s.doc.resolveFont(f, { online: false }).catch(() => {})));
  }

  /** Adds a font file the user picked and uses it for the given PDF fonts. */
  async uploadFont(fonts: DocFont[], file: File): Promise<FontActionError | null> {
    const s = this.session;
    if (!s) return 'failed';
    let entry;
    try {
      entry = s.doc.library.addUpload(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch {
      return 'not-a-font';
    }
    try {
      await this.recheck(s, fonts);
      for (const df of fonts) await s.doc.assignFont(df, entry);
    } catch (err) {
      return /embedding/i.test(String((err as Error).message)) ? 'restricted' : 'failed';
    } finally {
      if (this.session === s) this.fontsChanged();
    }
    return null;
  }

  async assignFont(fonts: DocFont[], entryId: string): Promise<FontActionError | null> {
    const s = this.session;
    const entry = s?.doc.library.byId(entryId);
    if (!s || !entry) return 'failed';
    for (const df of fonts) df.state = 'searching';
    this.fontsChanged();
    try {
      for (const df of fonts) await s.doc.assignFont(df, entry);
      return null;
    } catch (err) {
      return /embedding/i.test(String((err as Error).message)) ? 'restricted' : 'failed';
    } finally {
      for (const df of fonts) df.state = 'done';
      if (this.session === s) this.fontsChanged();
    }
  }

  /** Asks the browser for the fonts installed on this device (Chromium desktop only). */
  async useDeviceFonts(): Promise<FontActionError | null> {
    const s = this.session;
    if (!s) return 'failed';
    const query = (window as unknown as { queryLocalFonts?: () => Promise<DeviceFont[]> }).queryLocalFonts;
    if (!query) return 'unsupported';
    let list;
    try {
      list = await query.call(window);
    } catch {
      return 'denied';
    }
    if (!list.length) return 'none';
    s.doc.library.addDeviceFonts(list);
    this.patch({ searching: true });
    try {
      await this.recheck(s);
    } finally {
      if (this.session === s) {
        this.patch({ searching: false });
        this.fontsChanged();
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- export

  /** The alignment a fresh edit of this line should start with. */
  defaultAlign(page: number, line: Line): number {
    return guessAlign(line, this.lines(page), this.snap.geoms[page] ?? this.snap.geoms[0] ?? null);
  }

  async exportPdf(): Promise<{ bytes: Uint8Array; name: string } | null> {
    const s = this.session;
    if (!s || this.snap.saving) return null;
    this.patch({ saving: true });
    try {
      const edits = this.snap.edits;
      const res = await this.exclusive(() => s.doc.build(toDocEdits(edits), { compress: true }));
      const stem = s.name.replace(/\.pdf$/i, '') || 'document';
      if (this.snap.edits === edits) this.patch({ unsaved: false });
      return { bytes: res.bytes, name: `${stem}-edited.pdf` };
    } catch (err) {
      console.error(err);
      return null;
    } finally {
      this.patch({ saving: false });
    }
  }
}
