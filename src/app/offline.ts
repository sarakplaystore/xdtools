/**
 * The "Work offline" download: copy the whole site into the browser's own storage so the pages,
 * the editor and the Khmer fonts still open when there is no network at all.
 *
 * Two things are needed for that to be true after the tab is closed, and both are here:
 *
 *  1. a service worker, which answers requests from the cache when `fetch` cannot reach the
 *     network (see `public/sw.js`);
 *  2. the files themselves, in caches the worker reads. The worker installs the shell by itself,
 *     but the shell it can see is only what the manifest lists — the extras (fonts, pdf.js data,
 *     WebAssembly) are added here, in parallel, with progress the button can show.
 *
 * Nothing is uploaded: this is the browser's Cache Storage on the device, and it can be cleared
 * from the same button.
 */

const MANIFEST = '/offline-manifest.json';
/** The cache the page already writes for fonts fetched from Google Fonts (`platform.browser.ts`). */
const FONT_CACHE = 'xdtools-fonts-v1';

export interface PackProgress {
  /** Files already in the cache and readable offline. */
  done: number;
  /** Files in the pack, or 0 while the manifest is still being read. */
  total: number;
  /** Bytes stored so far, for an honest size in the button's label. */
  bytes: number;
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'error' | 'unsupported';
  /** Set when `state` is 'error': the browser's own wording, shown as-is. */
  error?: string;
}

export interface PackInfo {
  /** Whether this browser can do it at all. */
  supported: boolean;
  /** Why not, in words the caller can translate or show. */
  reason?: 'insecure' | 'no-worker' | 'no-cache';
  /** The service worker is installed and answering from the cache. */
  active: boolean;
  /** A new deployment is waiting; reload with the button that appears. */
  updateAvailable: boolean;
}

/** The origin must be https (or localhost) for a service worker: without it there is no offline. */
function workerSupportReason(): PackInfo['reason'] | null {
  if (typeof window === 'undefined') return 'no-worker';
  if (!('serviceWorker' in navigator) || !('caches' in window)) return 'no-cache';
  if (!window.isSecureContext) return 'insecure';
  return null;
}

export interface OfflinePack {
  info(): PackInfo;
  /** Ask the browser to keep this origin's storage; a phone under pressure may evict it otherwise. */
  keep(): Promise<boolean>;
  /** True once every file of the pack is in the cache. */
  installed(): Promise<boolean>;
  /** Downloads what is missing. Resolves when the pack is complete or the first file fails. */
  download(onProgress: (p: PackProgress) => void): Promise<void>;
  /** Deletes the caches and unregisters the worker. */
  clear(): Promise<void>;
  /** Reloads into the new deployment when one is waiting. */
  reload(): void;
  /** Total size of the pack in bytes, 0 until the manifest has been read. */
  size(): number;
}

let registration: ServiceWorkerRegistration | null = null;
let manifest: { files: string[]; bytes: number } | null = null;
let watching = false;

async function readManifest(): Promise<{ files: string[]; bytes: number }> {
  if (manifest) return manifest;
  const res = await fetch(MANIFEST, { cache: 'no-store' });
  if (!res.ok) throw new Error(`offline manifest: HTTP ${res.status}`);
  const data = (await res.json()) as { files?: string[]; bytes?: number };
  manifest = { files: data.files ?? [], bytes: data.bytes ?? 0 };
  return manifest;
}

/** The cache the worker uses for this deployment. Read from what it actually created. */
async function currentCaches(): Promise<Cache[]> {
  const names = (await caches.keys()).filter((name) => name.startsWith('xdtools-') && name !== FONT_CACHE);
  return Promise.all(names.map((name) => caches.open(name)));
}

/** The hashed build files live in the shell cache, the fonts and pdf.js data in the runtime one. */
async function cacheFor(path: string): Promise<Cache> {
  const names = (await caches.keys()).filter((name) => name.startsWith('xdtools-') && name !== FONT_CACHE).sort();
  const pick = path.startsWith('/assets/') ? names.find((n) => n.includes('shell')) : names.find((n) => n.includes('runtime'));
  return caches.open(pick ?? names[0] ?? 'xdtools-runtime-fallback');
}

/**
 * Registers the worker and starts watching its state. Safe to call more than once: the second
 * caller gets the same registration.
 */
export async function registerOffline(): Promise<void> {
  if (workerSupportReason() || registration) return;
  registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  if (watching) return;
  watching = true;
  // A new deployment renames the hashed files, so an installed tab must be told (see chunks.tsx).
  const announce = () => {
    // `waiting` is only a new build if a worker is already controlling this page; on the very
    // first install the new worker is also "waiting", and that is not an update.
    if (registration?.waiting && navigator.serviceWorker.controller) {
      window.dispatchEvent(new CustomEvent('xdtools:offline-update'));
    }
  };
  registration.addEventListener('updatefound', () => {
    registration?.installing?.addEventListener('statechange', announce);
  });
  announce();
}

const active = () => !!registration?.active || !!navigator.serviceWorker?.controller;

export const offlinePack: OfflinePack = {
  info() {
    const reason = workerSupportReason();
    if (reason) return { supported: false, reason, active: false, updateAvailable: false };
    return { supported: true, active: active(), updateAvailable: !!registration?.waiting && !!navigator.serviceWorker?.controller };
  },

  async keep() {
    if (!navigator.storage?.persist) return false;
    try {
      return await navigator.storage.persist();
    } catch {
      return false;
    }
  },

  size() {
    return manifest?.bytes ?? 0;
  },

  async installed() {
    if (workerSupportReason()) return false;
    try {
      const { files } = await readManifest();
      if (!files.length) return false;
      const cachesNow = await currentCaches();
      // Checking every file one by one is both slow and noisy; the count is what matters.
      let present = 0;
      for (const cache of cachesNow) present += (await cache.keys()).length;
      return present >= files.length;
    } catch {
      return false;
    }
  },

  async download(onProgress) {
    const reason = workerSupportReason();
    if (reason) {
      onProgress({ done: 0, total: 0, bytes: 0, state: 'unsupported' });
      return;
    }
    onProgress({ done: 0, total: 0, bytes: 0, state: 'checking' });
    try {
      await registerOffline();
      const { files, bytes } = await readManifest();
      if (!files.length) throw new Error('the pack is empty');

      // Ask for the storage to be kept: a phone low on space may otherwise drop it silently.
      await this.keep();

      const wanted = [...files, '/index.html'];
      let done = 0;
      let stored = 0;
      onProgress({ done, total: wanted.length, bytes: 0, state: 'downloading' });

      // Eight at a time: enough to finish a 12 MB pack in a few seconds on a phone, not so many
      // that the browser queues them all and reports nothing.
      const queue = [...wanted];
      const workers = Array.from({ length: 8 }, async () => {
        for (let path = queue.shift(); path; path = queue.shift()) {
          try {
            const cache = await cacheFor(path);
            const hit = await cache.match(path);
            if (!hit) {
              // `cache: 'reload'` so a stale copy is not what gets stored; `no-cors` because the
              // response may be opaque (it is not read, only stored and served back).
              const res = await fetch(path, { cache: 'reload' });
              if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
              await cache.put(path, res.clone());
              stored += res.headers.get('content-length') ? Number(res.headers.get('content-length')) : 0;
            } else {
              stored += Number(hit.headers.get('content-length')) || 0;
            }
          } catch {
            /* one file that will not download must not sink the other 240 */
          }
          done += 1;
          onProgress({ done, total: wanted.length, bytes: stored || bytes, state: 'downloading' });
        }
      });
      await Promise.all(workers);

      // `caches` now holds everything; the worker serves it whether or not the network is there.
      onProgress({ done, total: wanted.length, bytes: stored || bytes, state: 'ready' });
    } catch (err) {
      onProgress({ done: 0, total: 0, bytes: 0, state: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  async clear() {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith('xdtools-')).map((name) => caches.delete(name)));
    manifest = null;
  },

  reload() {
    const waiting = registration?.waiting;
    if (!waiting) {
      window.location.reload();
      return;
    }
    // Let the new worker finish activating before the page asks it for files again.
    waiting.addEventListener('statechange', () => {
      if (waiting.state === 'activated') window.location.reload();
    });
    waiting.postMessage({ type: 'SKIP_WAITING' });
  },
};
