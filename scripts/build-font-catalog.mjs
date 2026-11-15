#!/usr/bin/env node
/**
 * Builds src/data/font-catalog.json — the index the PDF editor uses to
 * recognise fonts by name.
 *
 *   node scripts/build-font-catalog.mjs \
 *        [--remote <localDir>=<owner/repo>@<sha>[:<pathPrefix>]]...
 *
 * Fonts under public/fonts are indexed as "bundled" (served by this site).
 * Each --remote maps a local checkout of a public GitHub repository to
 * download-on-demand entries (the files themselves are not copied).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hb from 'harfbuzzjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ttf|otf)$/i.test(name)) out.push(p);
  }
  return out;
}

function category(family) {
  const f = family.toLowerCase();
  if (/hand/.test(f)) return 'hand';
  if (/muol|moul|koulen|bokor|angkor|metal|dangrek|bayon|bassac|kangrey/.test(f)) return 'display';
  if (/mono|courier|cousine/.test(f)) return 'mono';
  if (/serif|tinos|times|caladea|gelasio/.test(f) && !/sans/.test(f)) return 'serif';
  if (/sans|arimo|liberation|carlito|ui$/.test(f)) return 'sans';
  return 'body';
}

function describe(file) {
  const bytes = new Uint8Array(readFileSync(file));
  const face = new hb.Face(new hb.Blob(bytes), 0);
  const font = new hb.Font(face);
  const nm = (id) => {
    try { return face.getName(id, 'en') || ''; } catch { return ''; }
  };
  const family = nm(16) || nm(1);
  const style = nm(17) || nm(2) || 'Regular';
  const os2 = face.referenceTable('OS/2');
  const weight = os2 && os2.length > 6 ? (os2[4] << 8) | os2[5] : 400;
  const axesInfo = face.getAxisInfos();
  const axes = {};
  for (const tag in axesInfo) axes[tag] = [axesInfo[tag].min, axesInfo[tag].max];
  const scripts = [];
  if (font.nominalGlyph(0x1780)) scripts.push('khmer');
  if (font.nominalGlyph(0x41)) scripts.push('latin');
  const keys = [...new Set([family, nm(1), nm(4), nm(6), `${family} ${style}`].filter(Boolean).map(norm))];
  return {
    family, style, weight, italic: /italic|oblique/i.test(style), keys, scripts,
    cat: category(family), version: nm(5).slice(0, 24), ...(Object.keys(axes).length ? { axes } : {}),
  };
}

const entries = [];
const bundledDir = join(root, 'public', 'fonts');
for (const file of walk(bundledDir)) {
  const rel = relative(bundledDir, file).split('\\').join('/');
  const d = describe(file);
  const src = rel.startsWith('khmeros/') ? 'Khmer OS 5.0' : 'Google Fonts';
  entries.push({ id: `b:${rel}`, ...d, source: 'bundled', label: `Built-in · ${src}`, url: rel });
}

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--remote') continue;
  const m = /^(.+?)=([^@]+)@([0-9a-f]+)(?::(.*))?$/.exec(args[++i] || '');
  if (!m) throw new Error('bad --remote spec');
  const [, localDir, repo, ref, prefix = ''] = m;
  for (const file of walk(localDir)) {
    const rel = relative(localDir, file).split('\\').join('/');
    const d = describe(file);
    entries.push({ id: `gh:${repo}:${prefix}${rel}`, ...d, source: 'github', label: `GitHub · ${repo.split('/')[1]}`, gh: [repo, ref, prefix + rel] });
  }
}

const outFile = join(root, 'src', 'data', 'font-catalog.json');
writeFileSync(outFile, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), fonts: entries }, null, 1) + '\n');
console.log(`wrote ${entries.length} fonts → ${relative(root, outFile)}`);
