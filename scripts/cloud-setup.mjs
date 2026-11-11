#!/usr/bin/env node
// Preview only: resource creation and deployment are deliberately separate actions.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'scripts/cloud-setup.json'), 'utf8'));
const project = JSON.parse(readFileSync(resolve(root, 'project.config.json'), 'utf8'));
if (project.appid !== manifest.appid) throw new Error('AppID differs from the verified deployment target.');
for (const relative of ['cloudfunctions/xiaopinWall/index.js', 'cloudfunctions/xiaopinWall/service.js', 'cloudfunctions/xiaopinWall/repository.js']) {
  if (!existsSync(resolve(root, relative))) throw new Error(`Missing function source: ${relative}`);
}
console.log(JSON.stringify({
  mode: 'read-only-preflight',
  version: manifest.version,
  appid: manifest.appid,
  env: manifest.env,
  function: manifest.functionName,
  collections: manifest.collections.map((item) => ({ name: item.name, indexCount: item.indexes.length })),
  permissions: manifest.clientDatabasePermissions,
  serverConfiguration: { timeoutSeconds: manifest.timeoutSeconds, environmentVariable: manifest.bootstrapEnvironmentVariable },
  note: 'No cloud changes were made. Use docs/cloud-setup.md for explicit resource and deployment steps.',
}, null, 2));
