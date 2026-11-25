'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMediaService } = require('../../cloudfunctions/xiaopinWall/media');
const { garbageCollectMedia, ORPHAN_GRACE_MS } = require('../../cloudfunctions/xiaopinWall/media-lifecycle');
const { createStorage } = require('../../cloudfunctions/xiaopinWall/private-storage');
const { Repo } = require('./forum-fixture');
const { memberId, hash } = require('../../cloudfunctions/xiaopinWall/service');
const IMAGE = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]).toString('base64');
const event = { requestId: 'media-reservation-1', base64: IMAGE };
const at = 1794502000000;
function setup(overrides = {}) {
  const repo = new Repo(), ownId = memberId('author'); let clock = at, sequence = 0;
  repo.tables.members.set(ownId, { kind: 'member', status: 'approved' });
  const fail = (code, message) => { const e = Error(message); e.code = code; throw e; };
  const storage = {
    reserve: async () => 'cloud://reserved/' + (++sequence),
    put: async (_path, _bytes, fileId) => fileId,
    url: async () => 'https://temporary.example/image',
    ...overrides,
  };
  const service = createMediaService({ repo, now: () => clock, hash, id: value => value, approved: value => value, fail, storage, mediaCheck: async () => ({ traceId: 'trace-' + sequence }), logger: { error() {} } });
  return { repo, service, storage, ownId, mediaId: hash(`${ownId}:media:${event.requestId}`), advance: n => { clock += n; }, now: () => clock };
}

test('provider ID is committed before upload; hard interruption retains it for physical cleanup', async () => {
  let entered; const uploading = new Promise(resolve => { entered = resolve; });
  const f = setup({ put: async (_path, _bytes, fileId) => {
    const row = await f.repo.get('media', f.mediaId);
    assert.deepEqual(row.stagedFileIds, [fileId]); assert.equal(row.fileId, undefined);
    entered(); return new Promise(() => {}); // Isolated simulation of an invocation killed during provider upload.
  } });
  void f.service.uploadMedia(event, 'author', f.ownId);
  await uploading;
  const removed = [];
  const before = await garbageCollectMedia({ repo: f.repo, at: at + ORPHAN_GRACE_MS - 1, storage: { delete: async ids => removed.push(...ids) } });
  assert.equal(before.deleted, 0);
  const result = await garbageCollectMedia({ repo: f.repo, at: at + ORPHAN_GRACE_MS, storage: { delete: async ids => removed.push(...ids) } });
  assert.equal(result.deleted, 1); assert.deepEqual(removed, ['cloud://reserved/1']);
  assert.equal((await f.repo.get('media', f.mediaId)).status, 'deleted');
});

test('failed reservation database write prevents upload bytes', async () => {
  let puts = 0;
  const f = setup({ reserve: async () => { f.repo.failType = 'media'; return 'cloud://reserved/blocked'; }, put: async () => { puts += 1; } });
  await assert.rejects(f.service.uploadMedia(event, 'author', f.ownId));
  assert.equal(puts, 0);
});

test('expired attempt retry keeps its pre-upload ID and cannot orphan the old attempt', async () => {
  let entered; const uploading = new Promise(resolve => { entered = resolve; });
  let puts = 0;
  const f = setup({ put: async (_path, _bytes, fileId) => { puts += 1; if (puts === 1) { entered(); return new Promise(() => {}); } return fileId; } });
  void f.service.uploadMedia(event, 'author', f.ownId); await uploading;
  f.advance(120001);
  const retried = await f.service.uploadMedia(event, 'author', f.ownId);
  assert.equal(retried.status, 'checking');
  const row = await f.repo.get('media', f.mediaId);
  assert.equal(row.fileId, 'cloud://reserved/2'); assert.deepEqual(row.retiredFileIds, ['cloud://reserved/1']); assert.deepEqual(row.stagedFileIds, []);
  const removed = [];
  await garbageCollectMedia({ repo: f.repo, at: f.now() + ORPHAN_GRACE_MS, storage: { delete: async ids => removed.push(...ids) } });
  assert.deepEqual(new Set(removed), new Set(['cloud://reserved/1', 'cloud://reserved/2']));
});

test('failure after bytes are written leaves the reserved ID recoverable and does not claim review', async () => {
  const f = setup({ put: async () => { throw Error('upload response lost'); } });
  await assert.rejects(f.service.uploadMedia(event, 'author', f.ownId), e => e.code === 'MEDIA_UNAVAILABLE');
  const row = await f.repo.get('media', f.mediaId);
  assert.equal(row.status, 'failed'); assert.equal(row.fileId, undefined); assert.deepEqual(row.stagedFileIds, ['cloud://reserved/1']);
  const removed = [];
  await garbageCollectMedia({ repo: f.repo, at: at + ORPHAN_GRACE_MS, storage: { delete: async ids => removed.push(...ids) } });
  assert.deepEqual(removed, ['cloud://reserved/1']);
});

test('forum provider adapter requires a valid reservation and rejects unexpected final IDs', async () => {
  let puts = 0; const removed = [];
  const storage = createStorage({ cloud: { uploadFile: async () => { puts += 1; return { fileID: 'cloud://unexpected' }; }, deleteFile: async ({ fileList }) => { removed.push(...fileList); return { fileList: [{ status: 0 }] }; } }, metadata: async () => ({ data: { fileId: 'cloud://expected', token: 'private-never-return' } }) });
  assert.equal(await storage.reserve('forum-private/sealed/test'), 'cloud://expected');
  await assert.rejects(storage.put('forum-private/sealed/test', Buffer.from('x')), /PRIVATE_RESERVATION_REQUIRED/); assert.equal(puts, 0);
  await assert.rejects(storage.put('forum-private/sealed/test', Buffer.from('x'), 'cloud://expected'), /PRIVATE_RESERVATION_MISMATCH/);
  assert.deepEqual(removed, ['cloud://unexpected']);
});

test('retired failed upload IDs are physically removed while the successful current image remains referenced', async () => {
  const f = setup();
  await f.service.uploadMedia(event, 'author', f.ownId);
  const row = f.repo.tables.media.get(f.mediaId);
  row.status = 'approved'; row.retiredFileIds = ['cloud://retired/old']; row.retiredFileAt = { [hash('cloud://retired/old')]: at };
  row.postRefs = { [hash('public-post')]: true };
  f.repo.tables.posts.set(hash('public-post'), { _id: hash('public-post'), kind: 'post', status: 'published', mediaIds: [f.mediaId], createdAt: at });
  const removed = [];
  const result = await garbageCollectMedia({ repo: f.repo, at: at + ORPHAN_GRACE_MS, storage: { delete: async ids => removed.push(...ids) } });
  assert.equal(result.retiredDeleted, 1); assert.equal(result.deleted, 0); assert.deepEqual(removed, ['cloud://retired/old']);
  const saved = await f.repo.get('media', f.mediaId);
  assert.equal(saved.fileId, 'cloud://reserved/1'); assert.equal(saved.status, 'approved'); assert.deepEqual(saved.retiredFileIds, []);
});

test('retired-file cleanup failure keeps the IDs and safely resumes without deleting current bytes', async () => {
  const f = setup(); await f.service.uploadMedia(event, 'author', f.ownId);
  const row = f.repo.tables.media.get(f.mediaId);
  row.retiredFileIds = ['cloud://retired/retry']; row.retiredFileAt = { [hash('cloud://retired/retry')]: at }; row.postRefs = { retained: true };
  const first = await garbageCollectMedia({ repo: f.repo, at: at + ORPHAN_GRACE_MS, storage: { delete: async () => { throw Error('offline'); } }, logger: { error() {} } });
  assert.equal(first.failed, 1); assert.deepEqual((await f.repo.get('media', f.mediaId)).retiredFileIds, ['cloud://retired/retry']);
  const removed = [];
  const next = await garbageCollectMedia({ repo: f.repo, at: at + ORPHAN_GRACE_MS, storage: { delete: async ids => removed.push(...ids) } });
  assert.equal(next.retiredDeleted, 1); assert.deepEqual(removed, ['cloud://retired/retry']); assert.equal((await f.repo.get('media', f.mediaId)).fileId, 'cloud://reserved/1');
});
