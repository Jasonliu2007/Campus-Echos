'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../..');
const read = relative => JSON.parse(readFileSync(resolve(root, relative), 'utf8'));
const manifest = () => read('scripts/cloud-setup.json');
const trade = () => read('docs/implementation-v2.4/trade-deploy-manifest.json');
const load = () => import('../../scripts/cloud-setup.mjs');

test('deployment preflight covers every current repository and stays local read-only', async () => {
  const paths = ['scripts/cloud-setup.json', 'docs/implementation-v2.4/trade-deploy-manifest.json', 'config.js'];
  const before = paths.map(path => readFileSync(resolve(root, path), 'utf8'));
  const { preflight } = await load();
  const result = preflight(root);
  assert.equal(result.functions.length, 4);
  assert.equal(result.collections.length, 28);
  assert.deepEqual(result.functions.map(row => row.version), ['wall-20261115-v1.12', 'report-cleanup-20261113-v2.1', 'trade-20261115-v1.2', 'trade-worker-20261113-v1.2']);
  assert.equal(result.deployReady, false);
  assert.equal(result.onlineStatus, 'not-verified-by-this-script');
  assert.ok(result.collections.every(row => row.permissions.read === false && row.permissions.write === false && row.cloudVerification === 'pending-not-queried'));
  assert.ok(result.collections.some(row => row.name === 'xiaopin_comments' && row.indexes.some(index => index.name === 'comments_post_time')));
  assert.equal(result.checks.length, 4);
  assert.deepEqual(paths.map(path => readFileSync(resolve(root, path), 'utf8')), before);
});

test('stale source version cannot be reported as a valid deployment plan', async () => {
  const { preflight } = await load();
  const stale = manifest(); stale.version = 'wall-20261111-v1.3';
  assert.throws(() => preflight(root, { manifest: stale }), /Source version differs/);
});

test('missing private media collection and unsafe direct access both fail preflight', async () => {
  const { preflight } = await load();
  const incomplete = manifest(); incomplete.collections = incomplete.collections.filter(row => row.name !== 'xiaopin_media_callbacks');
  assert.throws(() => preflight(root, { manifest: incomplete }), /Repository collection missing.*xiaopin_media_callbacks/);
  const unsafe = trade(); unsafe.clientStoragePermissions.read = true;
  assert.throws(() => preflight(root, { trade: unsafe }), /deny direct client access/);
});

test('wrong environment and enabled paid path fail before deployment', async () => {
  const { preflight } = await load();
  const wrongEnv = trade(); wrongEnv.env = 'other-environment';
  assert.throws(() => preflight(root, { trade: wrongEnv }), /Cloud environment differs/);
  const paid = trade(); paid.paidEnabled = true;
  assert.throws(() => preflight(root, { trade: paid }), /Paid path must remain disabled/);
});

test('timer or OpenAPI configuration drift cannot pass preflight', async () => {
  const { preflight } = await load();
  const timer = trade(); timer.functions.find(row => row.name === 'xiaopinPdfWorker').triggers[0].config = '0 0 0 * * * *';
  assert.throws(() => preflight(root, { trade: timer }), /Timer trigger drift/);
  const permissions = trade(); permissions.functions.find(row => row.name === 'xiaopinTrade').allowedOpenapi = ['security.msgSecCheck'];
  assert.throws(() => preflight(root, { trade: permissions }), /OpenAPI permission drift/);
});


test('Wall media storage dependency cannot be omitted from the deployment plan', async () => {
  const { preflight } = await load();
  const incomplete = manifest(); delete incomplete.dependencies['@cloudbase/node-sdk'];
  assert.throws(() => preflight(root, { manifest: incomplete }), /Dependency drift: xiaopinWall/);
  const result = preflight(root);
  assert.deepEqual(result.functions.find(row => row.name === 'xiaopinWall').dependencies,
    { 'wx-server-sdk': '3.0.1', '@cloudbase/node-sdk': '2.10.0' });
});

test('Wall and cleanup dependency version drift is rejected before deployment', async () => {
  const { preflight } = await load();
  for (const cleanup of [false, true]) {
    const stale = manifest();
    const dependencies = cleanup ? stale.cleanupFunction.dependencies : stale.dependencies;
    dependencies['wx-server-sdk'] = '2.6.3';
    assert.throws(() => preflight(root, { manifest: stale }),
      cleanup ? /Dependency drift: xiaopinReportCleanup/ : /Dependency drift: xiaopinWall/);
  }
});

test('every deployed function requires an explicit pinned dependency declaration', async () => {
  const { preflight } = await load();
  for (const mode of ['wall', 'cleanup', 'trade', 'worker']) {
    const desired = manifest(); const tradePlan = trade();
    if (mode === 'wall') delete desired.dependencies;
    if (mode === 'cleanup') delete desired.cleanupFunction.dependencies;
    if (mode === 'trade') delete tradePlan.functions.find(row => row.name === 'xiaopinTrade').dependencies;
    if (mode === 'worker') delete tradePlan.functions.find(row => row.name === 'xiaopinPdfWorker').dependencies;
    assert.throws(() => preflight(root, { manifest: desired, trade: tradePlan }), /Missing or unpinned desired dependencies/);
  }
  const unpinned = manifest(); unpinned.dependencies['@cloudbase/node-sdk'] = '^2.10.0';
  assert.throws(() => preflight(root, { manifest: unpinned }), /Missing or unpinned desired dependencies: xiaopinWall/);
});
