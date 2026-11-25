'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers');
const { APPID, memberId, key, LIMITS, HOUR, DAY, hash } = require('../../cloudfunctions/xiaopinTrade/service');

test('trusted identity, age declaration and paid switch cannot be forged', async () => {
  const f = fixture(); const { materialId } = f.published(100);
  assert.equal((await f.service({ action: 'session', OPENID: 'admin' }, { APPID })).code, 'UNAUTHENTICATED');
  assert.equal((await f.call('createOrder', { materialId, requestId: 'test-order-0001', adultConfirmed: true, role: 'admin' })).code, 'ADULT_CONFIRMATION_REQUIRED');
  await f.adult();
  assert.equal((await f.call('createOrder', { materialId, requestId: 'test-order-0001', paidEnabled: true })).code, 'PAID_DISABLED');
  assert.equal((await f.call('session')).paidEnabled, false);
  assert.equal(f.repo.tables.orders.size, 0);
});
test('new business is denied on revocation or ban while existing order access survives', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult();
  const result = await f.call('createOrder', { materialId, requestId: 'test-order-0001' }); assert.equal(result.ok, true);
  f.repo.tables.members.get(memberId('buyer')).banned = true;
  assert.equal((await f.call('createOrder', { materialId, requestId: 'test-order-0002' })).code, 'COMMUNITY_BANNED');
  f.repo.tables.members.get(memberId('buyer')).status = 'revoked';
  assert.equal((await f.call('getOrder', { orderId: result.order._id })).ok, true);
  assert.equal((await f.call('getOrder', { orderId: result.order._id }, 'stranger')).code, 'NOT_FOUND');
});
test('same request and concurrent orders create one version entitlement and one watermark job', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult();
  const results = await Promise.all(Array.from({ length: 6 }, () => f.call('createOrder', { materialId, requestId: 'same-order-0001' })));
  assert.equal(results.every(r => r.ok), true); assert.equal(new Set(results.map(r => r.order._id)).size, 1);
  assert.equal(f.repo.tables.orders.size, 1); assert.equal(f.repo.tables.entitlements.size, 1); assert.equal([...f.repo.tables.jobs.values()].filter(r => r.type === 'watermark').length, 1);
  const again = await f.call('createOrder', { materialId, requestId: 'other-order-0002' });
  assert.equal(again.alreadyOwned, true); assert.equal(f.repo.tables.orders.size, 1);
});
test('concurrent different free-order keys return existing entitlement without a second order', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult();
  const results = await Promise.all(['first-request-001', 'second-request-02'].map(requestId => f.call('createOrder', { materialId, requestId })));
  assert.equal(results.every(r => r.ok), true); assert.equal(results.filter(r => r.alreadyOwned).length, 1); assert.equal(f.repo.tables.orders.size, 1);
});
test('draft text moderation fails closed and retry is idempotent with retained payload', async () => {
  const f = fixture(); await f.adult('seller');
  const data = { requestId: 'draft-request-001', title: '课程笔记', course: '数学', description: '章节整理', type: '课程笔记', learningModes: ['系统复习'], priceCents: 0 };
  for (const verdict of ['risky', 'review', 'unknown', 'exception']) { f.verdict(verdict); assert.equal((await f.call('saveMaterialDraft', data, 'seller')).ok, false); assert.equal(f.repo.tables.materials.size, 0); }
  f.verdict('pass'); const first = await f.call('saveMaterialDraft', data, 'seller'); assert.equal(first.ok, true);
  assert.equal((await f.call('saveMaterialDraft', data, 'seller')).material.revision, 1);
  assert.equal((await f.call('saveMaterialDraft', { ...data, description: '改了内容' }, 'seller')).code, 'REQUEST_CONFLICT');
});
test('upload chunks bind bytes and immutable seal; spoofed file IDs and partial uploads fail', async () => {
  const f = fixture(); await f.adult('seller');
  const saved = await f.call('saveMaterialDraft', { requestId: 'draft-request-001', title: '数学笔记', course: '微积分', description: '完整章节整理', type: '课程笔记', learningModes: ['系统复习'], priceCents: 0 }, 'seller');
  const bytes = Buffer.from('%PDF-1.7\nisolated');
  const started = await f.call('startPdfUpload', { materialId: saved.material._id, requestId: 'upload-request-01', name: '学习.pdf', size: bytes.length }, 'seller');
  assert.equal(started.ok, true);
  assert.equal((await f.call('finalizePdfUpload', { uploadId: started.uploadId }, 'seller')).code, 'UPLOAD_INCOMPLETE');
  assert.equal((await f.call('uploadPdfChunk', { uploadId: started.uploadId, index: 0, base64: bytes.toString('base64'), fileId: 'cloud://forged' }, 'stranger')).code, 'ADULT_CONFIRMATION_REQUIRED');
  const chunk = await f.call('uploadPdfChunk', { uploadId: started.uploadId, index: 0, base64: bytes.toString('base64') }, 'seller'); assert.equal(chunk.ok, true);
  assert.equal((await f.call('uploadPdfChunk', { uploadId: started.uploadId, index: 0, base64: Buffer.from('%PDF-1.7\nchanged!').toString('base64') }, 'seller')).code, 'REQUEST_CONFLICT');
  const sealed = await f.call('finalizePdfUpload', { uploadId: started.uploadId }, 'seller'); assert.equal(sealed.status, 'queued');
  assert.equal((await f.call('uploadPdfChunk', { uploadId: started.uploadId, index: 0, base64: bytes.toString('base64') }, 'seller')).code, 'CONFLICT');
  assert.equal(JSON.stringify(sealed).includes('cloud://'), false);
});
test('PDF type size and age rejection cannot allocate upload sessions', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult('seller');
  for (const data of [{ name: 'bad.exe', size: 30 }, { name: 'a.pdf', size: LIMITS.pdfBytes + 1 }, { name: 'a.pdf', size: 0 }]) assert.equal((await f.call('startPdfUpload', { materialId, requestId: 'upload-request-001', ...data }, 'seller')).code, 'INVALID_INPUT');
  assert.equal(f.repo.tables.uploads.size, 0);
});
test('ordinary material details omit source, identities and private pending versions', async () => {
  const f = fixture(); const { materialId } = f.published(); const result = await f.call('getMaterial', { materialId, learningMode: '系统复习' });
  assert.equal(result.ok, true); assert.equal(result.matching.matched, true); assert.equal(result.matching.source.includes('非AI'), true);
  for (const term of ['cloud://', 'sellerId', 'sourceFileId', 'sourceHash', 'pendingVersionId']) assert.equal(JSON.stringify(result).includes(term), false);
  assert.equal((await f.call('getPrivatePdf', { versionId: key('version') })).code, 'FORBIDDEN');
  const preview = await f.call('previewMaterial', { materialId }); assert.equal(preview.ok, true); assert.deepEqual(preview.pageNumbers, [1]); assert.equal(f.signed[0].age, 600);
});
test('public materials use twenty stable rows and scope-bound cursors', async () => {
  const f = fixture(); const { material } = f.published(); f.repo.tables.materials.clear();
  for (let i = 0; i < 43; i += 1) { const _id = key(`row-${i}`); f.repo.tables.materials.set(_id, { ...material, _id, createdAt: 1000 }); }
  const a = await f.call('listMaterials'), b = await f.call('listMaterials', { cursor: a.nextCursor }), c = await f.call('listMaterials', { cursor: b.nextCursor });
  assert.deepEqual([a.items.length, b.items.length, c.items.length], [20, 20, 3]);
  assert.equal(new Set([...a.items, ...b.items, ...c.items].map(r => r._id)).size, 43);
  assert.equal((await f.call('listMyMaterials', { cursor: a.nextCursor }, 'seller')).code, 'INVALID_CURSOR');
});
test('order source version and price stay locked after material changes', async () => {
  const f = fixture(); const { materialId, versionId } = f.published(); await f.adult(); await f.adult('seller');
  const result = await f.call('createOrder', { materialId, requestId: 'free-order-0001' });
  await f.call('setMaterialPrice', { materialId, revision: 1, priceCents: 99999 }, 'seller');
  const material = f.repo.tables.materials.get(materialId); material.currentVersionId = key('other-version');
  const order = await f.call('getOrder', { orderId: result.order._id });
  assert.equal(order.order.priceCents, 0); assert.equal(order.order.versionId, versionId);
});
test('failed watermark never starts claim window; other buyers cannot claim', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult();
  const created = await f.call('createOrder', { materialId, requestId: 'free-order-0001' }), orderId = created.order._id;
  assert.equal((await f.call('claimOrder', { orderId, termsAccepted: true })).code, 'DELIVERY_PROCESSING');
  assert.equal((await f.repo.get('orders', orderId)).firstClaimAt, undefined);
  const order = f.repo.tables.orders.get(orderId); order.deliveryStatus = 'failed';
  assert.equal((await f.call('claimOrder', { orderId, termsAccepted: true })).code, 'DELIVERY_FAILED');
  assert.equal((await f.call('claimOrder', { orderId, termsAccepted: true }, 'stranger')).code, 'NOT_FOUND');
});
test('successful personal copy allows repeat short signing without extending first claim', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult();
  const created = await f.call('createOrder', { materialId, requestId: 'free-order-0001' }), orderId = created.order._id;
  const order = f.repo.tables.orders.get(orderId); order.deliveryStatus = 'ready'; order.watermarkedFileId = 'cloud://copy'; order.watermarkSourceHash = order.sourceHash; f.files.set('cloud://copy', Buffer.from('watermarked'));
  const a = await f.call('claimOrder', { orderId, termsAccepted: true }); assert.equal(a.ok, true); assert.equal(a.downloadConfirmed, false);
  f.advance(DAY); const b = await f.call('claimOrder', { orderId, termsAccepted: true }); assert.equal(b.ok, true); assert.equal(b.order.firstClaimAt, a.order.firstClaimAt); assert.equal(b.expiresAt - f.now(), 600000);
  const material = f.repo.tables.materials.get(materialId); material.status = 'offline'; assert.equal((await f.call('claimOrder', { orderId, termsAccepted: true })).ok, true);
  f.repo.tables.materials.get(materialId).status = 'held'; assert.equal((await f.call('claimOrder', { orderId, termsAccepted: true })).code, 'DELIVERY_HELD');
});
test('private-link issuance failure does not start seven-day completion clock', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult();
  const created = await f.call('createOrder', { materialId, requestId: 'free-order-0001' }), row = f.repo.tables.orders.get(created.order._id);
  row.deliveryStatus = 'ready'; row.watermarkedFileId = 'cloud://missing-copy'; row.watermarkSourceHash = row.sourceHash;
  const result = await f.call('claimOrder', { orderId: row._id, termsAccepted: true }); assert.equal(result.code, 'FILE_UNAVAILABLE'); assert.equal((await f.repo.get('orders', row._id)).firstClaimAt, undefined);
});
test('seller confirmation cannot be performed by administrator or untrusted buyer fields', async () => {
  const f = fixture({ paidEnabled: true }); const { materialId } = f.published(100); await f.adult(); await f.adult('seller');
  const assetId = key('qr'); f.files.set('cloud://qr', Buffer.from('qr')); f.repo.tables.assets.set(assetId, { _id: assetId, ownerId: memberId('seller'), purpose: 'paymentQr', status: 'ready', fileId: 'cloud://qr', sha256: 'locked' });
  f.repo.tables.profiles.get(memberId('seller')).paymentQrAssetId = assetId;
  const created = await f.call('createOrder', { materialId, requestId: 'paid-order-0001' }); assert.equal(created.ok, true);
  const orderId = created.order._id, row = f.repo.tables.orders.get(orderId); row.status = 'awaitingSeller'; row.submittedAt = f.now();
  assert.equal((await f.call('getPaymentQr', { orderId }, 'seller')).code, 'FORBIDDEN');
  assert.equal((await f.call('getPaymentQr', { orderId }, 'admin')).code, 'NOT_FOUND');
  const data = { orderId, requestId: 'receipt-request-01', revision: 1, receiptConfirmed: true, deliveryUnderstood: true, sellerId: memberId('seller') };
  assert.equal((await f.call('confirmReceipt', data, 'admin')).code, 'FORBIDDEN');
  assert.equal((await f.call('confirmReceipt', data)).code, 'FORBIDDEN');
  const results = await Promise.all([f.call('confirmReceipt', data, 'seller'), f.call('confirmReceipt', data, 'seller')]);
  assert.equal(results.every(r => r.ok), true); assert.equal(f.repo.tables.entitlements.size, 1); assert.equal(f.repo.tables.jobs.size, 1);
  assert.equal([...f.repo.tables.audit.values()].filter(a => a.action === 'sellerConfirmReceipt').length, 1);
});
test('paid version reservation prevents two payable orders with different request keys', async () => {
  const f = fixture({ paidEnabled: true }); const { materialId } = f.published(200); await f.adult(); await f.adult('seller');
  const assetId = key('seller-qr'); f.files.set('cloud://qr', Buffer.from('qr')); f.repo.tables.assets.set(assetId, { _id: assetId, ownerId: memberId('seller'), purpose: 'paymentQr', status: 'ready', fileId: 'cloud://qr', sha256: 'locked' }); f.repo.tables.profiles.get(memberId('seller')).paymentQrAssetId = assetId;
  const results = await Promise.all(['paid-order-0001', 'paid-order-0002'].map(requestId => f.call('createOrder', { materialId, requestId })));
  assert.equal(results.every(r => r.ok), true); assert.equal(results.filter(r => r.alreadyPending).length, 1); assert.equal(f.repo.tables.orders.size, 1); assert.equal(f.repo.tables.entitlements.size, 1);
  const orderId = [...f.repo.tables.orders.keys()][0]; await f.call('cancelOrder', { orderId, revision: 1 });
  const afterCancel = await f.call('createOrder', { materialId, requestId: 'paid-order-0003' }); assert.equal(afterCancel.ok, true); assert.notEqual(afterCancel.order._id, orderId);
});
test('same reporter cannot multiply material complaints by changing request key', async () => {
  const f = fixture(); const { materialId } = f.published();
  const first = await f.call('reportMaterial', { materialId, requestId: 'complaint-first-1', reason: '涉嫌侵权需要核查' });
  const second = await f.call('reportMaterial', { materialId, requestId: 'complaint-next-02', reason: '更改说明不能覆盖' });
  assert.equal(first.complaintId, second.complaintId); assert.equal(second.duplicate, true); assert.equal(f.repo.tables.complaints.size, 1); assert.equal((await f.repo.get('materials', materialId)).openComplaintCount, 1);
});
test('audit failure atomically rolls back order and entitlement', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult(); f.repo.failAudit = true;
  assert.equal((await f.call('createOrder', { materialId, requestId: 'free-order-0001' })).code, 'SERVICE_UNAVAILABLE');
  assert.equal(f.repo.tables.orders.size, 0); assert.equal(f.repo.tables.entitlements.size, 0); assert.equal(f.repo.tables.jobs.size, 0);
});
test('private order messages reject outsiders and expire immediately at ninety-day boundary', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult();
  const created = await f.call('createOrder', { materialId, requestId: 'free-order-0001' }), orderId = created.order._id;
  assert.equal((await f.call('sendOrderMessage', { orderId, requestId: 'message-request-01', content: '请协助检查文件' }, 'stranger')).code, 'NOT_FOUND');
  const message = { orderId, requestId: 'message-request-01', content: '请协助检查文件' };
  assert.equal((await f.call('sendOrderMessage', message)).ok, true); assert.equal((await f.call('sendOrderMessage', message)).ok, true); assert.equal(f.repo.tables.messages.size, 1);
  f.repo.tables.orders.get(orderId).retentionExpiresAt = f.now();
  assert.equal((await f.call('listOrderMessages', { orderId })).code, 'EVIDENCE_CLEARED');
});
test('technical delivery repair remains available after ordinary seven-day window', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult();
  const created = await f.call('createOrder', { materialId, requestId: 'free-order-0001' }), orderId = created.order._id;
  const row = f.repo.tables.orders.get(orderId); row.firstClaimAt = f.now() - 8 * DAY; row.status = 'completed'; row.completedAt = f.now() - DAY;
  assert.equal((await f.call('openAfterSale', { orderId, requestId: 'after-sale-00001', type: '缺页', description: '第二章节无法找到' })).code, 'AFTER_SALE_WINDOW_CLOSED');
  const repair = await f.call('openAfterSale', { orderId, requestId: 'after-sale-00002', type: '技术交付问题', description: '下载文件无法打开' }); assert.equal(repair.ok, true);
  assert.equal((await f.repo.get('orders', orderId)).retentionExpiresAt, null);
  assert.equal((await f.call('getAfterSale', { caseId: repair.caseId }, 'stranger')).code, 'NOT_FOUND');
});
test('multiple complaints keep file signing frozen until every case is resolved', async () => {
  const f = fixture(); const { materialId } = f.published();
  const a = await f.call('reportMaterial', { materialId, requestId: 'complaint-000001', reason: '涉嫌未经授权复制' }), b = await f.call('reportMaterial', { materialId, requestId: 'complaint-000002', reason: '内容疑似不符描述' }, 'stranger');
  assert.equal(a.ok && b.ok, true); assert.equal((await f.repo.get('materials', materialId)).openComplaintCount, 2);
  assert.equal((await f.call('resolveMaterialComplaint', { complaintId: a.complaintId, revision: 1, decision: 'restore', reason: '核查未发现此项问题' }, 'admin')).materialStatus, 'held');
  assert.equal((await f.call('resolveMaterialComplaint', { complaintId: b.complaintId, revision: 1, decision: 'restore', reason: '确认资料描述一致' }, 'admin')).materialStatus, 'published');
});
test('free text and source hashes never appear in audit payloads', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult();
  const order = await f.call('createOrder', { materialId, requestId: 'free-order-0001' });
  await f.call('sendOrderMessage', { orderId: order.order._id, requestId: 'message-request-01', content: '这一句不能复制进审计' });
  const audit = JSON.stringify([...f.repo.tables.audit.values()]);
  for (const forbidden of ['这一句不能复制进审计', 'cloud://', 'sourceHash', 'openid', 'paymentQr']) assert.equal(audit.includes(forbidden), false);
});

test('late technical repair never revives expired proof, messages or closed case free text', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult();
  const created = await f.call('createOrder', { materialId, requestId: 'privacy-order-001' }), orderId = created.order._id;
  const oldCaseId = key('old-private-case'), proofId = key('old-proof');
  await f.call('sendOrderMessage', { orderId, requestId: 'old-message-0001', content: '已过期的私有留言' });
  Object.assign(f.repo.tables.orders.get(orderId), { status: 'completed', firstClaimAt: f.now() - 100 * DAY, completedAt: f.now() - 90 * DAY, retentionExpiresAt: f.now(), proofEvidenceId: proofId, paymentQr: { fileId: 'cloud://old-qr' } });
  f.repo.tables.evidence.set(proofId, { _id: proofId, kind: 'paymentProof', orderId, fileId: 'cloud://old-proof', note: '已过期的凭证说明', createdAt: f.now() - 100 * DAY });
  f.repo.tables.afterSales.set(oldCaseId, { _id: oldCaseId, kind: 'afterSale', orderId, type: '缺页', status: 'closed', description: '已过期的售后事实', coordination: '已过期的协调记录', revision: 2, createdAt: f.now() - 100 * DAY });
  const repair = await f.call('openAfterSale', { orderId, requestId: 'privacy-repair-01', type: '技术交付问题', description: '当前专属文件无法打开' }); assert.equal(repair.ok, true);
  const messages = await f.call('listOrderMessages', { orderId }); assert.equal(messages.items[0].cleared, true); assert.equal(messages.items[0].content, '');
  assert.equal((await f.call('getPaymentProof', { orderId })).code, 'NOT_FOUND');
  const oldCase = await f.call('getAfterSale', { caseId: oldCaseId }); assert.equal(oldCase.afterSale.contentCleared, true); assert.equal(oldCase.afterSale.description, '');
  const currentCase = await f.call('getAfterSale', { caseId: repair.caseId }); assert.equal(currentCase.afterSale.description, '当前专属文件无法打开');
  assert.equal((await f.call('sendOrderMessage', { orderId, requestId: 'new-message-0001', content: '本次技术报修的新留言' })).ok, true);
});
test('normal content after-sale closes at exactly seven days and unpaid orders cannot claim technical repair', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult();
  const created = await f.call('createOrder', { materialId, requestId: 'boundary-order-01' }), orderId = created.order._id;
  f.repo.tables.orders.get(orderId).firstClaimAt = f.now() - 7 * DAY;
  assert.equal((await f.call('openAfterSale', { orderId, requestId: 'boundary-case-001', type: '缺页', description: '此时已到七天边界' })).code, 'AFTER_SALE_WINDOW_CLOSED');
  f.repo.tables.orders.get(orderId).status = 'awaitingPayment';
  assert.equal((await f.call('openAfterSale', { orderId, requestId: 'boundary-case-002', type: '技术交付问题', description: '未付款不可报交付错误' })).code, 'NOT_ENTITLED');
});
test('retained payment QR setup can be retried without null-expiry rejection', async () => {
  const f = fixture({ paidEnabled: true }); await f.adult('seller'); const assetId = key('retained-qr-retry');
  f.repo.tables.assets.set(assetId, { _id: assetId, kind: 'privateImage', purpose: 'paymentQr', ownerId: memberId('seller'), status: 'ready', expiresAt: f.now() + DAY, createdAt: f.now() });
  assert.equal((await f.call('setPaymentQr', { assetId }, 'seller')).configured, true);
  assert.equal((await f.call('setPaymentQr', { assetId }, 'seller')).configured, true);
});

test('complaint arriving during link signing prevents new claim and leaves first claim unset', async () => {
  const f = fixture(); const { materialId } = f.published(); await f.adult();
  const created = await f.call('createOrder', { materialId, requestId: 'claim-race-0001' }), orderId = created.order._id;
  Object.assign(f.repo.tables.orders.get(orderId), { deliveryStatus: 'ready', watermarkedFileId: 'cloud://personal-copy', watermarkSourceHash: f.repo.tables.orders.get(orderId).sourceHash });
  f.files.set('cloud://personal-copy', Buffer.from('buyer specific copy'));
  const normalSign = f.storage.sign; f.storage.sign = async (fileId, age) => { const url = await normalSign(fileId, age); f.repo.tables.materials.get(materialId).status = 'held'; return url; };
  const claim = await f.call('claimOrder', { orderId, termsAccepted: true });
  assert.equal(claim.code, 'DELIVERY_HELD'); assert.equal(claim.url, undefined); assert.equal((await f.repo.get('orders', orderId)).firstClaimAt, undefined);
});
test('proof cancellation race commits only one transition and cannot grant purchase entitlement', async () => {
  const f = fixture({ paidEnabled: true }); const { materialId } = f.published(100); await f.adult(); await f.adult('seller');
  const qrId = key('race-qr'), proofId = key('race-proof');
  f.repo.tables.assets.set(qrId, { _id: qrId, kind: 'privateImage', ownerId: memberId('seller'), purpose: 'paymentQr', status: 'ready', retained: true, fileId: 'cloud://qr', sha256: 'qr', createdAt: f.now() });
  f.repo.tables.profiles.get(memberId('seller')).paymentQrAssetId = qrId;
  const created = await f.call('createOrder', { materialId, requestId: 'proof-race-order' }), orderId = created.order._id;
  f.repo.tables.assets.set(proofId, { _id: proofId, kind: 'privateImage', ownerId: memberId('buyer'), purpose: 'paymentProof', orderId, status: 'ready', fileId: 'cloud://proof', expiresAt: f.now() + DAY, createdAt: f.now() });
  const results = await Promise.all([
    f.call('submitPaymentProof', { orderId, assetId: proofId, requestId: 'proof-race-request', revision: 1, transferReference: '仅测试编号' }),
    f.call('cancelOrder', { orderId, revision: 1 }),
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  const order = await f.repo.get('orders', orderId); assert.ok(['cancelled', 'awaitingSeller'].includes(order.status));
  assert.equal((await f.repo.get('entitlements', key(`entitlement:${memberId('buyer')}:${order.versionId}`))).status, 'reserved');
  assert.equal([...f.repo.tables.jobs.values()].some(row => row.type === 'watermark'), false);
});
test('seller confirmation retries create only one active entitlement and watermark task', async () => {
  const f = fixture({ paidEnabled: true }); const { materialId } = f.published(100); await f.adult(); await f.adult('seller');
  const qrId = key('receipt-qr'); f.repo.tables.assets.set(qrId, { _id: qrId, ownerId: memberId('seller'), purpose: 'paymentQr', status: 'ready', retained: true, fileId: 'cloud://qr', sha256: 'qr', createdAt: f.now() }); f.repo.tables.profiles.get(memberId('seller')).paymentQrAssetId = qrId;
  const created = await f.call('createOrder', { materialId, requestId: 'receipt-order-01' }), orderId = created.order._id;
  f.repo.tables.orders.get(orderId).status = 'awaitingSeller';
  const payload = { orderId, requestId: 'seller-receipt-01', revision: 1, receiptConfirmed: true, deliveryUnderstood: true };
  const outcomes = await Promise.all([f.call('confirmReceipt', payload, 'seller'), f.call('confirmReceipt', payload, 'seller')]);
  assert.equal(outcomes.every(result => result.ok), true); assert.equal(f.repo.tables.entitlements.size, 1);
  assert.equal([...f.repo.tables.jobs.values()].filter(row => row.type === 'watermark').length, 1);
});

test('repeat age confirmation preserves seller configured payment asset', async () => {
  const f = fixture(); await f.adult('seller'); const qrId = key('seller-existing-qr');
  f.repo.tables.profiles.get(memberId('seller')).paymentQrAssetId = qrId;
  await f.adult('seller'); assert.equal((await f.repo.get('profiles', memberId('seller'))).paymentQrAssetId, qrId);
});
test('cancelled paid reservation does not prevent a later free entitlement for the same immutable version', async () => {
  const f = fixture({ paidEnabled: true }); const { materialId } = f.published(100); await f.adult(); await f.adult('seller');
  const qrId = key('paid-then-free-qr'); f.repo.tables.assets.set(qrId, { _id: qrId, ownerId: memberId('seller'), purpose: 'paymentQr', status: 'ready', retained: true, fileId: 'cloud://qr', sha256: 'qr', createdAt: f.now() }); f.repo.tables.profiles.get(memberId('seller')).paymentQrAssetId = qrId;
  const paid = await f.call('createOrder', { materialId, requestId: 'paid-before-free' });
  await f.call('cancelOrder', { orderId: paid.order._id, revision: 1 });
  f.repo.tables.materials.get(materialId).priceCents = 0;
  const free = await f.call('createOrder', { materialId, requestId: 'free-after-cancel' });
  assert.equal(free.ok, true); assert.equal(free.order.status, 'deliverable'); assert.notEqual(free.order._id, paid.order._id);
});

test('material complaint during standalone preview signing prevents returning its URL', async () => {
  const f = fixture(), { materialId } = f.published(), normalSign = f.storage.sign;
  f.storage.sign = async (fileId, age) => { const url = await normalSign(fileId, age); f.repo.tables.materials.get(materialId).status = 'held'; return url; };
  const result = await f.call('previewMaterial', { materialId }); assert.equal(result.code, 'DELIVERY_HELD'); assert.equal(result.url, undefined);
});

test('late payment evidence is preserved only after acknowledgement and never revives cancelled order', async () => {
  const f = fixture({ paidEnabled: true }); const { materialId } = f.published(100); await f.adult(); await f.adult('seller');
  const qrId = key('late-qr'), proofId = key('late-proof'); f.repo.tables.assets.set(qrId, { _id: qrId, ownerId: memberId('seller'), purpose: 'paymentQr', status: 'ready', retained: true, fileId: 'cloud://qr', sha256: 'qr', createdAt: f.now() }); f.repo.tables.profiles.get(memberId('seller')).paymentQrAssetId = qrId;
  const created = await f.call('createOrder', { materialId, requestId: 'late-paid-order-01' }), orderId = created.order._id;
  await f.call('cancelOrder', { orderId, revision: 1 });
  f.files.set('cloud://late-proof', Buffer.from('private late payment'));
  f.repo.tables.assets.set(proofId, { _id: proofId, kind: 'privateImage', ownerId: memberId('buyer'), orderId, purpose: 'paymentProof', status: 'ready', fileId: 'cloud://late-proof', expiresAt: f.now() + DAY, createdAt: f.now() });
  const data = { orderId, revision: 2, requestId: 'late-proof-request', assetId: proofId, transferReference: '迟到材料测试编号' };
  assert.equal((await f.call('submitPaymentProof', data)).code, 'LATE_PAYMENT');
  const recorded = await f.call('submitPaymentProof', { ...data, latePaymentAcknowledged: true }); assert.equal(recorded.ok, true); assert.equal(recorded.order.status, 'cancelled'); assert.equal(recorded.latePayment, true);
  assert.equal((await f.call('getPaymentProof', { orderId })).ok, true); assert.equal((await f.call('claimOrder', { orderId, termsAccepted: true })).code, 'NOT_ENTITLED');
  assert.equal((await f.call('confirmReceipt', { orderId, revision: recorded.order.revision, requestId: 'late-confirm-request', receiptConfirmed: true, deliveryUnderstood: true }, 'seller')).code, 'CONFLICT');
  assert.equal((await f.call('openAfterSale', { orderId, requestId: 'late-coordination', type: '迟到付款', description: '仅记录事实，需双方线下核实' })).ok, true);
});

test('old approved version remains complainable while seller prepares replacement draft', async () => {
  const f = fixture(), { materialId } = f.published(); f.repo.tables.materials.get(materialId).status = 'draft';
  const report = await f.call('reportMaterial', { materialId, requestId: 'replacement-report', reason: '已购旧版仍需要版权核查' }); assert.equal(report.ok, true); assert.equal((await f.repo.get('materials', materialId)).status, 'held');
  const closed = await f.call('resolveMaterialComplaint', { complaintId: report.complaintId, revision: 1, decision: 'restore', reason: '核对旧版情况后解除限制' }, 'admin');
  assert.equal(closed.materialStatus, 'draft');
});

test('admin order review is private and does not expose payment assets or source file', async () => {
  const f = fixture(), { materialId } = f.published(); await f.adult();
  await f.call('createOrder', { materialId, requestId: 'admin-order-list' });
  assert.equal((await f.call('reviewOrders')).code, 'FORBIDDEN');
  const result = await f.call('reviewOrders', {}, 'admin'); assert.equal(result.items.length, 1); assert.equal(result.items[0].viewerRole, 'admin');
  assert.equal(JSON.stringify(result).includes('cloud://'), false); assert.equal(JSON.stringify(result).includes('sourceHash'), false);
});

test('nonzero WeChat audit status cannot publish free text despite a contradictory pass verdict', async () => {
  const { createTradeService, APPID } = require('../../cloudfunctions/xiaopinTrade/service');
  for (const field of ['errCode', 'errcode']) {
    const f = fixture(); await f.adult('seller');
    const service = createTradeService({ repo: f.repo, storage: f.storage, now: f.now, logger: { error() {} }, moderate: async () => ({ [field]: -1, result: { suggest: 'pass' } }) });
    const result = await service({ action: 'saveMaterialDraft', requestId: 'audit-error-draft-001', title: '真实笔记', course: '微积分', type: '课程笔记', description: '逐章知识整理', learningModes: ['系统复习'], priceCents: 0 }, { OPENID: 'seller', APPID });
    assert.equal(result.code, 'MODERATION_UNAVAILABLE'); assert.equal(f.repo.tables.materials.size, 0);
  }
});

test('closed paid path refuses direct new payment QR upload and setup without touching private storage', async () => {
  const f = fixture(); await f.adult('seller');
  const assetId = key('paid-disabled-ready-qr');
  f.repo.tables.assets.set(assetId, { _id: assetId, purpose: 'paymentQr', ownerId: memberId('seller'), status: 'ready', fileId: 'cloud://old/qr', expiresAt: f.now() + DAY });
  const before = f.files.size;
  assert.equal((await f.call('uploadPrivateImage', { purpose: 'paymentQr', requestId: 'disabled-qr-upload', base64: Buffer.from([137,80,78,71,13,10,26,10]).toString('base64') }, 'seller')).code, 'PAID_DISABLED');
  assert.equal((await f.call('setPaymentQr', { assetId }, 'seller')).code, 'PAID_DISABLED');
  assert.equal(f.files.size, before); assert.equal((await f.repo.get('profiles', memberId('seller'))).paymentQrAssetId, undefined);
});
test('closing new paid orders does not remove seller fulfillment of an already submitted order', async () => {
  const f = fixture(); const { materialId, versionId, version } = f.published(100);
  const orderId = key('existing-paid-fulfillment');
  f.repo.tables.orders.set(orderId, { _id: orderId, kind: 'order', materialId, versionId, sourceHash: version.sha256, buyerId: memberId('buyer'), sellerId: memberId('seller'), status: 'awaitingSeller', deliveryStatus: 'none', priceCents: 100, title: '已有订单', revision: 1, createdAt: f.now(), buyerAlias: 'Reader-existing', shortId: 'EXISTING' });
  const result = await f.call('confirmReceipt', { orderId, revision: 1, requestId: 'existing-receipt-01', receiptConfirmed: true, deliveryUnderstood: true }, 'seller');
  assert.equal(result.ok, true); assert.equal(result.order.status, 'deliverable');
  assert.equal((await f.call('session')).paidEnabled, false);
});

test('seller service fee uses the server rate and rounds to whole cents without creating an order', async () => {
  const f = fixture();
  const quote = await f.call('quoteSellerServiceFee', { expectedSalesCents: 100000, feeCents: 1, rateBps: 1 }, 'seller');
  assert.deepEqual(quote.quote, { expectedSalesCents: 100000, feeCents: 5000, rateBps: 500, currency: 'CNY' });
  assert.equal((await f.call('quoteSellerServiceFee', { expectedSalesCents: 1010 })).quote.feeCents, 51);
  for (const expectedSalesCents of [-1, 9, 10.5, '100000', 100000001]) {
    assert.equal((await f.call('quoteSellerServiceFee', { expectedSalesCents })).code, 'INVALID_INPUT');
  }
  f.seed('seller', 'revoked');
  assert.equal((await f.call('quoteSellerServiceFee', { expectedSalesCents: 100000 }, 'seller')).code, 'ACCESS_DENIED');
  assert.equal(f.repo.tables.orders.size, 0);
});

test('seller service fee checkout is isolated, repeatable and requires WeChat to confirm amount', async () => {
  let paidFee = 4999;
  const f = fixture({ sellerFeePayment: {
    product: cents => cents === 5000 ? 'test-tools' : undefined,
    checkout: async order => ({ signData: order._id }),
    query: async () => ({ status: 2, paid_fee: paidFee, order_fee: 5000 }),
  } });
  const data = { expectedSalesCents: 100000, requestId: 'fee-checkout-00001', code: 'test-code', status: 'paid' };
  assert.equal((await f.call('startSellerFeeCheckout', data, 'seller')).code, 'ADULT_CONFIRMATION_REQUIRED');
  await f.adult('seller');
  const [first, retry] = await Promise.all([f.call('startSellerFeeCheckout', data, 'seller'), f.call('startSellerFeeCheckout', data, 'seller')]);
  assert.equal(first.status, 'pending');
  assert.equal(first.orderId, retry.orderId);
  assert.equal(f.repo.tables.orders.size, 1);
  assert.equal((await f.call('checkSellerFeePayment', { orderId: first.orderId })).code, 'NOT_FOUND');
  assert.equal((await f.call('checkSellerFeePayment', { orderId: first.orderId }, 'seller')).status, 'pending');
  paidFee = 5000;
  assert.equal((await f.call('checkSellerFeePayment', { orderId: first.orderId }, 'seller')).status, 'paid');
  assert.equal((await f.call('listOrders', { side: 'seller' }, 'seller')).items.length, 0);
});
