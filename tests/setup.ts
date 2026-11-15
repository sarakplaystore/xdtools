import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSubsetWasmLoader } from '../src/engine/font/hb';

const require = createRequire(import.meta.url);
const hbMain = fileURLToPath(import.meta.resolve('harfbuzzjs'));
setSubsetWasmLoader(async () => readFile(join(dirname(hbMain), 'harfbuzz-subset.wasm')));
void require;
