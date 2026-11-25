'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, PDFName, PDFHexString } = require('pdf-lib');
const { processTask, sha256 } = require('../../cloudfunctions/xiaopinPdfWorker/pdf-task');
const { runIsolated } = require('../../cloudfunctions/xiaopinPdfWorker/isolation');
const { createWorker } = require('../../cloudfunctions/xiaopinPdfWorker/worker');
const { fixture } = require('./helpers');
const { key, DAY, HOUR, memberId } = require('../../cloudfunctions/xiaopinTrade/service');

async function sourcePdf() {
  const doc = await PDFDocument.create();
  doc.addPage([300, 400]).drawText('Page one: approved learning guide');
  doc.addPage([300, 400]).drawText('Page two: full private source');
  const outline = doc.context.obj({ Title: PDFHexString.fromText('第一章'), Dest: [doc.getPage(0).ref, PDFName.of('Fit')] });
  const outlineRef = doc.context.register(outline), root = doc.context.obj({ Type: 'Outlines', First: outlineRef, Last: outlineRef, Count: 1 });
  doc.catalog.set(PDFName.of('Outlines'), doc.context.register(root));
  return Buffer.from(await doc.save());
}
test('real pdf-lib inspect extracts page count hash and readable bookmark suggestions', async () => {
  const bytes = await sourcePdf(), result = await runIsolated({ type: 'inspect' }, bytes);
  assert.equal(result.pageCount, 2); assert.equal(result.sha256, sha256(bytes)); assert.deepEqual(result.suggestedCatalog, [{ title: '第一章', page: 1 }]);
  assert.equal(result.limitations.includes('not malware'), true);
});
test('independent preview contains only chosen page, source stays private', async () => {
  const bytes = await sourcePdf(), result = await runIsolated({ type: 'preview', pages: [1], expectedHash: sha256(bytes) }, bytes);
  const preview = await PDFDocument.load(result.bytes); assert.equal(preview.getPageCount(), 1); assert.notEqual(sha256(result.bytes), sha256(bytes));
  assert.equal(preview.catalog.has(PDFName.of('Outlines')), false);
  await assert.rejects(runIsolated({ type: 'preview', pages: [3] }, bytes), { code: 'PREVIEW_PAGES_INVALID' });
});
test('watermark copy binds random reader alias plus order, keeps every page, rejects identity text', async () => {
  const bytes = await sourcePdf(), task = { type: 'watermark', alias: 'Reader-aabbccddee', shortId: '12AB34CD', expectedHash: sha256(bytes) };
  const result = await runIsolated(task, bytes), copy = await PDFDocument.load(result.bytes);
  assert.equal(copy.getPageCount(), 2); assert.notEqual(sha256(result.bytes), sha256(bytes));
  const p1 = copy.getPage(0).node.Contents().size(), p2 = copy.getPage(1).node.Contents().size(); assert.ok(p1 > 0 && p2 > 0);
  await assert.rejects(runIsolated({ ...task, alias: 'openid-real-person' }, bytes), { code: 'WATERMARK_ID_INVALID' });
  await assert.rejects(runIsolated({ ...task, expectedHash: 'forged' }, bytes), { code: 'SOURCE_HASH_MISMATCH' });
});
test('active-content dictionaries, encoded JS names, embedded files and malformed PDF are rejected', async () => {
  for (const field of ['OpenAction', 'AA', 'EmbeddedFiles', 'AF', 'XFA']) {
    const doc = await PDFDocument.create(); doc.addPage(); doc.catalog.set(PDFName.of(field), doc.context.obj({ S: 'JavaScript', JS: 'alert(1)' }));
    await assert.rejects(processTask({ type: 'inspect' }, Buffer.from(await doc.save())), { code: 'PDF_ACTIVE_CONTENT_REJECTED' });
  }
  await assert.rejects(runIsolated({ type: 'inspect' }, Buffer.from('not a pdf')), { code: 'PDF_FORMAT_UNSUPPORTED' });
  await assert.rejects(runIsolated({ type: 'inspect' }, Buffer.from('%PDF-1.7\nbroken')), { code: 'PDF_PARSE_OR_ENCRYPTION_REJECTED' });
});
test('PDF page and runtime time bounds reject unsupported work', async () => {
  const doc = await PDFDocument.create(); for (let i = 0; i < 201; i += 1) doc.addPage();
  await assert.rejects(runIsolated({ type: 'inspect' }, Buffer.from(await doc.save())), { code: 'PDF_PAGE_LIMIT' });
  await assert.rejects(runIsolated({ type: 'inspect' }, await sourcePdf(), { timeoutMs: 1 }), { code: 'PDF_TIME_LIMIT' });
});
test('worker timer trusts runtime identity and rejects a client-imitation Timer', async () => {
  const f = fixture();
  const spoofed = createWorker({ repo: f.repo, storage: f.storage, runPdf: async () => ({}), now: f.now, context: () => ({ OPENID: 'buyer' }) });
  assert.equal((await spoofed(f.timer)).code, 'FORBIDDEN');
  assert.equal((await f.worker()({ Type: 'Timer', TriggerName: 'other' })).code, 'INVALID_TRIGGER');
});
test('real lowercase timer processes queued PDF but other casing and client sources cannot', async () => {
  const f = fixture(); await f.adult('seller');
  const draft = await f.call('saveMaterialDraft', { requestId: 'lowercase-draft-001', title: '定时器验证', course: '微积分', type: '课程笔记', description: '定时处理验证', learningModes: ['系统复习'], priceCents: 0 }, 'seller');
  const bytes = await sourcePdf();
  const upload = await f.call('startPdfUpload', { materialId: draft.material._id, requestId: 'lowercase-upload-001', size: bytes.length, name: 'timer.pdf' }, 'seller');
  await f.call('uploadPdfChunk', { uploadId: upload.uploadId, index: 0, base64: bytes.toString('base64') }, 'seller');
  const sealed = await f.call('finalizePdfUpload', { uploadId: upload.uploadId }, 'seller');
  for (const Type of ['TIMER', 'tImEr', '', null]) assert.equal((await f.worker(runIsolated)({ ...f.timer, Type })).code, 'INVALID_TRIGGER');
  const forged = createWorker({ repo: f.repo, storage: f.storage, runPdf: runIsolated, now: f.now, context: () => ({ SOURCE: 'wx_client', OPENID: 'seller' }) });
  assert.equal((await forged({ ...f.timer, Type: 'timer' })).code, 'FORBIDDEN');
  assert.equal((await f.repo.get('uploads', upload.uploadId)).status, 'queued');
  const result = await f.worker(runIsolated)({ ...f.timer, Type: 'timer' });
  assert.equal(result.ok, true); assert.equal(result.processed, 1);
  assert.equal((await f.repo.get('versions', sealed.versionId)).status, 'processed');
});
test('timer mismatch diagnostics contain only bounded routing metadata after trusted runtime validation', async () => {
  const f = fixture(), logs = [];
  const worker = createWorker({ repo: f.repo, storage: f.storage, runPdf: async () => ({}), now: f.now,
    context: () => ({ SOURCE: 'wx_trigger' }), logger: { error: (...args) => logs.push(args) } });
  const result = await worker({ Type: 'timer', TriggerName: 'route\n'.repeat(100), privateText: 'private-body-never-log' });
  assert.equal(result.code, 'INVALID_TRIGGER');
  assert.equal(logs[0][0], 'trade_timer_route_rejected');
  assert.equal(logs[0][1].type, 'timer');
  assert.equal(logs[0][1].triggerName.length, 100);
  assert.equal(JSON.stringify(logs).includes('private-body-never-log'), false);
  logs.length = 0;
  const forged = createWorker({ repo: f.repo, storage: f.storage, runPdf: async () => ({}), now: f.now,
    context: () => ({ SOURCE: 'wx_client', OPENID: 'private-user' }), logger: { error: (...args) => logs.push(args) } });
  assert.equal((await forged({ Type: 'timer' })).code, 'FORBIDDEN');
  assert.equal(logs.length, 0);
});
test('real upload to sealed version to preview to admin review completes locally', async () => {
  const f = fixture(); await f.adult('seller');
  const saved = await f.call('saveMaterialDraft', { requestId: 'draft-request-001', title: '微积分学习笔记', course: '微积分', type: '课程笔记', description: '章节知识整理', learningModes: ['系统复习'], priceCents: 0 }, 'seller');
  const bytes = await sourcePdf(), materialId = saved.material._id;
  const upload = await f.call('startPdfUpload', { materialId, requestId: 'upload-request-001', size: bytes.length, name: '数学.pdf' }, 'seller');
  await f.call('uploadPdfChunk', { uploadId: upload.uploadId, index: 0, base64: bytes.toString('base64') }, 'seller');
  const sealed = await f.call('finalizePdfUpload', { uploadId: upload.uploadId }, 'seller');
  const worker = f.worker(runIsolated); assert.equal((await worker(f.timer)).processed, 1);
  const info = await f.call('getUpload', { uploadId: upload.uploadId }, 'seller'); assert.equal(info.status, 'ready'); assert.equal(info.pageCount, 2);
  const submitted = await f.call('submitMaterial', { materialId, versionId: sealed.versionId, revision: 1, originalConfirmed: true, catalog: [{ title: '第一章', page: 1 }], previewPages: [1] }, 'seller');
  assert.equal(submitted.status, 'processing'); assert.equal((await worker(f.timer)).processed, 1);
  const pending = await f.call('getMaterial', { materialId }, 'admin'); assert.equal(pending.material.status, 'pending');
  assert.equal((await f.call('getMaterial', { materialId }, 'buyer')).code, 'NOT_FOUND');
  const reviewed = await f.call('reviewMaterial', { materialId, revision: pending.material.revision, decision: 'approve', reason: '已全量核查并确认描述一致', copyrightChecked: true, descriptionChecked: true, fullDocumentChecked: true }, 'admin');
  assert.equal(reviewed.status, 'published');
  assert.equal((await f.call('previewMaterial', { materialId })).ok, true);
  await f.adult(); const order = await f.call('createOrder', { materialId, requestId: 'free-order-001' });
  assert.equal((await worker(f.timer)).processed, 1);
  const claim = await f.call('claimOrder', { orderId: order.order._id, termsAccepted: true });
  assert.equal(claim.ok, true); assert.equal(claim.downloadConfirmed, false); assert.equal(f.files.has((await f.repo.get('orders', order.order._id)).watermarkedFileId), true);
});
test('worker rejects changed sealed chunks and leaves no version or leaked output', async () => {
  const f = fixture(), jobId = key('bad-job'), uploadId = key('bad-upload');
  f.files.set('cloud://chunk', Buffer.from('mutated'));
  f.repo.tables.uploads.set(uploadId, { _id: uploadId, kind: 'pdfUpload', status: 'queued', revision: 1, createdAt: f.now(), expiresAt: f.now() + DAY });
  f.repo.tables.jobs.set(jobId, { _id: jobId, kind: 'fileJob', type: 'processUpload', uploadId, materialId: key('m'), ownerId: memberId('seller'), versionId: key('v'), status: 'queued', attempts: 0, expectedSize: 7, chunks: [{ fileId: 'cloud://chunk', size: 7, sha256: 'wrong' }], createdAt: f.now() });
  const result = await f.worker(runIsolated)(f.timer); assert.equal(result.failed, 1); assert.equal(f.repo.tables.versions.size, 0); assert.equal((await f.repo.get('uploads', uploadId)).errorCode, 'CHUNK_HASH_MISMATCH');
});
test('material security reject commits terminal verdict before returning error', async () => {
  const f = fixture(); const { materialId, versionId } = f.published();
  Object.assign(f.repo.tables.materials.get(materialId), { status: 'pending', currentVersionId: null, pendingVersionId: versionId, moderation: { suggestion: 'pass' } });
  f.repo.tables.versions.get(versionId).status = 'pending';
  let calls = 0;
  const { createTradeService } = require('../../cloudfunctions/xiaopinTrade/service');
  const service = createTradeService({ repo: f.repo, storage: f.storage, now: f.now, logger: { error() {} }, moderate: async () => ({ result: { suggest: ++calls === 1 ? 'pass' : 'risky' } }) });
  const result = await service({ action: 'reviewMaterial', materialId, revision: 1, decision: 'approve', reason: '全量审核确认', copyrightChecked: true, descriptionChecked: true, fullDocumentChecked: true }, { APPID: 'wxa16f2146b48a2c2e', OPENID: 'admin' });
  assert.equal(result.code, 'CONTENT_REJECTED'); assert.equal((await f.repo.get('materials', materialId)).status, 'rejected'); assert.equal((await f.repo.get('versions', versionId)).status, 'rejected');
  assert.equal((await f.call('reviewMaterial', { materialId, revision: 2, decision: 'approve', reason: '重试审核', copyrightChecked: true, descriptionChecked: true, fullDocumentChecked: true }, 'admin')).code, 'CONFLICT');
});
test('server timeout cancels at 48 hours and automatic completion starts at first claim plus 7 days', async () => {
  const f = fixture(); const orderId = key('order');
  f.repo.tables.orders.set(orderId, { _id: orderId, kind: 'order', status: 'awaitingPayment', createdAt: f.now() - 48 * HOUR + 1, revision: 1 });
  await f.worker()(f.timer); assert.equal((await f.repo.get('orders', orderId)).status, 'awaitingPayment');
  f.advance(1); await f.worker()(f.timer); assert.equal((await f.repo.get('orders', orderId)).status, 'cancelled');
  const row = f.repo.tables.orders.get(orderId); row.status = 'deliverable'; row.firstClaimAt = f.now() - 7 * DAY; row.afterSaleOpen = true;
  await f.worker()(f.timer); assert.equal((await f.repo.get('orders', orderId)).status, 'deliverable');
  f.repo.tables.orders.get(orderId).afterSaleOpen = false; await f.worker()(f.timer); assert.equal((await f.repo.get('orders', orderId)).status, 'completed');
});
test('ninety-day physical cleanup removes private free content and file, preserves active copy and minimal audit', async () => {
  const f = fixture(), orderId = key('retention-order'), evidenceId = key('proof'), messageId = key('message'), caseId = key('case'), assetId = key('asset');
  f.files.set('cloud://proof', Buffer.from('private proof')); f.files.set('cloud://valid-copy', Buffer.from('paid entitlement')); f.files.set('cloud://seller-qr', Buffer.from('shared QR'));
  f.repo.tables.orders.set(orderId, { _id: orderId, kind: 'order', status: 'completed', afterSaleOpen: false, retentionExpiresAt: f.now(), createdAt: f.now() - 100 * DAY, revision: 1, watermarkedFileId: 'cloud://valid-copy', paymentQr: { fileId: 'cloud://seller-qr' } });
  f.repo.tables.evidence.set(evidenceId, { _id: evidenceId, kind: 'paymentProof', orderId, fileId: 'cloud://proof', assetId, transferReference: 'sensitive transfer', note: 'private note', createdAt: f.now() - 100 * DAY });
  f.repo.tables.assets.set(assetId, { _id: assetId, kind: 'privateImage', retained: true, fileId: 'cloud://proof', createdAt: f.now() - 100 * DAY });
  f.repo.tables.messages.set(messageId, { _id: messageId, kind: 'orderMessage', orderId, speaker: 'buyer', content: 'private message', createdAt: f.now() - 100 * DAY });
  f.repo.tables.afterSales.set(caseId, { _id: caseId, kind: 'afterSale', orderId, status: 'closed', type: '缺页', result: 'coordinated', description: 'private description', coordination: 'private coordination', revision: 2, createdAt: f.now() - 100 * DAY });
  await f.worker()(f.timer);
  assert.equal(f.files.has('cloud://proof'), false); assert.equal(f.files.has('cloud://valid-copy'), true); assert.equal(f.files.has('cloud://seller-qr'), true);
  const recordText = JSON.stringify([await f.repo.get('evidence', evidenceId), await f.repo.get('messages', messageId), await f.repo.get('afterSales', caseId)]);
  for (const secret of ['private note', 'private message', 'private description', 'private coordination', 'sensitive transfer', 'cloud://proof']) assert.equal(recordText.includes(secret), false);
  assert.equal((await f.repo.get('orders', orderId)).evidenceCleared, true);
});
test('physical deletion failure leaves retryable evidence and task failure, then recovers safely', async () => {
  const f = fixture(), orderId = key('cleanup-order'), evidenceId = key('proof');
  f.files.set('cloud://proof', Buffer.from('proof'));
  f.repo.tables.orders.set(orderId, { _id: orderId, kind: 'order', status: 'completed', revision: 1, afterSaleOpen: false, retentionExpiresAt: f.now(), createdAt: f.now() - 100 * DAY });
  f.repo.tables.evidence.set(evidenceId, { _id: evidenceId, kind: 'paymentProof', orderId, fileId: 'cloud://proof', note: 'private', createdAt: f.now() - 100 * DAY });
  f.failDelete(true); await assert.rejects(f.worker()(f.timer), { code: 'TRADE_MAINTENANCE_INCOMPLETE' });
  assert.equal((await f.repo.get('evidence', evidenceId)).note, 'private'); assert.equal((await f.repo.get('orders', orderId)).evidenceClearing, true);
  f.failDelete(false); await f.worker()(f.timer); assert.equal((await f.repo.get('orders', orderId)).evidenceCleared, true);
  await f.worker()(f.timer); assert.equal(f.files.has('cloud://proof'), false);
});
test('replaced seller QR is deleted only after no profile or live order references it', async () => {
  const f = fixture(), assetId = key('retained-qr'), fileId = 'cloud://seller-qr'; f.files.set(fileId, Buffer.from('private qr'));
  f.repo.tables.assets.set(assetId, { _id: assetId, kind: 'privateImage', purpose: 'paymentQr', ownerId: memberId('seller'), retained: true, status: 'ready', fileId, createdAt: f.now() - DAY });
  await f.adult('seller'); f.repo.tables.profiles.get(memberId('seller')).paymentQrAssetId = assetId;
  await f.worker()(f.timer); assert.equal(f.files.has(fileId), true);
  f.repo.tables.profiles.get(memberId('seller')).paymentQrAssetId = key('new-qr');
  const orderId = key('qr-order'); f.repo.tables.orders.set(orderId, { _id: orderId, kind: 'order', status: 'awaitingPayment', createdAt: f.now(), revision: 1, paymentQrAssetId: assetId });
  await f.worker()(f.timer); assert.equal(f.files.has(fileId), true);
  f.repo.tables.orders.get(orderId).paymentQrAssetId = null;
  await f.worker()(f.timer); assert.equal(f.files.has(fileId), false); assert.equal((await f.repo.get('assets', assetId)).status, 'cleared');
});
test('abandoned unsubmitted PDF is physically cleared after seven days; referenced versions survive', async () => {
  const f = fixture(), { versionId } = f.published(), abandonedId = key('abandoned');
  f.files.set('cloud://abandoned', Buffer.from('abandoned pdf'));
  f.repo.tables.versions.set(abandonedId, { _id: abandonedId, kind: 'materialVersion', status: 'processed', sourceFileId: 'cloud://abandoned', sellerId: memberId('seller'), materialId: key('old-draft'), sha256: 'fact', pageCount: 1, createdAt: f.now() - 7 * DAY });
  await f.worker()(f.timer); assert.equal(f.files.has('cloud://abandoned'), false); assert.equal((await f.repo.get('versions', abandonedId)).status, 'cleared'); assert.equal((await f.repo.get('versions', versionId)).status, 'approved');
});

test('expired evidence is physically removed even while a new technical case remains open', async () => {
  const f = fixture(), { materialId } = f.published(); await f.adult();
  const created = await f.call('createOrder', { materialId, requestId: 'epoch-order-001' }), orderId = created.order._id, oldProof = key('epoch-proof'), oldMessage = key('epoch-message');
  const row = f.repo.tables.orders.get(orderId); Object.assign(row, { status: 'completed', deliveryStatus: 'ready', firstClaimAt: f.now() - 100 * DAY, completedAt: f.now() - 90 * DAY, retentionExpiresAt: f.now(), proofEvidenceId: oldProof });
  f.files.set('cloud://epoch-proof', Buffer.from('expired proof'));
  f.repo.tables.evidence.set(oldProof, { _id: oldProof, kind: 'paymentProof', orderId, fileId: 'cloud://epoch-proof', note: 'expired free content', createdAt: f.now() - 100 * DAY });
  f.repo.tables.messages.set(oldMessage, { _id: oldMessage, kind: 'orderMessage', orderId, speaker: 'buyer', content: 'expired message', createdAt: f.now() - 100 * DAY });
  const repair = await f.call('openAfterSale', { orderId, requestId: 'epoch-repair-001', type: '技术交付问题', description: '新报修必须保留直到结案' }); assert.equal(repair.ok, true);
  const newMessage = await f.call('sendOrderMessage', { orderId, requestId: 'epoch-new-message', content: '新技术留言需要保留' });
  await f.worker()(f.timer);
  assert.equal(f.files.has('cloud://epoch-proof'), false); assert.equal((await f.repo.get('evidence', oldProof)).note, undefined);
  assert.equal((await f.repo.get('messages', oldMessage)).content, undefined);
  assert.equal((await f.repo.get('messages', newMessage.messageId)).content, '新技术留言需要保留');
  assert.equal((await f.repo.get('afterSales', repair.caseId)).description, '新报修必须保留直到结案');
  assert.equal((await f.repo.get('orders', orderId)).afterSaleOpen, true);
});
test('exhausted stale PDF lease marks both job and dependent upload failed', async () => {
  const f = fixture(), jobId = key('exhausted-job'), uploadId = key('exhausted-upload');
  f.repo.tables.uploads.set(uploadId, { _id: uploadId, kind: 'pdfUpload', status: 'processing', revision: 1, createdAt: f.now(), expiresAt: f.now() + DAY });
  f.repo.tables.jobs.set(jobId, { _id: jobId, kind: 'fileJob', type: 'processUpload', uploadId, attempts: 3, status: 'processing', leaseUntil: f.now() - 1, createdAt: f.now() });
  await f.worker()(f.timer); assert.equal((await f.repo.get('jobs', jobId)).errorCode, 'RETRY_LIMIT'); assert.equal((await f.repo.get('uploads', uploadId)).status, 'failed');
});
test('processing queue cursor reaches old expired leases behind active leases', async () => {
  const f = fixture();
  for (let i = 0; i < 8; i += 1) {
    const jobId = key(`lease-${i}`);
    f.repo.tables.jobs.set(jobId, { _id: jobId, kind: 'fileJob', type: 'processUpload', attempts: i === 0 ? 3 : 1, status: 'processing', leaseUntil: i === 0 ? f.now() - 1 : f.now() + DAY, createdAt: f.now() + i });
  }
  for (let i = 0; i < 6; i += 1) await f.worker()(f.timer);
  assert.equal((await f.repo.get('jobs', key('lease-0'))).status, 'failed');
});

test('storage deletion followed by database failure safely retries an already-missing evidence file', async () => {
  const f = fixture(), orderId = key('delete-before-db-order'), evidenceId = key('delete-before-db-proof');
  f.files.set('cloud://delete-before-db', Buffer.from('private proof'));
  f.repo.tables.orders.set(orderId, { _id: orderId, kind: 'order', status: 'completed', afterSaleOpen: false, retentionExpiresAt: f.now(), createdAt: f.now() - 100 * DAY, revision: 1 });
  f.repo.tables.evidence.set(evidenceId, { _id: evidenceId, kind: 'paymentProof', orderId, fileId: 'cloud://delete-before-db', note: 'private', createdAt: f.now() - 100 * DAY });
  const remove = f.storage.remove; let inject = true;
  f.storage.remove = async fileId => { await remove(fileId); if (inject) { inject = false; f.repo.beforeTransaction = () => { throw new Error('isolated post-delete transaction failure'); }; } };
  await assert.rejects(f.worker()(f.timer), { code: 'TRADE_MAINTENANCE_INCOMPLETE' });
  assert.equal(f.files.has('cloud://delete-before-db'), false); assert.equal((await f.repo.get('evidence', evidenceId)).note, 'private');
  await f.worker()(f.timer); assert.equal((await f.repo.get('evidence', evidenceId)).note, undefined); assert.equal((await f.repo.get('orders', orderId)).evidenceCleared, true);
});

test('expired upload chunk cleanup checkpoints each file and preserves sealed full version', async () => {
  const f = fixture(), uploadId = key('expired-blocks'), versionId = key('sealed-source');
  f.files.set('cloud://sealed-source', Buffer.from('source retained'));
  f.repo.tables.versions.set(versionId, { _id: versionId, kind: 'materialVersion', status: 'approved', sourceFileId: 'cloud://sealed-source', createdAt: f.now() - 2 * DAY });
  f.repo.tables.uploads.set(uploadId, { _id: uploadId, kind: 'pdfUpload', status: 'ready', versionId, createdAt: f.now() - 2 * DAY, expiresAt: f.now() - DAY });
  for (let index = 0; index < 3; index += 1) {
    const chunkId = key(`expired-block-${index}`), fileId = `cloud://chunk-${index}`; f.files.set(fileId, Buffer.from('private block'));
    f.repo.tables.chunks.set(chunkId, { _id: chunkId, kind: 'pdfChunk', uploadId, index, status: 'ready', fileId, createdAt: f.now() - 2 * DAY });
  }
  const remove = f.storage.remove; let deletionCount = 0;
  f.storage.remove = async fileId => { if (++deletionCount === 2) throw Error('isolated second deletion failure'); return remove(fileId); };
  await assert.rejects(f.worker()(f.timer), { code: 'TRADE_MAINTENANCE_INCOMPLETE' });
  assert.equal([...f.repo.tables.chunks.values()].filter(row => row.status === 'cleared').length, 1);
  await f.worker()(f.timer); assert.equal([...f.repo.tables.chunks.values()].every(row => row.status === 'cleared'), true);
  assert.equal(f.files.has('cloud://sealed-source'), true); assert.ok((await f.repo.get('uploads', uploadId)).cleanedAt);
});

test('blank PDF pages without Contents support preview and repeated watermark delivery', async () => {
  const doc = await PDFDocument.create(); doc.addPage([300, 400]); doc.addPage([300, 400]).drawText('content after blank page');
  const bytes = Buffer.from(await doc.save());
  const preview = await runIsolated({ type: 'preview', pages: [1] }, bytes); assert.equal((await PDFDocument.load(preview.bytes)).getPageCount(), 1);
  const copy = await runIsolated({ type: 'watermark', alias: 'Reader-aabbccddee', shortId: '12AB34CD' }, bytes); assert.equal((await PDFDocument.load(copy.bytes)).getPageCount(), 2);
});

test('staged reservation from a killed upload is cleaned while attached purchase files survive', async () => {
  const f = fixture(), stagedId = key('staged-kill'), attachedId = key('attached-live');
  f.files.set('cloud://staged-kill', Buffer.from('unreferenced bytes')); f.files.set('cloud://attached-live', Buffer.from('live purchase copy'));
  f.repo.tables.jobs.set(stagedId, { _id: stagedId, kind: 'fileReservation', status: 'staged', fileId: 'cloud://staged-kill', targetId: key('old-attempt'), createdAt: f.now() - 2 * DAY, expiresAt: f.now() - DAY });
  f.repo.tables.jobs.set(attachedId, { _id: attachedId, kind: 'fileReservation', status: 'attached', fileId: 'cloud://attached-live', targetId: key('live-order'), createdAt: f.now() - 2 * DAY, expiresAt: f.now() - DAY });
  f.failDelete(true); await assert.rejects(f.worker()(f.timer), { code: 'TRADE_MAINTENANCE_INCOMPLETE' }); assert.equal((await f.repo.get('jobs', stagedId)).status, 'clearing');
  f.failDelete(false); await f.worker()(f.timer);
  assert.equal(f.files.has('cloud://staged-kill'), false); assert.equal((await f.repo.get('jobs', stagedId)).status, 'cleared'); assert.equal(f.files.has('cloud://attached-live'), true);
});
test('reservation write failure prevents sending any private chunk bytes to storage', async () => {
  const f = fixture(); await f.adult('seller');
  const saved = await f.call('saveMaterialDraft', { requestId: 'reserve-draft-001', title: '课程学习笔记', course: '微积分', type: '课程笔记', description: '资料上传隔离样本', learningModes: ['系统复习'], priceCents: 0 }, 'seller');
  const bytes = Buffer.from('%PDF-test'), upload = await f.call('startPdfUpload', { materialId: saved.material._id, requestId: 'reserve-upload-01', name: 'test.pdf', size: bytes.length }, 'seller');
  const tx = f.repo.transaction.bind(f.repo); f.repo.transaction = work => tx(original => work({ ...original, set: async (type, id, value) => { if (value.kind === 'fileReservation') throw Error('isolated reservation failure'); return original.set(type, id, value); } }));
  const result = await f.call('uploadPdfChunk', { uploadId: upload.uploadId, index: 0, base64: bytes.toString('base64') }, 'seller'); assert.equal(result.code, 'UPLOAD_FAILED'); assert.equal(f.files.size, 0);
});

test('uncertain committed upload response cannot delete an attached chunk', async () => {
  const f = fixture(); await f.adult('seller');
  const saved = await f.call('saveMaterialDraft', { requestId: 'uncertain-draft1', title: '课程学习笔记', course: '微积分', type: '课程笔记', description: '事务回应中断样本', learningModes: ['系统复习'], priceCents: 0 }, 'seller');
  const bytes = Buffer.from('%PDF-test'), upload = await f.call('startPdfUpload', { materialId: saved.material._id, requestId: 'uncertain-upload1', name: 'test.pdf', size: bytes.length }, 'seller');
  const tx = f.repo.transaction.bind(f.repo); let inject = true;
  f.repo.transaction = async work => { let attached = false; const result = await tx(original => work({ ...original, set: async (type, id, value) => { if (value.kind === 'fileReservation' && value.status === 'attached') attached = true; return original.set(type, id, value); } })); if (attached && inject) { inject = false; throw Error('isolated response lost after commit'); } return result; };
  const payload = { uploadId: upload.uploadId, index: 0, base64: bytes.toString('base64') };
  assert.equal((await f.call('uploadPdfChunk', payload, 'seller')).ok, false); assert.equal(f.files.size, 1);
  assert.equal((await f.call('uploadPdfChunk', payload, 'seller')).status, 'ready'); assert.equal(f.files.size, 1);
});

test('uncertain PDF output commit preserves attached source and completed upload on retry', async () => {
  const f = fixture(); await f.adult('seller');
  const saved = await f.call('saveMaterialDraft', { requestId: 'source-draft-001', title: '课程学习笔记', course: '微积分', type: '课程笔记', description: '封存回应中断样本', learningModes: ['系统复习'], priceCents: 0 }, 'seller');
  const bytes = await sourcePdf(), upload = await f.call('startPdfUpload', { materialId: saved.material._id, requestId: 'source-upload-001', name: 'test.pdf', size: bytes.length }, 'seller');
  await f.call('uploadPdfChunk', { uploadId: upload.uploadId, index: 0, base64: bytes.toString('base64') }, 'seller');
  const sealed = await f.call('finalizePdfUpload', { uploadId: upload.uploadId }, 'seller');
  const tx = f.repo.transaction.bind(f.repo); let inject = true;
  f.repo.transaction = async work => { let sealedVersion = false; const result = await tx(original => work({ ...original, set: async (type, id, value) => { if (type === 'versions' && value.status === 'processed') sealedVersion = true; return original.set(type, id, value); } })); if (sealedVersion && inject) { inject = false; throw Error('isolated source commit response lost'); } return result; };
  await f.worker(runIsolated)(f.timer);
  const version = await f.repo.get('versions', sealed.versionId); assert.equal(version.status, 'processed'); assert.equal(f.files.has(version.sourceFileId), true); assert.equal((await f.repo.get('uploads', upload.uploadId)).status, 'ready');
  await f.worker(runIsolated)(f.timer); assert.equal(f.files.has(version.sourceFileId), true);
});

test('worker rejects payload-forged timers from missing, HTTP, client and chained runtime sources', async () => {
  const f = fixture();
  for (const identity of [null, {}, { SOURCE: 'wx_http' }, { SOURCE: 'wx_unknown' }, { SOURCE: 'wx_client' }, { SOURCE: 'wx_client,scf' }, { SOURCE: 'wx_trigger,scf' }, { SOURCE: 'wx_trigger', OPENID: 'spoofed' }]) {
    const worker = createWorker({ repo: f.repo, storage: f.storage, runPdf: async () => ({}), now: f.now, context: () => identity });
    assert.equal((await worker({ ...f.timer, SOURCE: 'wx_trigger' })).code, 'FORBIDDEN');
  }
  assert.equal(f.repo.tables.jobs.size, 0);
});
