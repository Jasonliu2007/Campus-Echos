import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../cloudfunctions/xiaopinTrade/repository.js', import.meta.url));
const target = fileURLToPath(new URL('../cloudfunctions/xiaopinPdfWorker/repository.js', import.meta.url));
const content = await readFile(source, 'utf8');
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== content) { console.error('Trade worker repository differs; run sync-trade-repository.mjs'); process.exitCode = 1; }
  else console.log('Trade repositories match');
} else { await writeFile(target, content); console.log('Trade worker repository synchronized'); }
