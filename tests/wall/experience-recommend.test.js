'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./forum-fixture');
const { memberId } = require('../../cloudfunctions/xiaopinWall/service');
const data = post => ({ postId: post._id, revision: post.revision, recommended: true, confirmed: true });

test('only current admins can recommend a published safe experience, with auditable explicit state', async () => {
  const f = fixture(), p = f.post(1, { community: 'experience', moderation: 'pass' });
  assert.equal((await f.call('setExperienceRecommendation', data(p))).code, 'FORBIDDEN');
  assert.equal((await f.call('setExperienceRecommendation', { ...data(p), confirmed: false }, 'admin')).code, 'CONFIRM_REQUIRED');
  const r = await f.call('setExperienceRecommendation', data(p), 'admin');
  assert.equal(r.post.recommended, true); assert.equal(r.post.revision, 2);
  const retry = await f.call('setExperienceRecommendation', data(p), 'admin'); assert.equal(retry.unchanged, true); assert.equal(retry.post.revision, 2);
  const audits = [...f.repo.tables.audit.values()]; assert.equal(audits.length, 1); assert.equal(audits[0].action, 'setExperienceRecommendation');
  assert.equal(JSON.stringify(r).includes(memberId('author')), false);
  assert.equal((await f.call('getPost', { postId: p._id }, 'other')).post.canRecommend, false);
});

test('pending hidden unsafe and forum content cannot be recommended', async () => {
  const f = fixture();
  for (const patch of [{ status: 'pending' }, { status: 'hidden' }, { moderation: 'review' }, { moderation: 'risky' }]) {
    const p = f.post(Math.random(), { community: 'experience', moderation: 'pass', ...patch });
    assert.equal((await f.call('setExperienceRecommendation', data(p), 'admin')).code, 'POST_UNAVAILABLE');
  }
  const forum = f.post(2, { moderation: 'pass' });
  assert.equal((await f.call('setExperienceRecommendation', data(forum), 'admin')).code, 'NOT_FOUND');
});

test('recommendation rechecks admin inside transaction and rolls back on audit failure', async () => {
  const f = fixture(), p = f.post(1, { community: 'experience', moderation: 'pass' });
  const transaction = f.repo.transaction.bind(f.repo); f.repo.transaction = work => { f.repo.tables.members.get(memberId('admin')).role = 'member'; return transaction(work); };
  assert.equal((await f.call('setExperienceRecommendation', data(p), 'admin')).code, 'FORBIDDEN');
  assert.equal((await f.repo.get('posts', p._id)).recommended, undefined);
  f.repo.transaction = transaction; f.repo.tables.members.get(memberId('admin')).role = 'admin'; f.repo.failType = 'audit';
  assert.equal((await f.call('setExperienceRecommendation', data(p), 'admin')).code, 'SERVICE_UNAVAILABLE');
  assert.equal((await f.repo.get('posts', p._id)).recommended, undefined);
});

test('recommended feed is community isolated and binds pagination to filter', async () => {
  const f = fixture();
  for (let n = 0; n < 25; n++) f.post(n, { community: 'experience', moderation: 'pass', recommended: true });
  f.post(30, { community: 'experience', moderation: 'pass', recommended: false }); f.post(31, { recommended: true, moderation: 'pass' });
  const first = await f.call('list', { community: 'experience', recommendedOnly: true }); assert.equal(first.posts.length, 20);
  const second = await f.call('list', { community: 'experience', recommendedOnly: true, cursor: first.nextCursor }); assert.equal(second.posts.length, 5);
  assert.equal(new Set(first.posts.concat(second.posts).map(x => x._id)).size, 25);
  assert.equal((await f.call('list', { community: 'experience', cursor: first.nextCursor })).code, 'INVALID_CURSOR');
  assert.equal((await f.call('list', { recommendedOnly: true })).code, 'INVALID_INPUT');
});

test('stale recommendation cannot overwrite another admin and cancelling is explicit and idempotent', async () => {
  const f = fixture(), p = f.post(1, { community: 'experience', moderation: 'pass' });
  await f.call('setExperienceRecommendation', data(p), 'admin');
  assert.equal((await f.call('setExperienceRecommendation', { ...data(p), recommended: false }, 'admin')).code, 'CONFLICT');
  const r = await f.call('setExperienceRecommendation', { ...data(p), revision: 2, recommended: false }, 'admin'); assert.equal(r.post.recommended, false);
  const same = await f.call('setExperienceRecommendation', { ...data(p), revision: 3, recommended: false }, 'admin'); assert.equal(same.unchanged, true); assert.equal(same.post.revision, 3);
});

test('editing a recommended article cancels old recommendation and keeps original publication time', async () => {
  const f = fixture(), p = f.post(1, { community: 'experience', moderation: 'pass', recommended: true });
  const edited = await f.call('editPost', { postId: p._id, revision: 1, requestId: 'experience-edit-1', category: '校园生活墙', title: '新版经验', content: '新的亲身经历分享' });
  assert.equal(edited.ok, true); assert.equal((await f.repo.get('posts', p._id)).recommended, false);
  assert.equal((await f.repo.get('posts', p._id)).createdAt, p.createdAt);
});
