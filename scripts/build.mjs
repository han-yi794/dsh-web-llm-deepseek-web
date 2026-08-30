// Adapter build: bundle src/*.ts → dist/index.js (single ESM file).
// Peer deps (@deepseek-ai/cordis, dsh-llm, schemastery) stay external; all
// relative imports are inlined so Node never has to load a .ts from node_modules.
'use strict';

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outfile = join(here, '..', 'dist', 'index.js');
mkdirSync(dirname(outfile), { recursive: true });

build({
  entryPoints: [join(here, '..', 'src', 'index.ts')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['@deepseek-ai/*'],
  sourcemap: false,
  logLevel: 'info',
}).catch((err) => {
  console.error(err);
  process.exit(1);
});