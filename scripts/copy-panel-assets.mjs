// Copies the panel's static assets into dist/, which tsc will not do on its own
// because it only compiles .ts files.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const from = resolve('src/panel/public');
const to = resolve('dist/panel/public');

if (!existsSync(from)) {
  console.error(`copy-panel-assets: ${from} not found`);
  process.exit(1);
}

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });