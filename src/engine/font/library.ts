/**
 * The font library: every place the editor can get a full font from.
 *
 *   1. fonts the user uploaded in this session
 *   2. fonts installed on the device (Local Font Access API, when granted)
 *   3. fonts bundled with the site (Khmer OS family + popular Khmer Google fonts)
 *   4. open font archives on GitHub (Khmer OS versions, Khmer Digital, Noto, …)
 *   5. the Google Fonts catalogue (all ~2,000 families)
 *   6. fonts discovered on demand from GitHub and npm when scraping for a match
 *
 * Remote files are fetched from public mirrors of the upstream repositories.
 */
import catalogJson from '../../data/font-catalog.json';
import { clamp } from '../util';
import { LoadedFont, unwrapFontBytes } from './hb';
import { ParsedFontName, normKey, splitCamel, styleFromName } from './names';

export type FontSource = 'upload' | 'device' | 'bundled' | 'github' | 'google' | 'npm';
export type FontCategory = 'body' | 'sans' | 'serif' | 'mono' | 'display' | 'hand';

export interface CatalogEntry {
  id: string;
  family: string;
  style: string;
  weight: number;
  italic: boolean;
  keys: string[];
  scripts: string[];
  cat: FontCategory;
  source: FontSource;
  /** Human-readable origin, shown in the UI. */
  label: string;
  /** Site-relative asset path (bundled fonts). */
  url?: string;
  /** [owner/repo, commitOrBranch, path] for fonts downloaded from GitHub mirrors. */
  gh?: [string, string, string];
  /** [packageName, version, path] for fonts downloaded from npm mirrors. */
  npm?: [string, string, string];
  /** Face index inside a `.ttc` font collection (0 when omitted). */
  faceIndex?: number;
  /** Pinned variable-font axis coordinates discovered by outline matching. */
  vars?: Record<string, number>;
  axes?: Record<string, [number, number]>;
  version?: string;
  /** Byte length of an uploaded file (to recognise the same upload again). */
  size?: number;
  /** In-memory data for uploaded / device fonts. */
  getBytes?: () => Promise<Uint8Array>;
}

export interface RemoteSource {
  url: string;
  headers?: Record<string, string>;
}

export interface FetchRemoteOptions {
  /** Whether to store a successful download in persistent cache (default true). */
  cache?: boolean;
  signal?: AbortSignal;
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface GoogleManifest {
  ref: string;
  families: Record<string, [string, string[]]>;
}

export interface LibraryEnv {
  /** Reads a file shipped with the site, e.g. "fonts/khmeros/KhmerOS.ttf". */
  readAsset(path: string): Promise<Uint8Array>;
  /** Downloads the first reachable source; omit to disable online lookups. */
  fetchRemote?(sources: RemoteSource[], opts?: FetchRemoteOptions): Promise<Uint8Array>;
  /** Queries a public JSON index (GitHub / jsDelivr / npm) during on-demand scraping. */
  fetchJson?(url: string, opts?: FetchJsonOptions): Promise<unknown>;
  /** Persists a matched font file so future opens work offline without re-scraping. */
  cacheRemote?(url: string, bytes: Uint8Array): Promise<void>;
  /** Restores catalogue entries matched during earlier scraping sessions. */
  loadSavedEntries?(): CatalogEntry[];
  /** Remembers a newly matched remote catalogue entry for future opens. */
  saveEntry?(entry: CatalogEntry): void;
  loadGoogleManifest?(): Promise<GoogleManifest>;
}

export interface Candidate {
  entry: CatalogEntry;
  /** Found through a look-alike table rather than by its own name. */
  alias: boolean;
}

/** Fonts that are not freely available (or carry variant spellings) → open fonts to try. */
export const ALIASES: Record<string, string[]> = {
  arial: ['liberationsans', 'arimo'], helvetica: ['liberationsans', 'arimo'], helveticaneue: ['liberationsans', 'arimo'],
  arialnarrow: ['liberationsans'], arialunicodems: ['liberationsans'],
  timesnewroman: ['tinos'], times: ['tinos'], timesroman: ['tinos'], timesnewromanps: ['tinos'],
  couriernew: ['cousine'], courier: ['cousine'],
  calibri: ['carlito'], calibrilight: ['carlito'], cambria: ['caladea'], georgia: ['gelasio'],
  verdana: ['notosans'], tahoma: ['notosans'], segoeui: ['notosans'], trebuchetms: ['notosans'],
  khmerui: ['notosanskhmer'], leelawadeeui: ['notosanskhmer'], khmersangammn: ['notosanskhmer'],
  khmermn: ['notoserifkhmer'], daunpenh: ['khmeros'], moolboran: ['khmerossiemreap'],
  khmerosmoul: ['khmerosmuol'], khmerosmoullight: ['khmerosmuollight'], khmerosmoulpali: ['khmerosmuolpali'],
  khmerosmetalchrieng: ['khmerosmc'], khmerossystem: ['khmerossys'],
  thsarabunnew: ['sarabun'], thsarabunpsk: ['sarabun'], thsarabun: ['sarabun'], thsarabunit: ['sarabun'], angsananew: ['notoserifthai'], cordianew: ['notosansthai'],
  phetsarathot: ['notosanslao'], saysetthaot: ['notosanslao'], pyidaungsu: ['notosansmyanmar'], myanmar3: ['notosansmyanmar'],
  simsun: ['notoserifsc'], microsoftyahei: ['notosanssc'], mingliu: ['notoseriftc'], msgothic: ['notosansjp'], msmincho: ['notoserifjp'],
  malgungothic: ['notosanskr'], mangal: ['notosansdevanagari'], nirmalaui: ['notosansdevanagari'],
};

/** Google's Noto family for a script, used when a font of that script cannot be found by name. */
export const SCRIPT_FALLBACK: [RegExp, string][] = [
  [/[\u0e00-\u0e7f]/, 'notosansthai'], [/[\u0e80-\u0eff]/, 'notosanslao'], [/[\u1000-\u109f]/, 'notosansmyanmar'],
  [/[\u0900-\u097f]/, 'notosansdevanagari'], [/[\u0980-\u09ff]/, 'notosansbengali'], [/[\u0b80-\u0bff]/, 'notosanstamil'],
  [/[\u0600-\u06ff]/, 'notosansarabic'], [/[\u0590-\u05ff]/, 'notosanshebrew'], [/[\u0400-\u04ff\u0370-\u03ff]/, 'notosans'],
  [/[\u3040-\u30ff]/, 'notosansjp'], [/[\uac00-\ud7af]/, 'notosanskr'], [/[\u4e00-\u9fff]/, 'notosanssc'],
  [/[\u0100-\u024f\u1e00-\u1eff]/, 'notosans'],
];

const LIBERATION: CatalogEntry[] = [
  ['Regular', 400, false], ['Bold', 700, false], ['Italic', 400, true], ['BoldItalic', 700, true],
].map(([style, weight, italic]) => ({
  id: `b:pdfjs/LiberationSans-${style}.ttf`, family: 'Liberation Sans', style: String(style), weight: weight as number, italic: italic as boolean,
  keys: ['liberationsans'], scripts: ['latin'], cat: 'sans' as FontCategory, source: 'bundled' as FontSource,
  label: 'Built-in · Liberation', url: `pdfjs/standard_fonts/LiberationSans-${style}.ttf`,
}));

function encodePath(path: string): string {
  return path.replace(/^\/+/, '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

export function githubSources(repo: string, ref: string, path: string, includeApi = true): RemoteSource[] {
  const enc = encodePath(path);
  const encRef = encodeURIComponent(ref);
  const list: RemoteSource[] = [
    { url: `https://cdn.jsdelivr.net/gh/${repo}@${encRef}/${enc}` },
    { url: `https://raw.githubusercontent.com/${repo}/${encRef}/${enc}` },
  ];
  if (includeApi) {
    list.push({ url: `https://api.github.com/repos/${repo}/contents/${enc}?ref=${encRef}`, headers: { Accept: 'application/vnd.github.raw' } });
  }
  return list;
}

export function npmSources(pkg: string, version: string, path: string): RemoteSource[] {
  const encPkg = pkg.split('/').map(encodeURIComponent).join('/');
  const encVer = encodeURIComponent(version);
  const encPath = encodePath(path);
  return [
    { url: `https://cdn.jsdelivr.net/npm/${encPkg}@${encVer}/${encPath}` },
    { url: `https://unpkg.com/${encPkg}@${encVer}/${encPath}` },
  ];
}

export function entrySources(entry: CatalogEntry, includeApi = true): RemoteSource[] | null {
  if (entry.gh) return githubSources(entry.gh[0], entry.gh[1], entry.gh[2], includeApi);
  if (entry.npm) return npmSources(entry.npm[0], entry.npm[1], entry.npm[2]);
  return null;
}

/** How long an unavailable public lookup is skipped before it is tried again. */
const JSON_RETRY_MS = 60_000;

const SOURCE_RANK: Record<FontSource, number> = {
  upload: 0,
  device: 1,
  bundled: 2,
  github: 3,
  google: 4,
  npm: 5,
};

function varsKey(vars: Record<string, number>): string {
  const keys = Object.keys(vars).sort();
  return keys.map((k) => `${k}=${vars[k]}`).join(',');
}

export class FontLibrary {
  private catalog: CatalogEntry[];
  private extra: CatalogEntry[] = [];
  private saved: CatalogEntry[] = [];
  private bytes = new Map<string, Promise<Uint8Array>>();
  private fonts = new Map<string, LoadedFont>();
  private loading = new Map<string, Promise<LoadedFont>>();
  private google: Promise<GoogleManifest | null> | null = null;
  /** Entries created on the fly (Google Fonts / scraped files), so they can be found again by id. */
  private dynamic = new Map<string, CatalogEntry>();
  /**
   * Public JSON lookups made while scraping, shared by every font in the session. Successful
   * answers are kept; empty ones (rate limit, network, not found) are retried after JSON_RETRY_MS.
   */
  private jsonMemo = new Map<string, { at: number; empty: boolean; value: Promise<unknown> }>();

  constructor(private env: LibraryEnv) {
    const raw = (catalogJson as { fonts: Omit<CatalogEntry, 'url'>[] }).fonts as unknown as CatalogEntry[];
    this.catalog = raw.map((e) => (e.source === 'bundled' && e.url ? { ...e, url: `fonts/${e.url}` } : e)).concat(LIBERATION);
    try {
      const prev = env.loadSavedEntries?.() ?? [];
      for (const e of prev) {
        if (e?.id && (e.gh || e.npm) && !this.catalog.some((c) => c.id === e.id)) this.saved.push(e);
      }
    } catch {
      /* ignore corrupt storage */
    }
  }

  get onlineEnabled(): boolean {
    return !!this.env.fetchRemote;
  }

  get searchEnabled(): boolean {
    return !!this.env.fetchJson;
  }

  /** Bundled fonts offered in the "add text" font picker. */
  builtIn(): CatalogEntry[] {
    return this.catalog.filter((e) => e.source === 'bundled');
  }

  userFonts(): CatalogEntry[] {
    return this.extra;
  }

  /** Every locally known catalogue entry (user, built-in, GitHub archive, previously scraped). */
  allEntries(): CatalogEntry[] {
    return [...this.extra, ...this.catalog, ...this.saved];
  }

  byId(id: string): CatalogEntry | undefined {
    return (
      this.extra.find((e) => e.id === id) ??
      this.catalog.find((e) => e.id === id) ??
      this.saved.find((e) => e.id === id) ??
      this.dynamic.get(id)
    );
  }

  /** Registers a font file the user picked (TTF, OTF, TTC). Throws if it is not a usable font. */
  addUpload(bytes: Uint8Array, fileName: string): CatalogEntry {
    const again = this.extra.find((e) => e.source === 'upload' && e.size === bytes.length && e.id.endsWith(`:${fileName}`));
    if (again) return again;
    const font = new LoadedFont(bytes);
    const family = font.family || fileName.replace(/\.[^.]+$/, '');
    const st = styleFromName(font.subfamily || 'Regular');
    const entry: CatalogEntry = {
      id: `u:${this.extra.length}:${fileName}`, family, style: font.subfamily || 'Regular',
      weight: font.metrics.weightClass || st.weight, italic: st.italic,
      keys: [...new Set([family, font.fullName, font.psName, `${family} ${font.subfamily}`, fileName.replace(/\.[^.]+$/, '')].filter(Boolean).map(normKey))],
      scripts: [font.glyphFor(0x1780) ? 'khmer' : '', font.glyphFor(0x41) ? 'latin' : ''].filter(Boolean),
      cat: 'body', source: 'upload', label: `Your file · ${fileName}`, size: bytes.length,
      getBytes: async () => bytes,
    };
    this.extra.unshift(entry);
    this.fonts.set(`${entry.id}|`, font);
    return entry;
  }

  /** Like `addUpload`, also accepting WOFF 1.0 wrappers. */
  async addUploadAsync(bytes: Uint8Array, fileName: string): Promise<CatalogEntry> {
    return this.addUpload(await unwrapFontBytes(bytes), fileName);
  }

  /** Registers fonts reported by the browser's Local Font Access API. */
  addDeviceFonts(list: { family: string; fullName: string; postscriptName: string; style: string; blob(): Promise<Blob> }[]): number {
    let added = 0;
    for (const f of list) {
      const id = `d:${f.postscriptName}`;
      if (this.extra.some((e) => e.id === id)) continue;
      const st = styleFromName(f.style);
      this.extra.push({
        id, family: f.family, style: f.style, weight: st.weight, italic: st.italic,
        keys: [...new Set([f.family, f.fullName, f.postscriptName, `${f.family} ${f.style}`].map(normKey))],
        scripts: [], cat: 'body', source: 'device', label: 'This device',
        getBytes: async () => new Uint8Array(await (await f.blob()).arrayBuffer()),
      });
      added++;
    }
    return added;
  }

  async googleManifest(): Promise<GoogleManifest | null> {
    if (!this.env.loadGoogleManifest) return null;
    if (!this.google) this.google = this.env.loadGoogleManifest().catch(() => null);
    return this.google;
  }

  /** Entries for a Google Fonts family, ordered by style/weight closeness (`limit` omitted = all files). */
  googleEntriesFor(m: GoogleManifest, key: string, weight = 400, italic = false, limit?: number): CatalogEntry[] {
    const fam = m.families[key];
    if (!fam) return [];
    const dir = `${{ o: 'ofl', a: 'apache', u: 'ufl' }[fam[0]] ?? 'ofl'}/${key}`;
    const scored = fam[1].map((file) => {
      const vf = /^(.+?)(-Italic)?\[(.+)\]\.(ttf|otf)$/.exec(file);
      let fw = 400;
      let fi = false;
      let stem = file.replace(/\.(ttf|otf)$/, '');
      let style = 'Regular';
      let variable = false;
      if (vf) {
        variable = vf[3].includes('wght');
        fi = !!vf[2];
        stem = vf[1];
        style = fi ? 'Italic' : 'Regular';
      } else {
        const dash = stem.lastIndexOf('-');
        if (dash > 0) {
          style = stem.slice(dash + 1);
          const st = styleFromName(style);
          fw = st.weight;
          fi = st.italic;
          stem = stem.slice(0, dash);
        } else if (/italic|oblique/i.test(stem)) {
          fi = true;
          style = 'Italic';
        }
      }
      const penalty = (fi === italic ? 0 : 1000) + (variable ? 0 : Math.abs(fw - weight));
      return { file, fw: variable ? weight : fw, fi, stem, style, penalty };
    });
    scored.sort((a, b) => a.penalty - b.penalty);
    const chosen = limit !== undefined ? scored.slice(0, limit) : scored;
    return chosen.map((s) => {
      const entry: CatalogEntry = {
        id: `g:${dir}/${s.file}`, family: splitCamel(s.stem), style: s.style, weight: s.fw, italic: s.fi,
        keys: [key], scripts: [], cat: 'body', source: 'google', label: 'Google Fonts',
        gh: ['google/fonts', m.ref, `${dir}/${s.file}`],
      };
      this.dynamic.set(entry.id, entry);
      return entry;
    });
  }

  private byKey(key: string, weight: number, italic: boolean): CatalogEntry[] {
    const hits = this.allEntries().filter((e) => e.keys.includes(key));
    const rank = (e: CatalogEntry) =>
      SOURCE_RANK[e.source] * 10000 + (e.italic === italic ? 0 : 1000) + (e.axes?.wght ? 0 : Math.abs(e.weight - weight));
    return hits.sort((a, b) => rank(a) - rank(b));
  }

  /** Every font that could be the one a PDF calls `name`, best guess first. */
  async candidates(name: ParsedFontName, opts: { online?: boolean } = {}): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const seen = new Set<string>();
    const add = (entries: CatalogEntry[], alias: boolean) => {
      for (const e of entries) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push({ entry: e, alias });
      }
    };
    const online = opts.online !== false && this.onlineEnabled;
    const m = online ? await this.googleManifest() : null;
    const allowed = (e: CatalogEntry) => online || (!e.gh && !e.npm);
    for (const key of name.keys) {
      add(this.byKey(key, name.weight, name.italic).filter(allowed), false);
      if (m) add(this.googleEntriesFor(m, key, name.weight, name.italic, 2), false);
    }
    for (const key of name.keys) {
      for (const alt of ALIASES[key] ?? []) {
        add(this.byKey(alt, name.weight, name.italic).filter(allowed), true);
        if (m) add(this.googleEntriesFor(m, alt, name.weight, name.italic, 2), true);
      }
    }
    return out;
  }

  /** Google Fonts entries for a family key (online only), e.g. "notosansthai". */
  async googleFamily(key: string, weight = 400, italic = false): Promise<CatalogEntry[]> {
    const m = this.onlineEnabled ? await this.googleManifest() : null;
    return m ? this.googleEntriesFor(m, key, weight, italic, 2) : [];
  }

  /** Last-resort fonts for a script when nothing with the right name exists. */
  fallbacks(script: 'khmer' | 'latin', hint: { cat?: FontCategory; weight?: number; italic?: boolean } = {}): CatalogEntry[] {
    const pick = (id: string) => this.catalog.find((e) => e.id === id);
    const list: (CatalogEntry | undefined)[] = [];
    if (script === 'khmer') {
      if (hint.cat === 'display') list.push(pick('b:khmeros/KhmerOS_muollight.ttf'));
      if (hint.cat === 'hand') list.push(pick('b:khmeros/KhmerOS_fasthand.ttf'));
      if ((hint.weight ?? 400) >= 600) list.push(pick('b:google/Battambang-Bold.ttf'));
      list.push(pick('b:khmeros/KhmerOS_battambang.ttf'), pick('b:google/NotoSansKhmer-VF.ttf'));
    } else {
      const bold = (hint.weight ?? 400) >= 600;
      const style = bold ? (hint.italic ? 'BoldItalic' : 'Bold') : hint.italic ? 'Italic' : 'Regular';
      list.push(pick(`b:pdfjs/LiberationSans-${style}.ttf`), pick('b:pdfjs/LiberationSans-Regular.ttf'), pick('b:khmeros/KhmerOS_battambang.ttf'));
    }
    return list.filter((e): e is CatalogEntry => !!e);
  }

  /** Fetches a candidate font transiently without filling RAM caches or persistent storage on miss. */
  async probeRemote(sources: RemoteSource[], signal?: AbortSignal): Promise<Uint8Array> {
    if (!this.env.fetchRemote) throw new Error('Font source unavailable');
    const raw = await this.env.fetchRemote(sources, { cache: false, signal });
    return unwrapFontBytes(raw);
  }

  /** Reads the raw bytes of an entry without persisting speculative remote downloads. */
  async probeEntry(entry: CatalogEntry, signal?: AbortSignal): Promise<Uint8Array> {
    const cached = this.bytes.get(entry.id);
    if (cached) return cached;
    if (entry.getBytes) return unwrapFontBytes(await entry.getBytes());
    if (entry.url) return this.bytesOf(entry);
    const src = entrySources(entry);
    if (src) return this.probeRemote(src, signal);
    throw new Error('Font source unavailable');
  }

  /**
   * Fetches a public JSON metadata endpoint (returns `null` when unavailable). Identical requests
   * share one answer, so scraping many fonts does not repeat the same GitHub calls: anonymous
   * GitHub API access is limited to 60 requests an hour per visitor.
   */
  async queryJson(url: string, opts?: FetchJsonOptions): Promise<unknown> {
    if (!this.env.fetchJson) return null;
    const hit = this.jsonMemo.get(url);
    if (hit && (!hit.empty || Date.now() - hit.at < JSON_RETRY_MS)) return hit.value;
    const entry: { at: number; empty: boolean; value: Promise<unknown> } = {
      at: Date.now(),
      empty: false,
      value: Promise.resolve(null),
    };
    entry.value = this.env.fetchJson(url, opts).then(
      (v) => {
        entry.empty = v == null;
        return v ?? null;
      },
      (err: unknown) => {
        this.jsonMemo.delete(url);
        throw err;
      },
    );
    this.jsonMemo.set(url, entry);
    return entry.value;
  }

  /**
   * Keeps a font discovered during scraping: registers it in the library, stores its decoded
   * instance for reuse during editing/saving, and caches remote winners for offline re-opens.
   */
  adopt(entry: CatalogEntry, font: LoadedFont, bytes: Uint8Array, persist = false): CatalogEntry {
    this.dynamic.set(entry.id, entry);
    this.bytes.set(entry.id, Promise.resolve(bytes));
    const vKey = Object.keys(font.variations).length ? varsKey(font.variations) : '';
    this.fonts.set(`${entry.id}|${vKey}`, font);
    if (!vKey) this.fonts.set(`${entry.id}|`, font);
    if (persist && (entry.gh || entry.npm)) {
      const src = entrySources(entry, false);
      if (src?.[0] && this.env.cacheRemote) void this.env.cacheRemote(src[0].url, bytes).catch(() => {});
      if (!this.catalog.some((c) => c.id === entry.id) && !this.saved.some((s) => s.id === entry.id)) {
        const clean: CatalogEntry = {
          id: entry.id, family: entry.family, style: entry.style, weight: entry.weight, italic: entry.italic,
          keys: entry.keys, scripts: entry.scripts, cat: entry.cat, source: entry.source, label: entry.label,
          ...(entry.gh ? { gh: entry.gh } : {}),
          ...(entry.npm ? { npm: entry.npm } : {}),
          ...(entry.faceIndex ? { faceIndex: entry.faceIndex } : {}),
          ...(entry.vars && Object.keys(entry.vars).length ? { vars: entry.vars } : {}),
          ...(entry.axes ? { axes: entry.axes } : {}),
          ...(entry.version ? { version: entry.version } : {}),
        };
        this.saved.unshift(clean);
        try {
          this.env.saveEntry?.(clean);
        } catch {
          /* storage full or blocked */
        }
      }
    }
    return entry;
  }

  private bytesOf(entry: CatalogEntry): Promise<Uint8Array> {
    let p = this.bytes.get(entry.id);
    if (!p) {
      const src = entrySources(entry);
      if (entry.getBytes) p = entry.getBytes().then(unwrapFontBytes);
      else if (entry.url) p = this.env.readAsset(entry.url);
      else if (src && this.env.fetchRemote) p = this.env.fetchRemote(src).then(unwrapFontBytes);
      else p = Promise.reject(new Error('Font source unavailable'));
      this.bytes.set(entry.id, p);
      p.catch(() => this.bytes.delete(entry.id));
    }
    return p;
  }

  /** Loads a catalogue font, instancing variable fonts at the requested weight / saved axes. */
  async load(entry: CatalogEntry, weight?: number): Promise<LoadedFont> {
    const baseKey = `${entry.id}|`;
    let base = this.fonts.get(baseKey);
    if (!base) {
      // Share one in-flight load: two callers must end up with the same font object, or the same
      // typeface would be embedded twice.
      let pending = this.loading.get(baseKey);
      if (!pending) {
        pending = this.bytesOf(entry)
          .then((bytes) => {
            const font = new LoadedFont(bytes, {}, entry.faceIndex ?? 0);
            this.fonts.set(baseKey, font);
            return font;
          })
          .finally(() => this.loading.delete(baseKey));
        this.loading.set(baseKey, pending);
      }
      base = await pending;
    }
    const axisKeys = Object.keys(base.axes);
    if (!axisKeys.length) return base;
    const vars: Record<string, number> = {};
    for (const tag of axisKeys) {
      const ax = base.axes[tag];
      const raw = tag === 'wght'
        ? Math.round(weight ?? entry.vars?.wght ?? entry.weight ?? ax.default)
        : (entry.vars?.[tag] ?? ax.default);
      vars[tag] = clamp(raw, ax.min, ax.max);
    }
    const key = `${entry.id}|${varsKey(vars)}`;
    let inst = this.fonts.get(key);
    if (!inst) {
      inst = base.withVariations(vars);
      this.fonts.set(key, inst);
    }
    return inst;
  }
}
