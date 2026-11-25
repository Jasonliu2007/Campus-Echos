'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorage } = require('../../cloudfunctions/xiaopinTrade/private-storage');

test('private object ID is reserved before upload and unexpected final IDs fail closed', async () => {
  const deleted = [];
  const cloud = { uploadFile: async () => ({ fileID: 'cloud://unexpected' }), deleteFile: async ({ fileList }) => { deleted.push(...fileList); return { fileList: [{ status: 0 }] }; } };
  const storage = createStorage({ cloud, metadata: async () => ({ data: { fileId: 'cloud://expected', token: 'never-forward' } }) });
  assert.equal(await storage.reserve('private/path'), 'cloud://expected');
  await assert.rejects(storage.put('private/path', Buffer.from('private'), 'cloud://expected'), /PRIVATE_RESERVATION_MISMATCH/);
  assert.deepEqual(deleted, ['cloud://unexpected']);
  await assert.rejects(storage.put('private/path', Buffer.from('private')), /PRIVATE_RESERVATION_REQUIRED/);
});
test('reservation errors prevent upload and missing objects are successful delete retries', async () => {
  const cloud = { deleteFile: async () => ({ fileList: [{ status: -503003 }] }) };
  const storage = createStorage({ cloud, metadata: async () => ({ code: 'DENIED', data: { fileId: 'cloud://forged' } }) });
  await assert.rejects(storage.reserve('private/path'), /PRIVATE_RESERVATION_FAILED/);
  await storage.remove('cloud://already-gone');
});
