import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FontLibrary, GoogleManifest, RemoteSource } from '../src/engine/font/library';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function nodeLibrary(opts: { remote?: (sources: RemoteSource[]) => Promise<Uint8Array> } = {}): FontLibrary {
  return new FontLibrary({
    readAsset: async (path) => {
      const file = path.startsWith('pdfjs/') ? join(ROOT, 'node_modules/pdfjs-dist', path.slice(6)) : join(ROOT, 'public', path);
      return new Uint8Array(await readFile(file));
    },
    fetchRemote: opts.remote,
    loadGoogleManifest: opts.remote
      ? async () => JSON.parse(await readFile(join(ROOT, 'src/data/google-fonts.json'), 'utf8')) as GoogleManifest
      : undefined,
  });
}
