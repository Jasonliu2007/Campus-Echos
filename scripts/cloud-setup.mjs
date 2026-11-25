#!/usr/bin/env node
// Local read-only desired-state validation. This never queries or changes cloud resources.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (root, relative) => JSON.parse(readFileSync(resolve(root, relative), 'utf8'));
const text = (root, relative) => readFileSync(resolve(root, relative), 'utf8');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const privateOnly = value => value && value.read === false && value.write === false;
const ordered = values => [...values].sort();
function requireCheck(ok, message) { if (!ok) throw new Error(message); }
function sourceConstant(root, relative, name) {
  const match = text(root, relative).match(new RegExp(`const ${name} = ['"]([^'"]+)['"]`));
  requireCheck(match, `Missing source constant ${name}: ${relative}`);
  return match[1];
}
function repositoryCollections(root, relative) {
  const match = text(root, relative).match(/const COLLECTIONS\s*=\s*\{([\s\S]*?)\};/);
  requireCheck(match, `Missing repository collection map: ${relative}`);
  return [...match[1].matchAll(/['"](xiaopin_[a-z_]+)['"]/g)].map(value => value[1]);
}

export function preflight(root = defaultRoot, overrides = {}) {
  const manifest = overrides.manifest || json(root, 'scripts/cloud-setup.json');
  const trade = overrides.trade || json(root, manifest.tradeManifest);
  const project = json(root, 'project.config.json');
  requireCheck(project.appid === manifest.appid && trade.appid === manifest.appid, 'AppID differs across project and desired manifests.');
  requireCheck(trade.env === manifest.env && text(root, 'config.js').includes(`'${manifest.env}'`), 'Cloud environment differs across project and desired manifests.');
  requireCheck(privateOnly(manifest.clientDatabasePermissions) && privateOnly(trade.clientDatabasePermissions) && privateOnly(trade.clientStoragePermissions), 'Desired database and storage permissions must all deny direct client access.');
  requireCheck(trade.paidEnabled === false && /paidEnabled:\s*false/.test(text(root, 'cloudfunctions/xiaopinTrade/index.js')), 'Paid path must remain disabled.');

  const cleanup = manifest.cleanupFunction;
  const functions = [
    { name: manifest.functionName, source: `cloudfunctions/${manifest.functionName}`, version: manifest.version, versionFile: 'service.js', runtime: manifest.runtime, memoryMB: manifest.memoryMB, timeoutSeconds: manifest.timeoutSeconds, allowedOpenapi: manifest.allowedOpenapi, dependencies: manifest.dependencies, triggers: [] },
    { name: cleanup.name, source: `cloudfunctions/${cleanup.name}`, version: cleanup.version, versionFile: 'handler.js', runtime: cleanup.runtime, memoryMB: cleanup.memoryMB, timeoutSeconds: cleanup.timeoutSeconds, allowedOpenapi: [], dependencies: cleanup.dependencies, triggers: [{ name: cleanup.triggerName, type: cleanup.type, config: cleanup.cron }] },
    ...trade.functions.map(row => ({ ...row, versionFile: row.name === 'xiaopinPdfWorker' ? 'worker.js' : 'service.js' })),
  ];
  requireCheck(new Set(functions.map(row => row.name)).size === functions.length, 'Duplicate desired function names.');
  const desiredCollections = new Map();
  for (const row of [...manifest.collections, ...trade.collections]) {
    requireCheck(!desiredCollections.has(row.name), `Duplicate desired collection: ${row.name}`);
    requireCheck(!row.permissions || privateOnly(row.permissions), `Unsafe desired permission: ${row.name}`);
    requireCheck(Array.isArray(row.indexes), `Missing desired indexes: ${row.name}`);
    const names = new Set();
    for (const index of row.indexes) {
      requireCheck(index.name && !names.has(index.name), `Duplicate or missing index name: ${row.name}`);
      names.add(index.name);
      requireCheck(Array.isArray(index.fields) && index.fields.length > 0 && index.fields.every(field => Array.isArray(field) && typeof field[0] === 'string' && [1, -1].includes(field[1])), `Invalid desired index: ${row.name}/${index.name}`);
    }
    desiredCollections.set(row.name, { ...row, permissions: manifest.clientDatabasePermissions });
  }
  const usedCollections = new Set(functions.flatMap(row => repositoryCollections(root, `${row.source}/repository.js`)));
  for (const name of usedCollections) requireCheck(desiredCollections.has(name), `Repository collection missing from desired plan: ${name}`);
  for (const name of desiredCollections.keys()) requireCheck(usedCollections.has(name), `Desired collection absent from repositories: ${name}`);
  for (const reused of trade.reusedCollections || []) requireCheck(desiredCollections.has(reused.name), `Reused collection absent from desired plan: ${reused.name}`);

  const checks = [];
  const checkShared = (from, to) => {
    requireCheck(text(root, from) === text(root, to), `Shared deployment source drift: ${from} <> ${to}`);
    checks.push({ check: 'sharedSource', from, to, passed: true });
  };
  for (const name of ['report-cleanup.js', 'repository.js', 'media-lifecycle.js']) checkShared(`cloudfunctions/xiaopinWall/${name}`, `cloudfunctions/xiaopinReportCleanup/${name}`);
  checkShared('cloudfunctions/xiaopinTrade/repository.js', 'cloudfunctions/xiaopinPdfWorker/repository.js');
  const verifiedFunctions = functions.map(row => {
    requireCheck(existsSync(resolve(root, row.source, 'index.js')), `Missing function entry: ${row.source}`);
    requireCheck(sourceConstant(root, `${row.source}/${row.versionFile}`, 'VERSION') === row.version, `Source version differs from desired manifest: ${row.name}`);
    if (['xiaopinWall', 'xiaopinTrade'].includes(row.name)) requireCheck(sourceConstant(root, `${row.source}/service.js`, 'APPID') === manifest.appid, `Source AppID differs: ${row.name}`);
    const config = json(root, `${row.source}/config.json`);
    requireCheck(equal(ordered(config.permissions?.openapi || []), ordered(row.allowedOpenapi || [])), `OpenAPI permission drift: ${row.name}`);
    const triggers = (config.triggers || []).map(({ name, type, config }) => ({ name, type, config }));
    requireCheck(equal(triggers, (row.triggers || []).map(({ name, type, config }) => ({ name, type, config }))), `Timer trigger drift: ${row.name}`);
    const dependencies = json(root, `${row.source}/package.json`).dependencies;
    const dependencyMap = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0 && Object.values(value).every(version => typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version));
    requireCheck(dependencyMap(row.dependencies), `Missing or unpinned desired dependencies: ${row.name}`);
    requireCheck(dependencyMap(dependencies), `Missing or unpinned package dependencies: ${row.name}`);
    requireCheck(equal(ordered(Object.entries(dependencies)), ordered(Object.entries(row.dependencies))), `Dependency drift: ${row.name}`);
    const sourceHashes = Object.fromEntries(readdirSync(resolve(root, row.source)).filter(name => /\.(js|json)$/.test(name) && name !== 'deployment-config.json' && name !== 'package-lock.json').sort().map(name => [name, createHash('sha256').update(readFileSync(resolve(root, row.source, name))).digest('hex')]));
    return { name: row.name, source: row.source, version: row.version, runtime: row.runtime, memoryMB: row.memoryMB, timeoutSeconds: row.timeoutSeconds, allowedOpenapi: row.allowedOpenapi || [], triggers, dependencies, sourceHashes, cloudVerification: 'pending-not-queried' };
  });
  return {
    mode: 'read-only-local-preflight', valid: true, scope: 'desired-v2.4-wall-cleanup-trade-worker',
    appid: manifest.appid, env: manifest.env, paidEnabled: false,
    onlineStatus: 'not-verified-by-this-script', deployReady: false,
    functions: verifiedFunctions,
    collections: [...desiredCollections.values()].map(row => ({ ...row, cloudVerification: 'pending-not-queried' })),
    checks,
    requiredCloudVerification: [...manifest.onlineVerificationRequired, ...trade.verificationRequired],
    note: 'Local source and desired settings only. This does not prove deployed versions, private permissions, indexes, timers or callback trust. No cloud changes were made.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(preflight(), null, 2));
}
