/**
 * "Scrape until matched": finding the real font for one PDF font by testing candidates one at a
 * time, from the cheapest source to the widest, and stopping at the first exact match.
 *
 *   1. local      – fonts in the file/device/upload, the bundled set, and name-matched entries
 *   2. catalog    – the full GitHub archive for the script + every Google file of matching families
 *   3. web        – live GitHub repository search and npm package search (via jsDelivr listings)
 *   4. script     – Google families for the scripts the document uses (blind outline/metric check)
 *   5. sweep      – a wider Google Fonts pass, only when partial outline evidence is comparable
 *
 * Remote candidates are probed without being kept: a rejected font is dropped as soon as it has
 * been measured, so long scrapes do not fill memory or browser storage.
 */
import type { PdfFont } from '../pdf/fonts';
import type { FontMatch } from './match';
import { embeddedFont } from './match';
import { ParsedFontName, normKey, parseFontName, splitCamel, styleFromName } from './names';
import type { CatalogEntry, FontLibrary, GoogleManifest } from './library';

export type ScrapePhase = 'local' | 'catalog' | 'web' | 'script' | 'sweep';
export const SCRAPE_PHASES: ScrapePhase[] = ['local', 'catalog', 'web', 'script', 'sweep'];

export type ScriptTag = 'khmr' | 'thai' | 'laoo' | 'mymr' | 'latn';

export interface ScrapeCandidate {
  entry: CatalogEntry;
  /** Found through a look-alike name rather than the font's own name. */
  alias: boolean;
  /** Found by sweeping (not by name): needs the stricter blind-match thresholds. */
  blind: boolean;
}

/** Google Fonts families per script (from the `subsets`/script metadata of google/fonts). */
export const SCRIPT_FAMILIES: Record<Exclude<ScriptTag, 'latn'>, string[]> = {
  khmr: [
    'angkor', 'battambang', 'bayon', 'bokor', 'chenla', 'content', 'dangrek', 'fasthand', 'freehand', 'hanuman',
    'kantumruypro', 'kdamthmorpro', 'khmer', 'kohsantepheap', 'konkhmersleokchher', 'koulen', 'metal', 'moul',
    'moulpali', 'nokora', 'notosanskhmer', 'notosanskhmerui', 'notoserifkhmer', 'odormeanchey', 'preahvihear',
    'siemreap', 'suwannaphum', 'taprom',
  ],
  thai: [
    'anuphan', 'athiti', 'baijamjuree', 'chakrapetch', 'charm', 'charmonman', 'chonburi', 'fahkwang', 'googlesans',
    'ibmplexsansthai', 'ibmplexsansthailooped', 'itim', 'k2d', 'kanit', 'kodchasan', 'koho', 'krub', 'maitree',
    'mali', 'mitr', 'niramit', 'notosansthai', 'notosansthailooped', 'notosansthaiui', 'notoserifthai', 'pattaya',
    'playpensansthai', 'pridi', 'prompt', 'pushster', 'sarabun', 'sriracha', 'srisakdi', 'taviraj', 'thasadith', 'trirong',
  ],
  laoo: ['notosanslao', 'notosanslaolooped', 'notosanslaoui', 'notoseriflao', 'phetsarath'],
  mymr: ['notosansmyanmar', 'notosansmyanmarui', 'notoserifmyanmar', 'padauk'],
};

/** Widely used Latin families, tested blind when the document has no other script to go on. */
const LATIN_POPULAR = [
  'arimo', 'tinos', 'cousine', 'carlito', 'caladea', 'opensans', 'roboto', 'lato', 'notosans', 'inter',
  'sourcesanspro', 'ptsans', 'merriweather', 'ptserif', 'robotoslab', 'montserrat', 'poppins', 'raleway',
  'sourceserifpro', 'lora', 'nunito', 'worksans', 'firasans', 'ibmplexsans',
];

const SCRIPT_RANGES: [RegExp, ScriptTag][] = [
  [/[\u1780-\u17ff\u19e0-\u19ff]/, 'khmr'],
  [/[\u0e00-\u0e7f]/, 'thai'],
  [/[\u0e80-\u0eff]/, 'laoo'],
  [/[\u1000-\u109f]/, 'mymr'],
];

const GSUB_SCRIPT: Record<string, ScriptTag> = { khmr: 'khmr', thai: 'thai', lao: 'laoo', mym2: 'mymr', mymr: 'mymr' };

/** Name tokens that often differ between a PDF's name and the font's real family name. */
const SUFFIX_TOKENS = ['mt', 'ps', 'std', 'pro', 'ui', 'new', 'regular', 'roman', 'book', 'text', 'display', 'os', 'unicode', 'vf', 'variable', 'web', 'font'];

/** Word cut-off used for relevance tests on file names (short keys match too often). */
const MIN_KEY = 5;

export interface ScrapeClues {
  /** The PDF's name plus everything learned from the embedded program and descriptor. */
  name: ParsedFontName;
  /** Scripts the document draws (from text and the font's OpenType script tags). */
  scripts: ScriptTag[];
  /** Name from the font program's own name table, when it differs from the PDF's name. */
  embeddedName: string;
}

/** Spelling variants of a key: "arialmt" → "arial", "notosansthaiui" → "notosansthai". */
export function keyVariants(key: string): string[] {
  const out = new Set<string>();
  let cur = key;
  for (let guard = 0; guard < 4; guard++) {
    let next = cur;
    for (const tok of SUFFIX_TOKENS) {
      if (next.length - tok.length >= MIN_KEY - 1 && next.endsWith(tok)) {
        next = next.slice(0, -tok.length);
        break;
      }
    }
    if (next === cur) break;
    out.add(next);
    cur = next;
  }
  // Without the Khmer-Unicode-style "khmer" prefix that many OS-bundled names carry.
  if (key.startsWith('khmer') && key.length - 5 >= MIN_KEY) out.add(key.slice(5));
  out.delete(key);
  return [...out];
}

/** Scripts present in a string of text. */
export function scriptsInText(text: string): Set<ScriptTag> {
  const out = new Set<ScriptTag>();
  for (const [re, tag] of SCRIPT_RANGES) if (re.test(text)) out.add(tag);
  return out;
}

/** Everything the PDF tells us about what font it wants — used to widen the search for renamed fonts. */
export function scrapeClues(pdf: PdfFont, base: ParsedFontName): ScrapeClues {
  const emb = embeddedFont(pdf);
  const d = pdf.desc;
  const extra: string[] = [];
  const names: string[] = [];
  if (d.fontFamily) names.push(d.fontFamily);
  if (emb) {
    for (const n of [emb.family, emb.fullName, emb.psName, emb.subfamily ? `${emb.family} ${emb.subfamily}` : '']) {
      if (n) names.push(n);
    }
  }
  for (const n of names) {
    const parsed = parseFontName(n);
    extra.push(...parsed.keys);
  }
  const keys = [...new Set([...base.keys, ...extra])].filter((k) => k.length >= 3);
  const variantKeys = keys.flatMap(keyVariants);
  const allKeys = [...new Set([...keys, ...variantKeys])];

  let weight = base.weight;
  if (weight === 400 && d.fontWeight > 0) weight = d.fontWeight;
  if (weight === 400 && emb?.metrics.weightClass) weight = emb.metrics.weightClass;
  const italic = base.italic || d.italicAngle !== 0 || (d.flags & 64) !== 0;

  const scripts = new Set<ScriptTag>();
  for (const code of pdf.used) {
    const u = pdf.unicode(code);
    if (u) for (const t of scriptsInText(u)) scripts.add(t);
  }
  if (emb) {
    for (const tag of emb.scriptTags()) {
      const mapped = GSUB_SCRIPT[tag];
      if (mapped) scripts.add(mapped);
    }
  }
  const embeddedName = emb?.family && normKey(emb.family) !== normKey(base.clean) ? emb.family : '';
  return {
    name: { ...base, keys: allKeys, weight, italic },
    scripts: [...scripts],
    embeddedName,
  };
}

/** Lookup keys worth searching for: a lowercase alphanumeric form of each name part. */
function queryWords(name: ParsedFontName): string {
  return name.clean.replace(/[^A-Za-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Google families whose key resembles any of the given keys (exact matches first). */
export function fuzzyFamilies(m: GoogleManifest, keys: string[], max = 8): string[] {
  const probes = keys.filter((k) => k.length >= MIN_KEY);
  const exact: string[] = [];
  const near: string[] = [];
  for (const fam of Object.keys(m.families)) {
    if (probes.includes(fam)) exact.push(fam);
    else if (fam.length >= MIN_KEY && probes.some((k) => k.includes(fam) || fam.includes(k))) near.push(fam);
  }
  near.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return [...exact, ...near].slice(0, max);
}

/** A repository file or npm file that looks like it could be the font we are after. */
export function relevantFile(path: string, keys: string[]): boolean {
  const stem = normKey(path.split('/').pop()!.replace(/\.(ttf|otf)$/i, ''));
  return keys.some((k) => k.length >= MIN_KEY && (stem.includes(k) || k.includes(stem)));
}

function fileEntry(source: 'github' | 'npm', owner: string, ref: string, path: string): CatalogEntry {
  const base = path.split('/').pop()!.replace(/\.(ttf|otf)$/i, '');
  const st = styleFromName(base.split(/[-_]/).pop() ?? '');
  const family = splitCamel(base.replace(/[-_].*$/, '')) || base;
  const common = {
    id: `${source === 'github' ? 'gh' : 'npm'}:${owner}@${ref}:${path}`,
    family,
    style: st.italic ? 'Italic' : 'Regular',
    weight: st.weight,
    italic: st.italic,
    keys: [normKey(base), normKey(family)],
    scripts: [] as string[],
    cat: 'body' as const,
  };
  if (source === 'github') {
    return { ...common, source: 'github', label: `GitHub · ${owner}`, gh: [owner, ref, path] };
  }
  return { ...common, source: 'npm', label: `npm · ${owner}`, npm: [owner.replace(/@[^/]+$/, ''), ref, path] };
}

const isFontPath = (p: string) => /\.(ttf|otf)$/i.test(p);

interface GitHubTree {
  tree?: { path: string; type: string; size?: number }[];
}

/** Font files in a GitHub repository (recursive tree of its default branch), filtered by relevance. */
async function repoFonts(lib: FontLibrary, full: string, branch: string, keep: (p: string) => boolean, max: number, signal?: AbortSignal): Promise<CatalogEntry[]> {
  const enc = branch.split('/').map(encodeURIComponent).join('/');
  const tree = (await lib.queryJson(`https://api.github.com/repos/${full}/git/trees/${enc}?recursive=1`, { signal })) as GitHubTree | null;
  const files = (tree?.tree ?? [])
    .filter((t) => t.type === 'blob' && isFontPath(t.path) && (t.size ?? 0) < 15_000_000 && keep(t.path))
    .slice(0, max);
  return files.map((f) => fileEntry('github', full, branch, f.path));
}

/** Live GitHub search for font repositories matching the name, then their relevant font files. */
export async function githubFonts(lib: FontLibrary, name: ParsedFontName, scripts: ScriptTag[], signal?: AbortSignal): Promise<CatalogEntry[]> {
  const q = `${queryWords(name)} font in:name,description,topics fork:false`;
  const search = (await lib.queryJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=4`, { signal })) as
    | { items?: { full_name: string; default_branch: string }[] }
    | null;
  const keys = name.keys.filter((k) => k.length >= MIN_KEY);
  const out: CatalogEntry[] = [];
  for (const r of (search?.items ?? []).slice(0, 4)) {
    if (signal?.aborted) break;
    out.push(...(await repoFonts(lib, r.full_name, r.default_branch || 'HEAD', (p) => relevantFile(p, keys), 10, signal)));
  }
  // Community archives of the document's script (never bundled: discovered live only).
  const archives: string[] = [];
  if (scripts.includes('khmr')) archives.push('Open-Typography-Foundation/Khmer-Cambodian-Fonts-Archive', 'chamnan-dev/All-khmer-fonts', 'buoysophit/khmer-all-fonts', 'chornthorn/khmer_fonts', 'pphatdev/fonts');
  if (scripts.includes('thai')) archives.push('Phonbopit/sarabun-webfont', 'feverra/TH-Sarabun-New');
  for (const full of archives) {
    if (signal?.aborted) break;
    const info = (await lib.queryJson(`https://api.github.com/repos/${full}`, { signal })) as { default_branch?: string } | null;
    if (!info?.default_branch) continue;
    out.push(...(await repoFonts(lib, full, info.default_branch, () => true, 12, signal)));
  }
  return dedupe(out);
}

/** Live npm search, listing each package's font files through jsDelivr. */
export async function npmFonts(lib: FontLibrary, name: ParsedFontName, signal?: AbortSignal): Promise<CatalogEntry[]> {
  const search = (await lib.queryJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`${queryWords(name)} font`)}&size=4`, { signal })) as
    | { objects?: { package: { name: string; version: string } }[] }
    | null;
  const keys = name.keys.filter((k) => k.length >= MIN_KEY);
  const out: CatalogEntry[] = [];
  for (const o of (search?.objects ?? []).slice(0, 4)) {
    if (signal?.aborted) break;
    const { name: pkg, version } = o.package;
    const list = (await lib.queryJson(`https://data.jsdelivr.com/v1/packages/npm/${pkg.split('/').map(encodeURIComponent).join('/')}@${encodeURIComponent(version)}?structure=flat`, { signal })) as
      | { files?: { name: string; size?: number }[] }
      | null;
    for (const f of (list?.files ?? []).filter((x) => isFontPath(x.name) && (x.size ?? 0) < 15_000_000 && relevantFile(x.name, keys)).slice(0, 8)) {
      out.push(fileEntry('npm', pkg, version, f.name.replace(/^\/+/, '')));
    }
  }
  return dedupe(out);
}

function dedupe(list: CatalogEntry[]): CatalogEntry[] {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

export interface ScrapeStep {
  phase: ScrapePhase;
  discover(): Promise<ScrapeCandidate[]>;
}

export interface ScrapeContext {
  signal?: AbortSignal;
  /** Best match so far (for the sweep decision). */
  best(): FontMatch | null;
  /** True once an exact match has been found. */
  done(): boolean;
}

/** Caps per phase keep a single font's scrape bounded in time and bandwidth. */
export const PHASE_LIMITS: Record<ScrapePhase, number> = { local: 200, catalog: 90, web: 40, script: 60, sweep: 120 };

/** Script tags as the font catalogue writes them (`khmer`, `latin`, …). */
const CATALOG_SCRIPT: Record<ScriptTag, string> = { khmr: 'khmer', thai: 'thai', laoo: 'lao', mymr: 'myanmar', latn: 'latin' };

/** Catalogue entries with no script information are kept; others must share one of the document's scripts. */
const scriptMatches = (e: CatalogEntry, scripts: ScriptTag[]): boolean => {
  if (!scripts.length || !e.scripts.length) return true;
  return scripts.some((s) => e.scripts.includes(CATALOG_SCRIPT[s]));
};

/**
 * The scrape plan for one PDF font, as lazily discovered phases. The caller tests each step's
 * candidates and stops the plan as soon as `ctx.done()` is true.
 */
export async function* scrapePlan(lib: FontLibrary, clues: ScrapeClues, ctx: ScrapeContext): AsyncGenerator<ScrapeStep> {
  const { name, scripts } = clues;
  const weight = name.weight;
  const italic = name.italic;
  const online = lib.onlineEnabled;
  const khmer = scripts.includes('khmr');
  const outlinesComparable = () => {
    const b = ctx.best();
    return !!b && b.score >= 0.5 && b.verified >= 2;
  };

  yield {
    phase: 'local',
    discover: async () => {
      const local = await lib.candidates(name, { online: false });
      const out: ScrapeCandidate[] = local.map((c) => ({ entry: c.entry, alias: c.alias, blind: false }));
      const seen = new Set(out.map((c) => c.entry.id));
      for (const e of [...lib.userFonts(), ...lib.builtIn()]) {
        if (seen.has(e.id) || !scriptMatches(e, scripts)) continue;
        seen.add(e.id);
        out.push({ entry: e, alias: false, blind: true });
      }
      return out.slice(0, PHASE_LIMITS.local);
    },
  };

  if (ctx.done()) return;
  yield {
    phase: 'catalog',
    discover: async () => {
      const out: ScrapeCandidate[] = [];
      if (online) {
        for (const c of await lib.candidates(name, { online: true })) {
          if (c.entry.gh || c.entry.npm) out.push({ entry: c.entry, alias: c.alias, blind: false });
        }
        const manifest = await lib.googleManifest();
        if (manifest) {
          for (const key of name.keys) {
            for (const e of lib.googleEntriesFor(manifest, key, weight, italic)) out.push({ entry: e, alias: false, blind: false });
          }
          for (const fam of fuzzyFamilies(manifest, name.keys, 6)) {
            for (const e of lib.googleEntriesFor(manifest, fam, weight, italic, 2)) out.push({ entry: e, alias: true, blind: true });
          }
        }
      }
      for (const e of lib.allEntries()) {
        if (e.source === 'github' && e.gh && scriptMatches(e, scripts)) out.push({ entry: e, alias: false, blind: true });
      }
      const seen = new Set<string>();
      return out.filter((c) => (seen.has(c.entry.id) ? false : (seen.add(c.entry.id), true))).slice(0, PHASE_LIMITS.catalog);
    },
  };

  if (ctx.done()) return;
  if (online && lib.searchEnabled) {
    yield {
      phase: 'web',
      discover: async () => {
        const gh = await githubFonts(lib, name, scripts, ctx.signal);
        const npm = await npmFonts(lib, name, ctx.signal);
        return dedupe([...gh, ...npm]).map((entry) => ({ entry, alias: false, blind: true })).slice(0, PHASE_LIMITS.web);
      },
    };
  }

  if (ctx.done()) return;
  yield {
    phase: 'script',
    discover: async () => {
      const manifest = online ? await lib.googleManifest() : null;
      if (!manifest) return [];
      const families = khmer ? SCRIPT_FAMILIES.khmr : [];
      for (const s of scripts) if (s !== 'khmr' && s !== 'latn') families.push(...SCRIPT_FAMILIES[s]);
      const list = families.length ? families : LATIN_POPULAR;
      const out: ScrapeCandidate[] = [];
      for (const fam of list) {
        for (const e of lib.googleEntriesFor(manifest, fam, weight, italic, 2)) out.push({ entry: e, alias: false, blind: true });
      }
      return out.slice(0, PHASE_LIMITS.script);
    },
  };

  if (ctx.done()) return;
  yield {
    phase: 'sweep',
    discover: async () => {
      if (!online || !outlinesComparable()) return [];
      const manifest = await lib.googleManifest();
      if (!manifest) return [];
      const probe = normKey(name.clean).slice(0, 3);
      const fams = Object.keys(manifest.families).sort((a, b) => Number(!a.startsWith(probe)) - Number(!b.startsWith(probe)) || a.localeCompare(b));
      const out: ScrapeCandidate[] = [];
      for (const fam of fams) {
        for (const e of lib.googleEntriesFor(manifest, fam, weight, italic, 1)) out.push({ entry: e, alias: false, blind: true });
        if (out.length >= PHASE_LIMITS.sweep) break;
      }
      return out;
    },
  };
}

