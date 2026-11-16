#!/usr/bin/env node
/**
 * Writes `dist/offline-manifest.json` — the list of every file this deployment serves — and puts
 * the build id into `dist/sw.js`.
 *
 * The service worker has to change on every deployment, or the browser never notices there is a
 * new one and a reader stays on the first version they loaded. Its script is copied from `src/`
 * rather than `public/` for exactly that reason: the id below is derived from the file list, so it
 * changes whenever any hashed asset name does.
 *
 * Runs from the `build` script, after `vite build`.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

/** The manifest lists the pack, and the worker delivers it: neither is a pack file. */
const SKIP = [/^offline-manifest\.json$/, /^sw\.js$/];

function walk(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else found.push(relative(dist, full).split(sep).join('/'));
  }
  return found;
}

const files = walk(dist)
  .filter((path) => !SKIP.some((re) => re.test(path)))
  .sort();

const bytes = files.reduce((sum, path) => sum + statSync(join(dist, path)).size, 0);

// A fingerprint of the deployment: hashed asset names make it unique per build, and it only has
// to be stable for one deployment, not cryptographic.
let hash = 5381;
for (const file of files) for (let i = 0; i < file.length; i++) hash = ((hash << 5) + hash + file.charCodeAt(i)) | 0;
const buildId = (hash >>> 0).toString(36);

writeFileSync(
  join(dist, 'offline-manifest.json'),
  `${JSON.stringify({ version: 1, build: buildId, generated: new Date().toISOString(), bytes, files })}\n`,
);

const sw = readFileSync(join(root, 'src', 'sw.js'), 'utf8');
// Exactly one placeholder: the build id must be stated once, in the assignment only. A second
// mention (say, in a comparison) would be replaced too and quietly make every build the same.
const marks = sw.split('__BUILD_ID__').length - 1;
if (marks !== 1) {
  console.error(`src/sw.js must contain __BUILD_ID__ exactly once, found ${marks}: updates would never be detected.`);
  process.exit(1);
}
writeFileSync(join(dist, 'sw.js'), sw.replace('__BUILD_ID__', buildId));

console.log(`offline pack → dist/offline-manifest.json + dist/sw.js (build ${buildId}, ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB)`);
