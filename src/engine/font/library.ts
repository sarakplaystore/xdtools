/**
 * The font library: every place the editor can get a full font from.
 *
 *   1. fonts the user uploaded in this session
 *   2. fonts installed on the device (Local Font Access API, when granted)
 *   3. fonts bundled with the site (Khmer OS family + popular Khmer Google fonts)
 *   4. the Khmer OS archive on GitHub (older/newer versions of the family)
 *   5. the Google Fonts catalogue (all ~2,000 families)
 *
 * Remote files are fetched from public mirrors of the upstream repositories.
 */
import catalogJson from '../../data/font-catalog.json';
import { clamp } from '../util';
import { LoadedFont } from './hb';
import { ParsedFontName, normKey, splitCamel, styleFromName } from './names';

export type FontSource = 'upload' | 'device' | 'bundled' | 'github' | 'google';
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
  /** [owner/repo, commit, path] for fonts downloaded on demand. */
  gh?: [string, string, string];
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

export interface GoogleManifest {
  ref: string;
  families: Record<string, [string, string[]]>;
}

export interface LibraryEnv {
  /** Reads a file shipped with the site, e.g. "fonts/khmeros/KhmerOS.ttf". */
  readAsset(path: string): Promise<Uint8Array>;
  /** Downloads the first reachable source; omit to disable online lookups. */
  fetchRemote?(sources: RemoteSource[]): Promise<Uint8Array>;
  loadGoogleManifest?(): Promise<GoogleManifest>;
}

export interface Candidate {
  entry: CatalogEntry;
  /** Found through a look-alike table rather than by its own name. */
  alias: boolean;
}

/** Fonts that are not freely available → open fonts that stand in for them. */
const ALIASES: Record<string, string[]> = {
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
  thsarabunnew: ['sarabun'], thsarabunpsk: ['sarabun'], thsarabun: ['sarabun'], angsananew: ['notoserifthai'], cordianew: ['notosansthai'],
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

export function githubSources(repo: string, ref: string, path: string): RemoteSource[] {
  const enc = path.split('/').map(encodeURIComponent).join('/');
  return [
    { url: `https://cdn.jsdelivr.net/gh/${repo}@${ref}/${enc}` },
    { url: `https://raw.githubusercontent.com/${repo}/${ref}/${enc}` },
    { url: `https://api.github.com/repos/${repo}/contents/${enc}?ref=${ref}`, headers: { Accept: 'application/vnd.github.raw' } },
  ];
}

export class FontLibrary {
  private catalog: CatalogEntry[];
  private extra: CatalogEntry[] = [];
  private bytes = new Map<string, Promise<Uint8Array>>();
  private fonts = new Map<string, LoadedFont>();
  private loading = new Map<string, Promise<LoadedFont>>();
  private google: Promise<GoogleManifest | null> | null = null;
  /** Entries created on the fly (Google Fonts files), so they can be found again by id. */
  private dynamic = new Map<string, CatalogEntry>();

  constructor(private env: LibraryEnv) {
    const raw = (catalogJson as { fonts: Omit<CatalogEntry, 'url'>[] }).fonts as unknown as CatalogEntry[];
    this.catalog = raw.map((e) => (e.source === 'bundled' && e.url ? { ...e, url: `fonts/${e.url}` } : e)).concat(LIBERATION);
  }

  get onlineEnabled(): boolean {
    return !!this.env.fetchRemote;
  }

  /** Bundled fonts offered in the "add text" font picker. */
  builtIn(): CatalogEntry[] {
    return this.catalog.filter((e) => e.source === 'bundled');
  }

  userFonts(): CatalogEntry[] {
    return this.extra;
  }

  byId(id: string): CatalogEntry | undefined {
    return this.extra.find((e) => e.id === id) ?? this.catalog.find((e) => e.id === id) ?? this.dynamic.get(id);
  }

  /** Registers a font file the user picked. Throws if it is not a usable font. */
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

  private async manifest(): Promise<GoogleManifest | null> {
    if (!this.env.loadGoogleManifest) return null;
    if (!this.google) this.google = this.env.loadGoogleManifest().catch(() => null);
    return this.google;
  }

  private googleEntries(m: GoogleManifest, key: string, weight: number, italic: boolean): CatalogEntry[] {
    const fam = m.families[key];
    if (!fam) return [];
    const dir = `${{ o: 'ofl', a: 'apache', u: 'ufl' }[fam[0]] ?? 'ofl'}/${key}`;
    const scored = fam[1].map((file) => {
      const vf = /^(.+?)(-Italic)?\[(.+)\]\.(ttf|otf)$/.exec(file);
      let fw = 400;
      let fi = false;
      let stem = file.replace(/\.(ttf|otf)$/, '');
      let variable = false;
      if (vf) {
        variable = vf[3].includes('wght');
        fi = !!vf[2];
        stem = vf[1];
      } else {
        const dash = stem.lastIndexOf('-');
        if (dash > 0) {
          const st = styleFromName(stem.slice(dash + 1));
          fw = st.weight;
          fi = st.italic;
          stem = stem.slice(0, dash);
        }
      }
      const penalty = (fi === italic ? 0 : 1000) + (variable ? 0 : Math.abs(fw - weight));
      return { file, fw: variable ? weight : fw, fi, stem, penalty };
    });
    scored.sort((a, b) => a.penalty - b.penalty);
    return scored.slice(0, 2).map((s) => {
      const entry: CatalogEntry = {
        id: `g:${dir}/${s.file}`, family: splitCamel(s.stem), style: s.fi ? 'Italic' : 'Regular', weight: s.fw, italic: s.fi,
        keys: [key], scripts: [], cat: 'body', source: 'google', label: 'Google Fonts',
        gh: ['google/fonts', m.ref, `${dir}/${s.file}`],
      };
      this.dynamic.set(entry.id, entry);
      return entry;
    });
  }

  private byKey(key: string, weight: number, italic: boolean): CatalogEntry[] {
    const hits = [...this.extra, ...this.catalog].filter((e) => e.keys.includes(key));
    const rank = (e: CatalogEntry) =>
      ({ upload: 0, device: 1, bundled: 2, github: 3, google: 4 })[e.source] * 10000 + (e.italic === italic ? 0 : 1000) + (e.axes?.wght ? 0 : Math.abs(e.weight - weight));
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
    const m = online ? await this.manifest() : null;
    for (const key of name.keys) {
      add(this.byKey(key, name.weight, name.italic).filter((e) => online || !e.gh), false);
      if (m) add(this.googleEntries(m, key, name.weight, name.italic), false);
    }
    for (const key of name.keys) {
      for (const alt of ALIASES[key] ?? []) {
        add(this.byKey(alt, name.weight, name.italic).filter((e) => online || !e.gh), true);
        if (m) add(this.googleEntries(m, alt, name.weight, name.italic), true);
      }
    }
    return out;
  }

  /** Google Fonts entries for a family key (online only), e.g. "notosansthai". */
  async googleFamily(key: string, weight = 400, italic = false): Promise<CatalogEntry[]> {
    const m = this.onlineEnabled ? await this.manifest() : null;
    return m ? this.googleEntries(m, key, weight, italic) : [];
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

  private bytesOf(entry: CatalogEntry): Promise<Uint8Array> {
    let p = this.bytes.get(entry.id);
    if (!p) {
      if (entry.getBytes) p = entry.getBytes();
      else if (entry.url) p = this.env.readAsset(entry.url);
      else if (entry.gh && this.env.fetchRemote) p = this.env.fetchRemote(githubSources(...entry.gh));
      else p = Promise.reject(new Error('Font source unavailable'));
      this.bytes.set(entry.id, p);
      p.catch(() => this.bytes.delete(entry.id));
    }
    return p;
  }

  /** Loads a catalogue font, instancing variable fonts at the requested weight. */
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
            const font = new LoadedFont(bytes);
            this.fonts.set(baseKey, font);
            return font;
          })
          .finally(() => this.loading.delete(baseKey));
        this.loading.set(baseKey, pending);
      }
      base = await pending;
    }
    const axis = base.axes.wght;
    if (!axis) return base;
    const w = clamp(Math.round(weight ?? entry.weight ?? 400), axis.min, axis.max);
    const key = `${entry.id}|${w}`;
    let inst = this.fonts.get(key);
    if (!inst) {
      const vars: Record<string, number> = {};
      for (const tag in base.axes) vars[tag] = tag === 'wght' ? w : base.axes[tag].default;
      inst = base.withVariations(vars);
      this.fonts.set(key, inst);
    }
    return inst;
  }
}
