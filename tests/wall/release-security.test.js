'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, Repo } = require('./forum-fixture');
const { memberId, hash } = require('../../cloudfunctions/xiaopinWall/service');
const { createMediaDelete } = require('../../cloudfunctions/xiaopinReportCleanup/storage-delete');
const { garbageCollectMedia, ORPHAN_GRACE_MS } = require('../../cloudfunctions/xiaopinWall/media-lifecycle');

function evidenceFixture(onSign) {
  let f;
  f = fixture({ storage: { url: async () => { await onSign(f); return 'https://private.invalid/new-link'; } } });
  const mediaId = hash('retained-media-race'), reportId = hash('retained-report-race');
  f.repo.tables.media.set(mediaId, { kind: 'media', ownerId: memberId('author'), status: 'approved', fileId: 'cloud://private/evidence', sha256: 'a'.repeat(64), moderationVersion: 1, bytes: 12, evidenceRefs: { [reportId]: null } });
  f.repo.tables.reports.set(reportId, { kind: 'report', evidenceExpiresAt: f.time() + 1000 });
  f.repo.tables.reportEvidence.set(reportId, { kind: 'reportEvidence', retentionStatus: 'expiring', expiresAt: f.time() + 1000, snapshot: { mediaIds: [mediaId] } });
  return { f, mediaId, reportId };
}

test('evidence deadline crossed during signing cannot return a newly issued image link', async () => {
  const { f, mediaId, reportId } = evidenceFixture(f => f.advance(1000));
  const result = await f.call('getMedia', { mediaId, reportId }, 'admin');
  assert.equal(result.code, 'NOT_FOUND'); assert.equal(result.url, undefined);
});
test('administrator revocation during evidence signing cannot return a new image link', async () => {
  const { f, mediaId, reportId } = evidenceFixture(f => { f.repo.tables.members.get(memberId('admin')).role = 'member'; });
  const result = await f.call('getMedia', { mediaId, reportId }, 'admin');
  assert.equal(result.code, 'NOT_FOUND'); assert.equal(result.url, undefined);
});
test('sealed media replacement during signing rejects the older link', async () => {
  let mediaId;
  const state = evidenceFixture(f => { f.repo.tables.media.get(mediaId).fileId = 'cloud://private/replaced'; });
  ({ mediaId } = state);
  const result = await state.f.call('getMedia', { mediaId, reportId: state.reportId }, 'admin');
  assert.equal(result.code, 'CONFLICT'); assert.equal(result.url, undefined);
});
test('post removed during public image signing rejects the link even with an old page reference', async () => {
  let post;
  const f = fixture({ storage: { url: async () => { f.repo.tables.posts.get(post._id).status = 'deleted'; return 'https://private.invalid/old-public'; } } });
  const mediaId = hash('public-media-race');
  f.repo.tables.media.set(mediaId, { kind: 'media', ownerId: memberId('author'), status: 'approved', fileId: 'cloud://private/public', sha256: 'a'.repeat(64), moderationVersion: 1, bytes: 12 });
  post = f.post(1, { mediaIds: [mediaId] });
  const result = await f.call('getMedia', { mediaId, postId: post._id }, 'other');
  assert.equal(result.code, 'NOT_FOUND'); assert.equal(result.url, undefined);
});

test('media delete adapter accepts already removed files and rejects partial or wrong responses', async () => {
  for (const status of [0, -503003]) {
    await createMediaDelete({ deleteFile: async () => ({ fileList: [{ fileID: 'cloud://private/expected', status }] }) })(['cloud://private/expected']);
  }
  for (const fileList of [[], [{ fileID: 'cloud://private/other', status: 0 }], [{ fileID: 'cloud://private/expected', status: -403003 }]]) {
    await assert.rejects(createMediaDelete({ deleteFile: async () => ({ fileList }) })(['cloud://private/expected']), /incomplete/);
  }
});
test('media cleanup survives deletion success followed by a database commit failure', async () => {
  const repo = new Repo(), at = 1794502000000, mediaId = hash('delete-then-db-failure'), fileId = 'cloud://private/retry';
  repo.tables.media.set(mediaId, { _id: mediaId, kind: 'media', status: 'approved', fileId, createdAt: at - ORPHAN_GRACE_MS, updatedAt: at - ORPHAN_GRACE_MS, postRefs: {}, evidenceRefs: {} });
  let exists = true, attempts = 0, failCommit = true;
  const storage = { delete: createMediaDelete({ deleteFile: async () => { attempts += 1; const status = exists ? 0 : -503003; exists = false; return { fileList: [{ fileID: fileId, status }] }; } }) };
  const transaction = repo.transaction.bind(repo);
  repo.transaction = work => transaction(tx => work({ ...tx, set: async (type, key, row) => { if (type === 'media' && row.status === 'deleted' && failCommit) { failCommit = false; throw Error('isolated commit loss'); } return tx.set(type, key, row); } }));
  assert.equal((await garbageCollectMedia({ repo, storage, at, logger: { error() {} } })).failed, 1);
  assert.equal((await repo.get('media', mediaId)).status, 'deleting');
  assert.equal((await garbageCollectMedia({ repo, storage, at, logger: { error() {} } })).deleted, 1);
  assert.equal((await repo.get('media', mediaId)).status, 'deleted'); assert.equal(attempts, 2);
});
