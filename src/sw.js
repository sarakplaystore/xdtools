/* Build id, replaced by scripts/offline-manifest.mjs when the build is written out. Without it,
   this file would be byte-identical on every deployment, the browser would never see an update,
   and a reader would be stuck on the first version they ever loaded. */
const BUILD = '__BUILD_ID__';

/**
 * xdtools service worker — the site works with no network at all.
 *
 * Two kinds of files are kept, for two different reasons:
 *
 *  - The *shell* (the HTML, the scripts with their hashed names, the icons, the sample PDF) is
 *    copied in when this file is installed, so every page of the site opens offline.
 *  - The *extras* (the Khmer OS fonts, pdf.js character maps, the WebAssembly modules) are kept
 *    as they are fetched, so the editor can render and edit a PDF with flight mode on.
 *
 * Every cache is named after the build id stamped into this file by `scripts/offline-manifest.mjs`.
 * A new deployment therefore gets new caches and the previous ones are deleted on activation:
 * keeping them would only fill the phone with files nothing can open any more.
 *
 * The one thing kept across deployments is `xdtools-fonts-v1`, the cache the page itself writes
 * for fonts it downloaded from Google Fonts. Those are keyed by URL, not by build, and they are
 * still good.
 */

/** What to keep if the manifest cannot be read (a very old cache, or a hand-deployed build). */
const FALLBACK_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg', '/samples/khmer-letter.pdf'];
const FONT_CACHE = 'xdtools-fonts-v1';
const MANIFEST = '/offline-manifest.json';

/** Cache names for this worker, and the file list of its deployment.
 *
 * The name comes from the build id baked into this file, not from the manifest: the worker has to
 * know where its own caches are even with no network, and the id is already unique per deployment
 * (the build script refuses to write a worker without one). The manifest is only needed for the
 * list of files to pre-cache, and it is read from the cache when the network is gone. */
let current = null;

async function manifestFiles() {
  const read = async (res) => (res?.ok ? ((await res.json()).files || []) : null);
  // A cached copy first: a worker restarted offline must still know what its pack holds.
  try {
    const hit = await caches.match(MANIFEST);
    const files = await read(hit);
    if (files) return files;
  } catch {
    /* no cache yet */
  }
  try {
    const files = await read(await fetch(MANIFEST, { cache: 'no-store' }));
    if (files) return files;
  } catch {
    /* offline on the very first visit */
  }
  return null;
}

async function prepare() {
  if (current) return current;
  // The build script guarantees the placeholder above was replaced, so this is the real id.
  const version = BUILD;
  const files = await manifestFiles();
  const shell = files
    ? [...FALLBACK_SHELL, ...files.filter((f) => f.startsWith('assets/')).map((f) => `/${f}`)]
    : FALLBACK_SHELL;
  current = { shell: `xdtools-shell-${version}`, runtime: `xdtools-runtime-${version}`, files };
  return current;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const { shell, files } = await prepare();
      const cache = await caches.open(shell);
      // The file list itself, so a worker that starts up with no network can still say what its
      // pack should contain (see `manifestFiles`).
      try {
        await cache.add(new Request(MANIFEST, { cache: 'reload' }));
      } catch {
        /* offline before the first install: the fallback shell is all there is */
      }
      // One at a time rather than `addAll`: a single missing optional file must not stop the
      // whole installation, and a worker that will not install is a site that will not work.
      for (const url of files ? ['/index.html', ...files.filter((f) => f.startsWith('assets/')).map((f) => `/${f}`)] : FALLBACK_SHELL) {
        try {
          await cache.add(new Request(url, { cache: 'reload' }));
        } catch {
          /* optional file: skip it and keep going */
        }
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const { shell, runtime } = await prepare();
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('xdtools-') && name !== FONT_CACHE && name !== shell && name !== runtime)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Keep a copy of a response we are already delivering, for the next visit with no signal. */
async function remember(request, response) {
  if (!response || response.status !== 200 || response.type === 'opaque') return response;
  const { shell, runtime } = await prepare();
  const url = new URL(request.url);
  // The hashed build files belong with the shell; fonts and pdf.js data are the extras.
  const name = url.pathname.startsWith('/assets/') ? shell : runtime;
  try {
    const cache = await caches.open(name);
    await cache.put(request, response.clone());
  } catch {
    /* the phone is full or the response cannot be copied: the page still gets its file */
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Fonts from Google Fonts and other origins are the page's own business (`platform.browser.ts`
  // keeps those in its own cache).
  if (url.origin !== self.location.origin) return;

  // Pages: every route is the same document, so answer from the cached shell.
  if (request.mode === 'navigate') {
    // Both `respondWith` and `waitUntil` have to be called while the event is still being
    // dispatched, so the work starts here and the promise is handed over straight away.
    const answer = (async () => {
      const { shell } = await prepare();
      const cache = await caches.open(shell);
      return (await cache.match('/index.html')) || (await cache.match('/')) || null;
    })();
    const refreshed = answer.then(async (hit) => {
      if (!hit) return fetch(request);
      // Refresh quietly; the reader gets the cached copy now.
      try {
        await remember(request, await fetch(request));
      } catch {
        /* offline: the cached copy is the point */
      }
      return hit;
    });
    event.respondWith(refreshed);
    event.waitUntil(refreshed.catch(() => {}));
    return;
  }

  // Everything else: cache first. A deployment never reuses a file name, so a hit is a good file.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      return remember(request, await fetch(request));
    })(),
  );
});

/**
 * Messages from the page: take over after a new deployment, report how much is cached, or throw
 * the caches away. A new deployment's worker waits until the page asks for it, so an open tab is
 * never left pointing at asset names its worker has already deleted.
 */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];

  if (data.type === 'SKIP_WAITING') {
    void self.skipWaiting();
    return;
  }

  if (data.type === 'offline-status') {
    event.waitUntil(
      (async () => {
        const { shell, runtime } = await prepare();
        let cached = 0;
        for (const name of [shell, runtime]) {
          try {
            cached += (await (await caches.open(name)).keys()).length;
          } catch {
            /* no cache yet */
          }
        }
        port?.postMessage({ cached, shell, runtime });
      })(),
    );
  }

  if (data.type === 'offline-clear') {
    event.waitUntil(
      (async () => {
        const { shell, runtime } = await prepare();
        await Promise.all([caches.delete(shell), caches.delete(runtime)]);
        const clients = await self.clients.matchAll();
        clients.forEach((client) => client.postMessage({ type: 'offline-cleared' }));
      })(),
    );
  }
});
