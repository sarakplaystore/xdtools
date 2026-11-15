/** Browser wiring for the engine: where assets, remote fonts and WebAssembly come from. */
import subsetWasmUrl from 'harfbuzzjs/dist/harfbuzz-subset.wasm?url';
import { setSubsetWasmLoader } from './font/hb';
import { FontLibrary, GoogleManifest, RemoteSource } from './font/library';

const BASE = import.meta.env.BASE_URL;
const CACHE = 'xdtools-fonts-v1';

async function fetchBytes(url: string, init?: RequestInit, timeoutMs = 15000): Promise<Uint8Array> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/** Tries each mirror in turn; successful downloads are kept in the browser's Cache Storage. */
async function fetchRemote(sources: RemoteSource[]): Promise<Uint8Array> {
  const key = sources[0].url;
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(key);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  } catch {
    cache = null; // Cache Storage unavailable (private mode, insecure context…)
  }
  let lastError: unknown = new Error('No source');
  for (const src of sources) {
    try {
      const bytes = await fetchBytes(src.url, { headers: src.headers, mode: 'cors', credentials: 'omit' }, 8000);
      if (bytes.length < 1000) throw new Error('Unexpectedly small file');
      try {
        await cache?.put(key, new Response(bytes as BodyInit, { headers: { 'Content-Type': 'font/ttf' } }));
      } catch {
        /* caching is best-effort */
      }
      return bytes;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

let library: FontLibrary | null = null;

export function getLibrary(): FontLibrary {
  if (!library) {
    setSubsetWasmLoader(async () => (await fetchBytes(subsetWasmUrl)).buffer as ArrayBuffer);
    library = new FontLibrary({
      readAsset: (path) => fetchBytes(BASE + path),
      fetchRemote,
      loadGoogleManifest: async () => (await import('../data/google-fonts.json')).default as unknown as GoogleManifest,
    });
  }
  return library;
}

export const assetUrl = (path: string) => BASE + path;
