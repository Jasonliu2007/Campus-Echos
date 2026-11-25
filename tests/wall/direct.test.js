'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./forum-fixture');

test('private request is visible only to its participants and opens after consent', async () => {
  const { call, post } = fixture();
  const target = { postId: post()._id };
  const draft = { ...target, requestId: 'direct-request-1', content: '你好' };
  const sent = await call('directSend', draft, 'other');
  assert.equal(sent.ok, true);
  assert.equal((await call('directSend', draft, 'other')).id, sent.id);
  const ref = { threadId: sent.threadId };
  assert.equal((await call('directOpen', ref, 'admin')).code, 'NOT_FOUND');
  assert.equal((await call('directList', {}, 'author')).threads[0].status, 'pending');
  assert.equal((await call('directSend', { ...ref, requestId: 'direct-request-2', content: '第二条' }, 'other')).code, 'ACCESS_DENIED');
  assert.equal((await call('directRespond', { ...ref, status: 'accepted' }, 'other')).code, 'FORBIDDEN');
  assert.equal((await call('directRespond', { ...ref, status: 'accepted' }, 'author')).code, 'FORBIDDEN');
  assert.equal((await call('directSend', { ...ref, requestId: 'direct-request-3', content: '你好同学' }, 'author')).ok, true);
  assert.equal((await call('directOpen', ref, 'other')).thread.status, 'accepted');
  assert.equal((await call('directOpen', ref, 'other')).messages.length, 2);
  assert.equal((await call('directRespond', { ...ref, status: 'blocked' }, 'other')).status, 'blocked');
  assert.equal((await call('directOpen', ref, 'author')).code, 'ACCESS_DENIED');
});

test('anonymous posts cannot be used to resolve a private-message recipient', async () => {
  const { call, post } = fixture();
  const row = post(5, { isAnonymous: true });
  assert.equal((await call('directOpen', { postId: row._id }, 'other')).code, 'NOT_FOUND');
});

test('私信图片须通过审核，仅参与者可查看，同一张图片只能发一次', async () => {
  const { memberId, hash } = require('../../cloudfunctions/xiaopinWall/service');
  const { call, post, repo } = fixture({ storage: { url: async () => 'https://example.invalid/private' } });
  const target = { postId: post()._id };
  const opened = await call('directOpen', target, 'other');
  const threadId = opened.thread.id;
  const attachmentId = hash('private-picture');
  const asset = { kind: 'directMedia', ownerId: memberId('other'), directThreadId: threadId, status: 'checking',
    fileId: 'cloud://private', traceId: 'trace', sha256: 'hash', moderationVersion: 1, bytes: 500000 };
  repo.tables.media.set(attachmentId, asset);
  const first = { ...target, attachmentId, content: '', requestId: 'direct-attachment-1' };
  assert.equal((await call('directSend', first, 'other')).code, 'MEDIA_NOT_APPROVED');
  repo.tables.media.set(attachmentId, { ...asset, status: 'approved', bytes: 500001 });
  assert.equal((await call('directSend', first, 'other')).code, 'MEDIA_NOT_APPROVED');
  repo.tables.media.set(attachmentId, { ...asset, status: 'approved' });
  const sent = await call('directSend', first, 'other');
  assert.equal(sent.ok, true);
  assert.equal((await call('directSend', first, 'other')).id, sent.id);
  const download = { threadId, messageId: sent.id };
  assert.equal((await call('directAttachment', download, 'admin')).code, 'NOT_FOUND');
  assert.equal((await call('getMedia', { mediaId: attachmentId }, 'other')).url, undefined);
  assert.equal((await call('directAttachment', download, 'author')).url, 'https://example.invalid/private');
  const openedByAuthor = await call('directOpen', { threadId }, 'author');
  assert.equal(openedByAuthor.messages[0].hasAttachment, true);
  assert.equal(openedByAuthor.messages[0].attachmentId, undefined);
  await call('directSend', { threadId, content: '收到', requestId: 'direct-attachment-reply' }, 'author');
  assert.equal((await call('directSend', { ...first, requestId: 'direct-attachment-2' }, 'other')).code, 'MEDIA_NOT_APPROVED');
  const linked = await repo.get('media', attachmentId);
  repo.tables.media.set(attachmentId, { ...linked, status: 'rejected' });
  assert.equal((await call('directAttachment', download, 'author')).code, 'NOT_FOUND');
});

test('按用户名查找只返回可联系成员，资料和订单报价使用同一个会话', async () => {
  const { memberId, hash } = require('../../cloudfunctions/xiaopinWall/service');
  const { call, repo } = fixture();
  const found = await call('directFindMember', { nickname: '真实昵称-author' }, 'other');
  assert.deepEqual(found.users, [{ id: memberId('author'), name: '真实昵称-author' }]);
  const materialId = hash('material'), orderId = hash('order');
  repo.tables.materials.set(materialId, { _id: materialId, kind: 'material', sellerId: memberId('author'), status: 'published', title: '课程笔记' });
  repo.tables.orders.set(orderId, { _id: orderId, kind: 'order', buyerId: memberId('other'), sellerId: memberId('author'), materialId, title: '课程笔记' });
  const fromName = await call('directOpen', { peerId: found.users[0].id }, 'other');
  const fromMaterial = await call('directOpen', { materialId }, 'other');
  assert.equal(fromMaterial.thread.id, fromName.thread.id);
  assert.equal((await call('directOpen', { orderId }, 'admin')).code, 'NOT_FOUND');
  const sent = await call('directSend', { materialId, quoteCents: 500, requestId: 'material-quote-first' }, 'other');
  assert.equal(sent.ok, true);
  const threadId = sent.threadId;
  assert.equal((await call('directSend', { threadId, content: '再发一次', requestId: 'direct-same-source' }, 'other')).code, 'ACCESS_DENIED');
  assert.equal((await call('directSend', { threadId, materialId, quoteCents: 600, requestId: 'direct-seller-quote' }, 'author')).ok, true);
  const fromOrder = await call('directOpen', { orderId }, 'other');
  assert.equal(fromOrder.thread.id, threadId);
  assert.equal(fromOrder.thread.status, 'accepted');
  assert.deepEqual(fromOrder.messages.map(m => m.quote.cents).sort(), [500, 600]);
});
