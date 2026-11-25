#!/usr/bin/env node
// Keep the independent cleanup deployment available during xiaopinWall rollback.
import { copyFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['report-cleanup.js', 'repository.js', 'media-lifecycle.js']) {
  const from = resolve(root, 'cloudfunctions/xiaopinWall', name);
  const to = resolve(root, 'cloudfunctions/xiaopinReportCleanup', name);
  if (process.argv.includes('--check')) {
    if (readFileSync(from, 'utf8') !== readFileSync(to, 'utf8')) throw new Error(`Cleanup source drift: ${name}`);
  } else copyFileSync(from, to);
}
console.log(process.argv.includes('--check') ? 'Cleanup deployment sources match.' : 'Cleanup deployment sources synchronized.');
