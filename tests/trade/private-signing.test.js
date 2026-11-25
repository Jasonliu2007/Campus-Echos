'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');
const { memberId, key, TERMS_VERSION, VERSION } = require('../../cloudfunctions/xiaopinTrade/service');
function duringSign(f, change) { const original = f.storage.sign; f.storage.sign = async (...args) => { const url = await original(...args); await change(); return url; }; }
async function proofFixture() {
  const f = fixture(), { materialId } = f.published(); await f.adult();
  const created = await f.call('createOrder', { materialId, requestId: 'private-proof-order-01' });
  const orderId = created.order._id, proofId = key('private-proof');
  f.files.set('cloud://proof', Buffer.from('private evidence'));
  f.repo.tables.evidence.set(proofId, { _id: proofId, kind: 'paymentProof', orderId, fileId: 'cloud://proof', transferReference: '私有编号', note: '私有说明', createdAt: f.now() });
  f.repo.tables.orders.get(orderId).proofEvidenceId = proofId;
  return { f, orderId, proofId };
}
for (const [field, value, code] of [['role', 'member', 'FORBIDDEN'], ['status', 'revoked', 'ACCESS_DENIED']]) {
  test(`full PDF inspection blocks an administrator whose ${field} changes during signing`, async () => {
    const f = fixture(), { versionId } = f.published();
    duringSign(f, () => { f.repo.tables.members.get(memberId('admin'))[field] = value; });
    const result = await f.call('getPrivatePdf', { versionId }, 'admin');
    assert.equal(result.code, code); assert.equal(result.url, undefined);
  });
  test(`payment proof does not leak URL or private text after administrator ${field} changes`, async () => {
    const { f, orderId } = await proofFixture();
    duringSign(f, () => { f.repo.tables.members.get(memberId('admin'))[field] = value; });
    const result = await f.call('getPaymentProof', { orderId }, 'admin');
    assert.equal(result.code, 'NOT_FOUND');
    for (const name of ['url', 'note', 'transferReference']) assert.equal(result[name], undefined);
  });
}
test('full PDF inspection blocks a seller revoked during signing', async () => {
  const f = fixture(), { versionId } = f.published();
  duringSign(f, () => { f.repo.tables.members.get(memberId('seller')).status = 'revoked'; });
  const result = await f.call('getPrivatePdf', { versionId }, 'seller');
  assert.equal(result.code, 'ACCESS_DENIED'); assert.equal(result.url, undefined);
});
test('full PDF inspection cannot return a source cleared during signing', async () => {
  const f = fixture(), { versionId } = f.published();
  duringSign(f, () => { f.repo.tables.versions.get(versionId).sourceFileId = null; });
  const result = await f.call('getPrivatePdf', { versionId }, 'seller');
  assert.equal(result.code, 'FILE_UNAVAILABLE'); assert.equal(result.url, undefined);
});
test('proof signing rechecks the current evidence record after cleanup', async () => {
  const { f, orderId, proofId } = await proofFixture();
  duringSign(f, () => { Object.assign(f.repo.tables.evidence.get(proofId), { clearedAt: f.now(), fileId: null, note: '' }); });
  const result = await f.call('getPaymentProof', { orderId });
  assert.equal(result.code, 'CONFLICT'); assert.equal(result.url, undefined); assert.equal(result.note, undefined);
});
test('existing buyer keeps proof and QR access when community qualification is revoked during signing', async () => {
  const { f, orderId } = await proofFixture();
  Object.assign(f.repo.tables.orders.get(orderId), { status: 'awaitingSeller', paymentQr: { fileId: 'cloud://qr' } });
  f.files.set('cloud://qr', Buffer.from('private qr'));
  duringSign(f, () => { f.repo.tables.members.get(memberId('buyer')).status = 'revoked'; });
  assert.equal((await f.call('getPaymentProof', { orderId })).ok, true);
  assert.equal((await f.call('getPaymentQr', { orderId })).ok, true);
});
test('QR and proof do not use a removed member record after signing', async () => {
  for (const action of ['getPaymentQr', 'getPaymentProof']) {
    const { f, orderId } = await proofFixture();
    Object.assign(f.repo.tables.orders.get(orderId), { status: 'awaitingSeller', paymentQr: { fileId: 'cloud://qr' } });
    f.files.set('cloud://qr', Buffer.from('private qr'));
    duringSign(f, () => { f.repo.tables.members.delete(memberId('buyer')); });
    const result = await f.call(action, { orderId });
    assert.equal(result.code, 'ACCESS_DENIED'); assert.equal(result.url, undefined);
  }
});
test('service patch preserves existing age confirmation and terms version', async () => {
  const f = fixture(); await f.adult();
  const session = await f.call('session');
  assert.equal(TERMS_VERSION, 'trade-20261113-v1'); assert.notEqual(VERSION, TERMS_VERSION);
  assert.equal(session.adultConfirmed, true); assert.equal(session.termsVersion, TERMS_VERSION);
  assert.equal((await f.repo.get('profiles', memberId('buyer'))).termsVersion, TERMS_VERSION);
  const { materialId } = f.published();
  assert.equal((await f.call('createOrder', { materialId, requestId: 'stable-terms-order-01' })).ok, true);
});
