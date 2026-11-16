/** Browser wiring for the engine: where assets, remote fonts and WebAssembly come from. */
import subsetWasmUrl from 'harfbuzzjs/dist/harfbuzz-subset.wasm?url';
import { looksLikeFont, looksLikeWoff, setSubsetWasmLoader } from './font/hb';
import { type CatalogEntry, type FetchJsonOptions, type FetchRemoteOptions, FontLibrary, type GoogleManifest, type RemoteSource } from './font/library';

const BASE = import.meta.env.BASE_URL;
const CACHE = 'xdtools-fonts-v1';
const SAVED_KEY = 'xdtools-scraped-fonts-v1';
const SAVED_LIMIT = 64;
const MAX_FONT_BYTES = 25_000_000;

/** After a rate-limit (403/429) from the GitHub API, skip it for a minute instead of hammering it. */
let ghApiBackoffUntil = 0;
const isGitHubApi = (url: string) => url.startsWith('https://api.github.com/');
const abortError = () => new DOMException('Aborted', 'AbortError');

async function fetchBytes(url: string, init?: RequestInit, timeoutMs = 15000, outer?: AbortSignal): Promise<Uint8Array> {
  if (outer?.aborted) throw abortError();
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  outer?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches !== 'undefined' ? await caches.open(CACHE) : null;
  } catch {
    return null; // Cache Storage unavailable (private mode, insecure context…)
  }
}

/**
 * Tries each mirror in turn. Cached copies are served first; successful downloads are kept in the
 * browser's Cache Storage unless `cache: false` (transient scrape probes must not bloat storage).
 */
async function fetchRemote(sources: RemoteSource[], opts: FetchRemoteOptions = {}): Promise<Uint8Array> {
  if (opts.signal?.aborted) throw abortError();
  const cache = await openCache();
  for (const src of sources) {
    const hit = await cache?.match(src.url).catch(() => undefined);
    if (!hit) continue;
    const bytes = new Uint8Array(await hit.arrayBuffer());
    if (looksLikeFont(bytes) || looksLikeWoff(bytes)) return bytes;
  }
  let lastError: unknown = new Error('No source');
  for (const src of sources) {
    if (opts.signal?.aborted) throw abortError();
    if (isGitHubApi(src.url) && Date.now() < ghApiBackoffUntil) continue;
    try {
      const bytes = await fetchBytes(src.url, { headers: src.headers, mode: 'cors', credentials: 'omit' }, 8000, opts.signal);
      if (bytes.length > MAX_FONT_BYTES) throw new Error('Font file too large');
      if (!looksLikeFont(bytes) && !looksLikeWoff(bytes)) throw new Error('Not a font file');
      if (opts.cache !== false) {
        try {
          await cache?.put(src.url, new Response(bytes as BodyInit, { headers: { 'Content-Type': 'font/ttf' } }));
        } catch {
          /* caching is best-effort */
        }
      }
      return bytes;
    } catch (err) {
      if (opts.signal?.aborted) throw abortError();
      if (isGitHubApi(src.url) && /HTTP (403|429)/.test(String((err as Error).message))) ghApiBackoffUntil = Date.now() + 60_000;
      lastError = err;
    }
  }
  throw lastError;
}

/** Public JSON index (GitHub, jsDelivr, npm). Returns null on any failure so scraping can continue. */
async function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  if (opts.signal?.aborted) throw abortError();
  if (isGitHubApi(url) && Date.now() < ghApiBackoffUntil) return null;
  try {
    const bytes = await fetchBytes(url, { headers: { Accept: 'application/json', ...opts.headers }, mode: 'cors', credentials: 'omit' }, 8000, opts.signal);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    if (opts.signal?.aborted) throw abortError();
    if (isGitHubApi(url) && /HTTP (403|429)/.test(String((err as Error).message))) ghApiBackoffUntil = Date.now() + 60_000;
    return null;
  }
}

/** Keeps a matched remote font for offline re-opens (same Cache Storage as `fetchRemote`). */
async function cacheRemote(url: string, bytes: Uint8Array): Promise<void> {
  const cache = await openCache();
  await cache?.put(url, new Response(bytes as BodyInit, { headers: { 'Content-Type': 'font/ttf' } }));
}

function loadSavedEntries(): CatalogEntry[] {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(SAVED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as CatalogEntry[]) : [];
  } catch {
    return [];
  }
}

function saveEntry(entry: CatalogEntry): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const list = loadSavedEntries().filter((e) => e.id !== entry.id);
    list.unshift(entry);
    localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, SAVED_LIMIT)));
  } catch {
    /* quota or privacy mode */
  }
}

let library: FontLibrary | null = null;

export function getLibrary(): FontLibrary {
  if (!library) {
    setSubsetWasmLoader(async () => (await fetchBytes(subsetWasmUrl)).buffer as ArrayBuffer);
    library = new FontLibrary({
      readAsset: (path) => fetchBytes(BASE + path),
      fetchRemote,
      fetchJson,
      cacheRemote,
      loadSavedEntries,
      saveEntry,
      loadGoogleManifest: async () => (await import('../data/google-fonts.json')).default as unknown as GoogleManifest,
    });
  }
  return library;
}

export const assetUrl = (path: string) => BASE + path;
