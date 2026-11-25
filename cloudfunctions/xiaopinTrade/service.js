'use strict';

const { createHash, randomBytes } = require('crypto');
const VERSION = 'trade-20261115-v1.2';
const TERMS_VERSION = 'trade-20261113-v1';
const APPID = 'wxa16f2146b48a2c2e';
const LIMITS = { pdfBytes: 20 * 1024 * 1024, pages: 200, chunkBytes: 256 * 1024, imageBytes: 600 * 1024, pageSize: 20 };
const HOUR = 3600000;
const DAY = 24 * HOUR;
const RETENTION_DAYS = 90;
const SELLER_SERVICE_FEE_BPS = 500;
const LEARNING_MODES = ['考前补漏', '系统复习', '基础入门', '进阶拓展'];
const MATERIAL_TYPES = ['课程笔记', '知识总结', '学习指南', '经验整理'];
const AFTER_SALE_TYPES = ['文件损坏', '缺页', '所列章节缺失', '描述不符', '其他', '技术交付问题', '迟到付款'];
const FEEDBACK = ['补漏有用', '看不懂', '太水'];
class TradeError extends Error { constructor(code, message) { super(message); this.code = code; } }
function fail(code, message) { throw new TradeError(code, message); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function key(value) { return hash(value).slice(0, 32); }
function memberId(openid) { return key(`${APPID}:${openid}`); }
function randomId() { return randomBytes(16).toString('hex'); }
function str(value, max, label, min = 1) {
  if (typeof value !== 'string') fail('INVALID_INPUT', `请填写${label}。`);
  const result = value.trim();
  if (Array.from(result).length < min || Array.from(result).length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) fail('INVALID_INPUT', `${label}需为${min}–${max}字。`);
  return result;
}
function id(value) { if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) fail('INVALID_INPUT', '记录编号无效，请刷新。'); return value; }
function req(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{10,64}$/.test(value)) fail('INVALID_INPUT', '请求编号无效，请重新打开表单。'); return value; }
function rev(record, value) { if (!Number.isSafeInteger(value) || value !== record.revision) fail('CONFLICT', '记录已有变化，请刷新后重新确认。'); }
function integer(value, min, max, label) { if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT', `${label}超出允许范围。`); return value; }
function evidenceEpoch(record) { return Number.isSafeInteger(record.evidenceEpoch) && record.evidenceEpoch > 0 ? record.evidenceEpoch : 1; }
function privateContentExpired(order, record, at) {
  return !!record.clearedAt || evidenceEpoch(record) <= (order.evidenceExpiredThroughEpoch || 0)
    || !!(order.retentionExpiresAt && order.retentionExpiresAt <= at);
}
function approved(member, { existing = false } = {}) {
  if (!member || member.kind !== 'member') fail('ACCESS_DENIED', '请先申请内测资格。');
  if (!existing && member.status !== 'approved') fail('ACCESS_DENIED', '内测资格已失效，请联系管理员。');
  return member;
}
function banned(member) { return member.banned === true || member.communityBan === true || member.punishment === 'banned' || member.sanction === 'banned' || member.banStatus === 'banned'; }
function active(member) { approved(member); if (banned(member)) fail('COMMUNITY_BANNED', '当前账号不能发起新交易，已有订单与售后仍可访问。'); return member; }
function admin(member) { approved(member); if (member.role !== 'admin') fail('FORBIDDEN', '只有管理员可以处理。'); return member; }
function pageCursor(value, scope) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 800 || !/^[a-zA-Z0-9_-]+$/.test(value)) fail('INVALID_CURSOR', '分页位置无效，请刷新。');
  try { const p = JSON.parse(Buffer.from(value, 'base64url').toString()); if (p.s !== scope || !Number.isSafeInteger(p.t) || !/^[a-f0-9]{32}$/.test(p.i)) throw new Error(); return { createdAt: p.t, _id: p.i }; }
  catch (_) { fail('INVALID_CURSOR', '分页位置无效，请刷新。'); }
}
function encodeCursor(row, scope) { return Buffer.from(JSON.stringify({ t: row.createdAt, i: row._id, s: scope })).toString('base64url'); }
function base64(value, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('INVALID_INPUT', '文件分块格式或大小无效。');
  const bytes = Buffer.from(value, 'base64'); if (!bytes.length || bytes.length > max) fail('INVALID_INPUT', '文件分块超出限制。'); return bytes;
}
function publicMaterial(row) {
  return {
    _id: row._id, title: row.title, course: row.course, type: row.type, description: row.description,
    learningModes: row.learningModes, catalog: row.catalog || [], priceCents: row.priceCents,
    status: row.status, currentVersionId: row.currentVersionId || null, pageCount: row.pageCount || 0,
    createdAt: row.createdAt, updatedAt: row.updatedAt, revision: row.revision,
  };
}
function publicOrder(row, actor, at) {
  const owner = row.buyerId === actor._id ? 'buyer' : row.sellerId === actor._id ? 'seller' : 'admin';
  return {
    _id: row._id, shortId: row.shortId, title: row.title, description: row.description, priceCents: row.priceCents,
    status: row.status, deliveryStatus: row.deliveryStatus || 'none', versionId: row.versionId,
    materialId: row.materialId, createdAt: row.createdAt, updatedAt: row.updatedAt, revision: row.revision,
    viewerRole: owner, firstClaimAt: row.firstClaimAt || null, completedAt: row.completedAt || null,
    afterSaleOpen: !!row.afterSaleOpen, reminderDue: row.status === 'awaitingSeller' && at - row.submittedAt >= 48 * HOUR,
    interventionAllowed: row.status === 'awaitingSeller' && at - row.submittedAt >= 72 * HOUR,
    retentionExpiresAt: row.retentionExpiresAt || null, evidenceCleared: !!row.evidenceCleared,
    free: row.priceCents === 0,
  };
}

function createTradeService({ repo, storage, moderate, now = Date.now, logger = console, paidEnabled = false, sellerFeePayment = null }) {
  if (!repo || !storage || typeof moderate !== 'function') throw new Error('Trade dependencies are required');
  async function checked(openid, content, { captureRisky = false } = {}) {
    let result;
    try { result = await moderate(openid, content); } catch (_) { fail('MODERATION_UNAVAILABLE', '微信内容审核暂不可用，输入已保留，请稍后重试。'); }
    // A transport/provider failure never becomes a pass, even if a stale or
    // malformed response also contains result.suggest.
    if (!result || [result.errCode, result.errcode].some(code => code !== undefined && code !== 0)) fail('MODERATION_UNAVAILABLE', '微信内容审核暂不可用，输入已保留，请稍后重试。');
    const verdict = result && result.result && result.result.suggest;
    if (verdict === 'risky' && captureRisky) return { suggestion: 'risky', traceId: typeof result.traceId === 'string' ? result.traceId : '' };
    if (verdict === 'risky') fail('CONTENT_REJECTED', '内容未通过微信安全审核，请修改后重试。');
    if (verdict !== 'pass') fail(verdict === 'review' ? 'REVIEW_REQUIRED' : 'MODERATION_UNAVAILABLE', '内容暂未通过微信审核，不能提交，请保留输入稍后重试。');
    return { suggestion: 'pass', traceId: typeof result.traceId === 'string' ? result.traceId : '' };
  }
  async function audit(tx, actor, target, action, from, to, revision, at) {
    const auditId = key(`${actor}:${target}:${action}:${revision}`);
    await tx.set('audit', auditId, { _id: auditId, kind: 'tradeAudit', actorId: actor, targetId: target, action, from, to, revision, createdAt: at });
  }
  async function removeOrQueue(fileId, targetId) {
    try { await storage.remove(fileId); }
    catch (_) {
      const garbageId = key(`garbage:${fileId}`), at = now();
      await repo.transaction(tx => tx.set('jobs', garbageId, { _id: garbageId, kind: 'fileGarbage', fileId, targetId, status: 'pending', createdAt: at }));
      logger.error('trade_private_delete_queued', { targetId });
    }
  }
  async function reservedPut(path, bytes, targetId) {
    const fileId = await storage.reserve(path), reservationId = key(`staged:${fileId}`), at = now();
    await repo.transaction(tx => tx.set('jobs', reservationId, { _id: reservationId, kind: 'fileReservation', status: 'staged', fileId, targetId, expiresAt: at + DAY, createdAt: at }));
    await storage.put(path, bytes, fileId);
    return { fileId, reservationId };
  }
  async function attachReservation(tx, reservationId) {
    const row = await tx.get('jobs', reservationId);
    if (!row || row.kind !== 'fileReservation' || row.status !== 'staged') fail('CONFLICT', '文件封存记录已变化，请重试。');
    await tx.set('jobs', reservationId, { ...row, status: 'attached', attachedAt: now() });
  }
  async function removeUnattached(fileId, reservationId, targetId) {
    // A transaction response can fail after the provider committed it. Never
    // delete an object already atomically attached to a business record.
    let reservation;
    try { reservation = await repo.get('jobs', reservationId); }
    catch (_) { logger.error('trade_staged_file_state_unknown', { targetId }); return; }
    if (reservation && reservation.status === 'attached') return;
    await removeOrQueue(fileId, targetId);
  }
  async function adult(tx, ownId, existing = false) {
    const member = approved(await tx.get('members', ownId), { existing });
    if (!existing) active(member);
    const profile = await tx.get('profiles', ownId);
    if (!existing && (!profile || !profile.adultConfirmedAt || profile.termsVersion !== TERMS_VERSION)) fail('ADULT_CONFIRMATION_REQUIRED', '交易仅向自我确认年满18岁的获准成员开放，请先阅读并确认。');
    return member;
  }
  async function orderFor(orderId, actor, { manage = false } = {}, reader = repo) {
    const order = await reader.get('orders', id(orderId));
    if (!order || order.kind !== 'order') fail('NOT_FOUND', '订单不存在。');
    if (order.buyerId !== actor._id && order.sellerId !== actor._id) {
      if (!manage || actor.status !== 'approved' || actor.role !== 'admin') fail('NOT_FOUND', '订单不存在。');
    }
    return order;
  }
  async function paginate(type, where, cursor, scope, project) {
    const rows = await repo.query(type, { where, cursor: pageCursor(cursor, scope), limit: LIMITS.pageSize + 1 });
    const page = rows.slice(0, LIMITS.pageSize), hasMore = rows.length > LIMITS.pageSize;
    return { items: page.map(project), hasMore, nextCursor: hasMore ? encodeCursor(page[page.length - 1], scope) : null };
  }
  function assertRetention(order) { if (order.evidenceClearing || (order.retentionExpiresAt && order.retentionExpiresAt <= now())) fail('EVIDENCE_CLEARED', '订单私有材料已到期，不再提供访问。'); }
  function catalog(value, pageCount = LIMITS.pages) {
    if (!Array.isArray(value) || value.length < 1 || value.length > 80) fail('INVALID_INPUT', '请确认1–80项目录。');
    return value.map(item => ({ title: str(item.title, 80, '目录标题'), page: integer(item.page, 1, pageCount, '目录页码') }));
  }
  async function requireVersion(versionId, materialId, actor) {
    const version = await repo.get('versions', id(versionId));
    if (!version || version.kind !== 'materialVersion' || version.materialId !== materialId || version.sellerId !== actor) fail('NOT_FOUND', '资料文件版本不存在。');
    return version;
  }
  async function signPrivate(fileId, purpose) {
    if (!fileId || typeof fileId !== 'string') fail('FILE_UNAVAILABLE', '文件暂不可用，请稍后重试。');
    let url;
    try { url = await storage.sign(fileId, 600); } catch (_) { fail('FILE_UNAVAILABLE', '私有文件访问暂不可用，请稍后重试。'); }
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) fail('FILE_UNAVAILABLE', '文件链接暂不可用。');
    return { url, expiresAt: now() + 600000, purpose, signedAt: now(), downloadConfirmed: false };
  }

  async function confirmAdult(e, ownId) {
    if (e.adultConfirmed !== true || e.termsAccepted !== true) fail('INVALID_INPUT', '需确认已满18岁并理解站外付款与资料交易说明。');
    const at = now();
    await repo.transaction(async tx => {
      active(await tx.get('members', ownId));
      const current = await tx.get('profiles', ownId);
      await tx.set('profiles', ownId, { ...current, _id: ownId, kind: 'tradeProfile', adultConfirmedAt: current && current.adultConfirmedAt || at, termsVersion: TERMS_VERSION, updatedAt: at, createdAt: current && current.createdAt || at });
      await audit(tx, ownId, ownId, 'adultConfirmation', 'none', 'confirmed', 1, at);
    });
    return { adultConfirmed: true, termsVersion: TERMS_VERSION };
  }

  async function saveMaterialDraft(e, openid, ownId) {
    const requestId = req(e.requestId);
    const materialId = e.materialId ? id(e.materialId) : key(`material:${ownId}:${requestId}`);
    const title = str(e.title, 60, '资料标题'), course = str(e.course, 60, '课程'), description = str(e.description, 2000, '资料描述', 2);
    if (!MATERIAL_TYPES.includes(e.type)) fail('INVALID_INPUT', '请选择有效资料类型。');
    if (!Array.isArray(e.learningModes) || !e.learningModes.length || e.learningModes.length > LEARNING_MODES.length || e.learningModes.some(mode => !LEARNING_MODES.includes(mode))) fail('INVALID_INPUT', '请选择适合的学习模式。');
    const priceCents = integer(e.priceCents, 0, 1000000, '价格');
    const checkedText = await checked(openid, `${title}\n${course}\n${description}`);
    const at = now();
    return repo.transaction(async tx => {
      await adult(tx, ownId);
      const current = await tx.get('materials', materialId);
      const payloadHash = hash(JSON.stringify([title, course, description, e.type, [...new Set(e.learningModes)], priceCents]));
      if (current && !e.materialId && current.requestId === requestId) { if (current.payloadHash !== payloadHash) fail('REQUEST_CONFLICT', '同一草稿请求内容发生变化。'); return { material: publicMaterial(current) }; }
      if (current) { if (current.sellerId !== ownId) fail('NOT_FOUND', '资料不存在。'); rev(current, e.revision); if (!['draft', 'rejected', 'offline'].includes(current.status)) fail('CONFLICT', '请等待当前提交处理完成或下架后再修改资料内容；旧订单版本保持不变。'); }
      const row = { ...current, _id: materialId, kind: 'material', sellerId: ownId, title, course, description, type: e.type, learningModes: [...new Set(e.learningModes)], priceCents, requestId, payloadHash, status: 'draft', moderation: checkedText, createdAt: current ? current.createdAt : at, updatedAt: at, revision: current ? current.revision + 1 : 1 };
      await tx.set('materials', materialId, row);
      await audit(tx, ownId, materialId, 'saveMaterialDraft', current ? current.status : 'none', 'draft', row.revision, at);
      return { material: publicMaterial(row) };
    });
  }

  async function startPdfUpload(e, ownId) {
    const materialId = id(e.materialId), requestId = req(e.requestId), size = integer(e.size, 1, LIMITS.pdfBytes, 'PDF大小');
    if (typeof e.name !== 'string' || !/\.pdf$/i.test(e.name) || Array.from(e.name).length > 120) fail('INVALID_INPUT', '首轮只接受未加密PDF文件。');
    const uploadId = key(`upload:${ownId}:${requestId}`), at = now();
    return repo.transaction(async tx => {
      await adult(tx, ownId);
      const material = await tx.get('materials', materialId);
      if (!material || material.sellerId !== ownId) fail('NOT_FOUND', '资料不存在。');
      if (!['draft', 'rejected', 'offline'].includes(material.status)) fail('CONFLICT', '请先下架后再替换资料文件。');
      const existing = await tx.get('uploads', uploadId);
      if (existing) { if (existing.materialId !== materialId || existing.size !== size || existing.name !== e.name) fail('REQUEST_CONFLICT', '上传重试的文件已改变，请重新选择文件。'); return { uploadId, chunkBytes: LIMITS.chunkBytes, totalChunks: existing.totalChunks, status: existing.status }; }
      const totalChunks = Math.ceil(size / LIMITS.chunkBytes);
      await tx.set('uploads', uploadId, { _id: uploadId, kind: 'pdfUpload', ownerId: ownId, materialId, name: e.name, size, totalChunks, status: 'uploading', createdAt: at, updatedAt: at, expiresAt: at + DAY, revision: 1 });
      return { uploadId, chunkBytes: LIMITS.chunkBytes, totalChunks, status: 'uploading' };
    });
  }
  async function uploadPdfChunk(e, ownId) {
    const uploadId = id(e.uploadId), index = integer(e.index, 0, 79, '分块位置'), bytes = base64(e.base64, LIMITS.chunkBytes);
    const chunkId = key(`${uploadId}:${index}`), sha256 = hash(bytes), at = now();
    const reserved = await repo.transaction(async tx => {
      await adult(tx, ownId);
      const upload = await tx.get('uploads', uploadId);
      if (!upload || upload.ownerId !== ownId) fail('NOT_FOUND', '上传会话不存在。');
      if (upload.expiresAt <= at) fail('UPLOAD_EXPIRED', '上传已过期，请重新上传。');
      if (upload.status !== 'uploading') fail('CONFLICT', '文件已封存，不能修改分块。');
      const expected = index === upload.totalChunks - 1 ? upload.size - index * LIMITS.chunkBytes : LIMITS.chunkBytes;
      if (index >= upload.totalChunks || bytes.length !== expected) fail('INVALID_INPUT', '分块大小与上传声明不一致。');
      const existing = await tx.get('chunks', chunkId);
      if (existing) {
        if (existing.sha256 !== sha256) fail('REQUEST_CONFLICT', '同一分块内容已改变，请重新上传整个文件。');
        if (existing.status === 'ready') return { existing };
        if (existing.leaseUntil > at) fail('IN_PROGRESS', '分块正在上传，请稍后重试。');
      }
      const token = randomId();
      await tx.set('chunks', chunkId, { _id: chunkId, kind: 'pdfChunk', uploadId, ownerId: ownId, index, sha256, size: bytes.length, status: 'uploading', token, leaseUntil: at + 60000, createdAt: at, expiresAt: upload.expiresAt });
      return { token };
    });
    if (reserved.existing) return { index, status: 'ready', sha256 };
    let fileId, reservationId;
    try { ({ fileId, reservationId } = await reservedPut(`private/trade/chunks/${uploadId}/${index}-${reserved.token}`, bytes, chunkId)); }
    catch (_) { fail('UPLOAD_FAILED', '分块上传失败，可重试，正文仍保留。'); }
    try {
      await repo.transaction(async tx => {
        await adult(tx, ownId);
        const chunk = await tx.get('chunks', chunkId), upload = await tx.get('uploads', uploadId);
        if (!chunk || chunk.token !== reserved.token || !upload || upload.status !== 'uploading' || upload.expiresAt <= now()) fail('CONFLICT', '上传会话已变化，请重试。');
        await attachReservation(tx, reservationId);
        await tx.set('chunks', chunkId, { ...chunk, status: 'ready', fileId, leaseUntil: 0, updatedAt: now() });
      });
    } catch (error) { await removeUnattached(fileId, reservationId, chunkId); throw error; }
    return { index, status: 'ready', sha256 };
  }
  async function finalizePdfUpload(e, ownId) {
    const uploadId = id(e.uploadId), at = now();
    return repo.transaction(async tx => {
      await adult(tx, ownId);
      const upload = await tx.get('uploads', uploadId);
      if (!upload || upload.ownerId !== ownId) fail('NOT_FOUND', '上传会话不存在。');
      if (['queued', 'processing', 'ready', 'failed'].includes(upload.status)) return { uploadId, status: upload.status, jobId: upload.jobId, versionId: upload.versionId || null };
      if (upload.expiresAt <= at) fail('UPLOAD_EXPIRED', '上传已过期，请重新上传。');
      const material = await tx.get('materials', upload.materialId);
      if (!material || material.sellerId !== ownId || !['draft', 'rejected', 'offline'].includes(material.status)) fail('CONFLICT', '资料状态已变化。');
      const chunks = [];
      for (let index = 0; index < upload.totalChunks; index += 1) {
        const chunk = await tx.get('chunks', key(`${uploadId}:${index}`));
        if (!chunk || chunk.status !== 'ready') fail('UPLOAD_INCOMPLETE', '仍有分块未上传完成，请重试失败分块。');
        chunks.push({ index, fileId: chunk.fileId, sha256: chunk.sha256, size: chunk.size });
      }
      const jobId = key(`pdfProcess:${uploadId}`), versionId = key(`version:${uploadId}`);
      await tx.set('jobs', jobId, { _id: jobId, kind: 'fileJob', type: 'processUpload', ownerId: ownId, uploadId, materialId: upload.materialId, versionId, chunks, expectedSize: upload.size, status: 'queued', attempts: 0, createdAt: at, updatedAt: at });
      await tx.set('uploads', uploadId, { ...upload, status: 'queued', jobId, versionId, revision: upload.revision + 1, updatedAt: at });
      return { uploadId, jobId, versionId, status: 'queued' };
    });
  }
  async function getUpload(e, member) {
    const upload = await repo.get('uploads', id(e.uploadId));
    if (!upload || upload.ownerId !== member._id) fail('NOT_FOUND', '上传会话不存在。');
    const chunks = await repo.query('chunks', { where: { uploadId: upload._id, status: 'ready' }, limit: 80 });
    const version = upload.versionId ? await repo.get('versions', upload.versionId) : null;
    return { uploadId: upload._id, status: version && version.status === 'cleared' ? 'expired' : upload.status, totalChunks: upload.totalChunks, uploadedIndices: chunks.map(c => c.index), versionId: upload.versionId || null, pageCount: version ? version.pageCount : null, sha256: version ? version.sha256 : null, suggestedCatalog: version ? version.suggestedCatalog || [] : [], errorCode: version && version.status === 'cleared' ? 'ABANDONED_UPLOAD_EXPIRED' : upload.errorCode || null };
  }
  async function submitMaterial(e, openid, ownId) {
    const materialId = id(e.materialId), versionId = id(e.versionId), at = now();
    if (e.originalConfirmed !== true) fail('INVALID_INPUT', '请确认拥有原创或合法发布权利。');
    const version = await requireVersion(versionId, materialId, ownId);
    if (version.status !== 'processed') fail('FILE_NOT_READY', 'PDF尚未完成处理。');
    const confirmedCatalog = catalog(e.catalog, version.pageCount);
    if (!Array.isArray(e.previewPages) || e.previewPages.length < 1 || e.previewPages.length > 2 || new Set(e.previewPages).size !== e.previewPages.length) fail('INVALID_INPUT', '请选择1–2页试读。');
    const previewPages = e.previewPages.map(p => integer(p, 1, version.pageCount, '试读页码'));
    const material = await repo.get('materials', materialId);
    if (!material || material.sellerId !== ownId) fail('NOT_FOUND', '资料不存在。');
    rev(material, e.revision);
    const safety = await checked(openid, `${material.title}\n${material.course}\n${material.description}\n${confirmedCatalog.map(c => c.title).join('\n')}`);
    return repo.transaction(async tx => {
      await adult(tx, ownId);
      const current = await tx.get('materials', materialId), currentVersion = await tx.get('versions', versionId);
      if (!current || current.sellerId !== ownId) fail('NOT_FOUND', '资料不存在。');
      rev(current, e.revision);
      if (!['draft', 'rejected', 'offline'].includes(current.status) || !currentVersion || currentVersion.status !== 'processed') fail('CONFLICT', '资料已提交或文件版本发生变化。');
      const revision = current.revision + 1, jobId = key(`preview:${versionId}:${revision}`);
      await tx.set('versions', versionId, { ...currentVersion, catalog: confirmedCatalog, previewPages, originalConfirmedAt: at, metadataSnapshot: { title: current.title, description: current.description, course: current.course, type: current.type, learningModes: current.learningModes }, status: 'previewQueued', updatedAt: at });
      await tx.set('jobs', jobId, { _id: jobId, kind: 'fileJob', type: 'preview', materialId, versionId, ownerId: ownId, sourceFileId: currentVersion.sourceFileId, sourceHash: currentVersion.sha256, previewPages, status: 'queued', attempts: 0, createdAt: at, updatedAt: at });
      await tx.set('materials', materialId, { ...current, pendingVersionId: versionId, catalog: confirmedCatalog, pageCount: version.pageCount, status: 'processing', moderation: safety, updatedAt: at, revision });
      await audit(tx, ownId, materialId, 'submitMaterial', current.status, 'processing', revision, at);
      return { materialId, versionId, status: 'processing', revision, jobId };
    });
  }
  async function getMaterial(e, member) {
    const row = await repo.get('materials', id(e.materialId));
    if (!row || (row.status !== 'published' && row.sellerId !== member._id && member.role !== 'admin')) fail('NOT_FOUND', '资料不存在或暂不可查看。');
    const result = { material: { ...publicMaterial(row), isOwner: row.sellerId === member._id }, paidEnabled, matching: matching(row, e.learningMode) };
    if (row.sellerId === member._id || member.role === 'admin') { result.material.reviewReason = row.reviewReason || ''; result.material.pendingVersionId = row.pendingVersionId || null; }
    return result;
  }
  function matching(row, mode) {
    const matched = LEARNING_MODES.includes(mode) && (row.learningModes || []).includes(mode);
    return { source: '资料发布者确认的学习模式标签；规则匹配，非AI分析', matched, reason: matched ? `发布者标记适合“${mode}”。` : '请选择学习模式，结合目录和试读自行判断。', details: ['按学习模式标签比较，不分析学习画像。', '目录与试读可帮助判断章节覆盖。', '匹配不代表质量、成绩或学习效果保证。'] };
  }
  async function reviewMaterial(e, ownId, openid) {
    const materialId = id(e.materialId);
    if (!['approve', 'reject'].includes(e.decision)) fail('INVALID_INPUT', '请选择审核结果。');
    const reason = str(e.reason, 200, '审核说明', 2);
    if (e.decision === 'approve' && (e.copyrightChecked !== true || e.descriptionChecked !== true || e.fullDocumentChecked !== true)) fail('INVALID_INPUT', '需完整核查原文件、发布权利和描述一致性后才能通过。');
    const checkedReason = await checked(openid, reason);
    const material = await repo.get('materials', materialId);
    if (!material || material.status !== 'pending') fail('CONFLICT', '资料已被处理，请刷新。');
    const author = await repo.get('members', material.sellerId);
    let safety;
    if (e.decision === 'approve') { if (!author || !author.openid) fail('AUTHOR_UNAVAILABLE', '发布者身份暂不可用。'); safety = await checked(author.openid, `${material.title}\n${material.course}\n${material.description}\n${(material.catalog || []).map(c => c.title).join('\n')}`, { captureRisky: true }); }
    const at = now();
    const result = await repo.transaction(async tx => {
      admin(await tx.get('members', ownId));
      const current = await tx.get('materials', materialId);
      if (!current || current.status !== 'pending') fail('CONFLICT', '资料已被处理，请刷新。'); rev(current, e.revision);
      const version = await tx.get('versions', current.pendingVersionId);
      if (!version || version.status !== 'pending' || !version.previewFileId || current.moderation.suggestion !== 'pass') fail('FILE_NOT_READY', '文件处理和审核尚未完成。');
      const passed = e.decision === 'approve' && safety.suggestion === 'pass';
      const status = passed ? 'published' : 'rejected', revision = current.revision + 1;
      await tx.set('versions', version._id, { ...version, status: passed ? 'approved' : 'rejected', reviewedAt: at, reviewerId: ownId, updatedAt: at });
      await tx.set('materials', materialId, { ...current, status, currentVersionId: passed ? version._id : current.currentVersionId || null, reviewReason: safety && safety.suggestion === 'risky' ? '内容未通过微信安全审核，不能公开。' : reason, moderation: safety || current.moderation, reviewedAt: at, revision, updatedAt: at });
      await audit(tx, ownId, materialId, 'reviewMaterial', 'pending', status, revision, at);
      const evidenceId = key(`materialReview:${materialId}:${revision}`);
      await tx.set('evidence', evidenceId, { _id: evidenceId, kind: 'materialReview', materialId, versionId: version._id, reason, moderation: checkedReason, reviewerId: ownId, createdAt: at });
      return { materialId, status, revision };
    });
    if (safety && safety.suggestion === 'risky') fail('CONTENT_REJECTED', '内容未通过微信安全审核，已标记拒绝，不能人工绕过。');
    return result;
  }
  async function setMaterialPrice(e, ownId) {
    const materialId = id(e.materialId), priceCents = integer(e.priceCents, 0, 1000000, '价格'), at = now();
    return repo.transaction(async tx => {
      await adult(tx, ownId);
      const material = await tx.get('materials', materialId);
      if (!material || material.sellerId !== ownId) fail('NOT_FOUND', '资料不存在。'); rev(material, e.revision);
      if (material.status === 'held') fail('CONFLICT', '资料正在核查，请等待处理。');
      await tx.set('materials', materialId, { ...material, priceCents, revision: material.revision + 1, updatedAt: at });
      await audit(tx, ownId, materialId, 'setMaterialPrice', 'price', 'price', material.revision + 1, at);
      return { materialId, priceCents, revision: material.revision + 1 };
    });
  }
  async function setMaterialAvailability(e, ownId) {
    const materialId = id(e.materialId), at = now();
    if (!['offline', 'published'].includes(e.status)) fail('INVALID_INPUT', '资料状态无效。');
    return repo.transaction(async tx => {
      await adult(tx, ownId);
      const material = await tx.get('materials', materialId);
      if (!material || material.sellerId !== ownId) fail('NOT_FOUND', '资料不存在。'); rev(material, e.revision);
      const version = material.currentVersionId ? await tx.get('versions', material.currentVersionId) : null;
      if (!['published', 'offline'].includes(material.status) || !version || version.status !== 'approved') fail('CONFLICT', '资料须重新审核，不能直接上架。');
      await tx.set('materials', materialId, { ...material, status: e.status, revision: material.revision + 1, updatedAt: at });
      await audit(tx, ownId, materialId, 'setMaterialAvailability', material.status, e.status, material.revision + 1, at);
      return { materialId, status: e.status, revision: material.revision + 1 };
    });
  }

  async function uploadPrivateImage(e, ownId) {
    if (!['paymentQr', 'paymentProof'].includes(e.purpose)) fail('INVALID_INPUT', '图片用途无效。');
    if (e.purpose === 'paymentQr' && !paidEnabled) fail('PAID_DISABLED', '当前付费未启用，不能配置新的收款信息。');
    const bytes = base64(e.base64, LIMITS.imageBytes), sha256 = hash(bytes);
    let ext;
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ext = 'png';
    else if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) ext = 'jpg';
    else fail('INVALID_INPUT', '只支持压缩后600KiB内的PNG或JPEG图片。');
    const requestId = req(e.requestId), assetId = key(`asset:${ownId}:${e.purpose}:${requestId}`), at = now();
    if (e.purpose === 'paymentProof') {
      const order = await orderFor(e.orderId, { _id: ownId });
      if (order.buyerId !== ownId) fail('FORBIDDEN', '只有买家可以上传付款凭证。');
      assertRetention(order);
    }
    const reservation = await repo.transaction(async tx => {
      if (e.purpose === 'paymentQr') await adult(tx, ownId); else approved(await tx.get('members', ownId), { existing: true });
      const existing = await tx.get('assets', assetId);
      if (existing) { if (existing.sha256 !== sha256 || (existing.orderId || '') !== (e.orderId || '')) fail('REQUEST_CONFLICT', '相同请求的图片内容发生变化。'); if (existing.status === 'ready') return { done: true }; if (existing.leaseUntil > at) fail('IN_PROGRESS', '图片正在上传，请稍后重试。'); }
      const token = randomId();
      await tx.set('assets', assetId, { _id: assetId, kind: 'privateImage', ownerId: ownId, purpose: e.purpose, orderId: e.orderId || null, sha256, size: bytes.length, status: 'uploading', token, leaseUntil: at + 60000, createdAt: at, expiresAt: at + DAY });
      return { token };
    });
    if (reservation.done) return { assetId, status: 'ready' };
    let fileId, reservationId;
    try { ({ fileId, reservationId } = await reservedPut(`private/trade/images/${assetId}/${reservation.token}.${ext}`, bytes, assetId)); }
    catch (_) { fail('UPLOAD_FAILED', '图片上传失败，请重试。'); }
    try {
      await repo.transaction(async tx => {
        const row = await tx.get('assets', assetId);
        if (!row || row.token !== reservation.token || row.expiresAt <= now()) fail('CONFLICT', '上传已变化，请重试。');
        await attachReservation(tx, reservationId);
        await tx.set('assets', assetId, { ...row, fileId, status: 'ready', leaseUntil: 0 });
      });
    } catch (error) { await removeUnattached(fileId, reservationId, assetId); throw error; }
    return { assetId, status: 'ready' };
  }
  async function setPaymentQr(e, ownId) {
    if (!paidEnabled) fail('PAID_DISABLED', '当前付费未启用，不能配置新的收款信息。');
    const assetId = id(e.assetId), at = now();
    return repo.transaction(async tx => {
      await adult(tx, ownId);
      const asset = await tx.get('assets', assetId);
      if (!asset || asset.ownerId !== ownId || asset.purpose !== 'paymentQr' || asset.status !== 'ready' || (!asset.retained && asset.expiresAt <= at)) fail('NOT_FOUND', '收款码未完成上传或已过期。');
      const profile = await tx.get('profiles', ownId);
      await tx.set('profiles', ownId, { ...profile, paymentQrAssetId: assetId, updatedAt: at });
      await tx.set('assets', assetId, { ...asset, retained: true, expiresAt: null });
      await audit(tx, ownId, ownId, 'setPaymentQr', 'configured', 'configured', at, at);
      return { configured: true };
    });
  }
  function sellerServiceFee(e, member) {
    active(member);
    // Compute in cents and round half up at the smallest currency unit.
    const expectedSalesCents = integer(e.expectedSalesCents, 10, 100000000, '预计成交额');
    const feeCents = Math.floor((expectedSalesCents * SELLER_SERVICE_FEE_BPS + 5000) / 10000);
    return { quote: { expectedSalesCents, feeCents, rateBps: SELLER_SERVICE_FEE_BPS, currency: 'CNY' },
      sellerFeeCheckoutAvailable: !!sellerFeePayment?.product(feeCents) };
  }

  async function startSellerFeeCheckout(e, member, openid) {
    const { quote, sellerFeeCheckoutAvailable } = sellerServiceFee(e, member);
    if (!sellerFeeCheckoutAvailable) fail('SELLER_FEE_UNAVAILABLE', '该金额的微信付款暂未开放。');
    const requestId = req(e.requestId), code = str(e.code, 128, '微信登录凭证');
    const orderId = key(`sellerFee:${member._id}:${requestId}`), at = now();
    const order = await repo.transaction(async tx => {
      await adult(tx, member._id);
      const existing = await tx.get('orders', orderId);
      if (existing) {
        if (existing.expectedSalesCents !== quote.expectedSalesCents) fail('REQUEST_CONFLICT', '报价已变化，请重新计算。');
        return existing;
      }
      const row = { ...quote, _id: orderId, kind: 'sellerServiceFee', sellerId: member._id, productId: sellerFeePayment.product(quote.feeCents), status: 'pending', createdAt: at, updatedAt: at };
      await tx.set('orders', orderId, row);
      return row;
    });
    if (order.status !== 'pending') return { orderId, status: order.status };
    return { orderId, status: order.status, payment: await sellerFeePayment.checkout(order, code, openid) };
  }
  async function checkSellerFeePayment(e, ownId, openid) {
    const orderId = id(e.orderId);
    const order = await repo.get('orders', orderId);
    if (!order || order.kind !== 'sellerServiceFee' || order.sellerId !== ownId) fail('NOT_FOUND', '服务费订单不存在。');
    if (!sellerFeePayment) return { orderId, status: order.status };
    const payment = await sellerFeePayment.query(orderId, openid);
    const status = [5, 8].includes(payment.status) ? 'refunded'
      : payment.status === 6 ? 'closed'
        : [2, 3, 4].includes(payment.status) && payment.order_fee === order.feeCents && payment.paid_fee === order.feeCents ? 'paid' : null;
    return repo.transaction(async tx => {
      const current = await tx.get('orders', orderId);
      const next = current.status === 'refunded' || !status || (current.status === 'paid' && status === 'closed') ? current.status : status;
      if (next !== current.status) await tx.set('orders', orderId, { ...current, status: next, updatedAt: now() });
      return { orderId, status: next };
    });
  }

  async function createOrder(e, ownId) {
    const materialId = id(e.materialId), requestId = req(e.requestId), orderId = key(`order:${ownId}:${requestId}`), at = now();
    return repo.transaction(async tx => {
      await adult(tx, ownId);
      const existing = await tx.get('orders', orderId);
      if (existing) { if (existing.materialId !== materialId) fail('REQUEST_CONFLICT', '订单重试的资料发生变化。'); return { order: publicOrder(existing, { _id: ownId }, at) }; }
      const material = await tx.get('materials', materialId);
      if (!material || material.status !== 'published') fail('NOT_FOR_SALE', '资料暂未上架或正在核查。');
      if (material.sellerId === ownId) fail('INVALID_INPUT', '不能购买自己发布的资料，可在管理页查看。');
      if (material.priceCents > 0 && !paidEnabled) fail('PAID_DISABLED', '付费交易尚未启用；平台规则确认后再开放。');
      const seller = await tx.get('members', material.sellerId); active(seller);
      const version = await tx.get('versions', material.currentVersionId);
      if (!version || version.status !== 'approved' || !version.sha256 || !version.sourceFileId) fail('FILE_NOT_READY', '资料文件暂不可用。');
      const entitlementId = key(`entitlement:${ownId}:${version._id}`), entitlement = await tx.get('entitlements', entitlementId);
      if (entitlement && entitlement.status === 'active') return { alreadyOwned: true, orderId: entitlement.orderId, entitlementId };
      if (entitlement && entitlement.status === 'reserved') {
        const originalOrder = await tx.get('orders', entitlement.orderId);
        if (originalOrder && ['awaitingPayment', 'awaitingSeller'].includes(originalOrder.status)) return { alreadyPending: true, orderId: originalOrder._id, order: publicOrder(originalOrder, { _id: ownId }, at) };
      }
      const sellerProfile = await tx.get('profiles', material.sellerId);
      let paymentQr = null;
      if (material.priceCents > 0) {
        const asset = sellerProfile && sellerProfile.paymentQrAssetId && await tx.get('assets', sellerProfile.paymentQrAssetId);
        if (!asset || asset.status !== 'ready' || asset.purpose !== 'paymentQr' || asset.ownerId !== material.sellerId) fail('PAYMENT_UNAVAILABLE', '卖家尚未配置可用收款信息。');
        paymentQr = { assetId: asset._id, fileId: asset.fileId, sha256: asset.sha256 };
      }
      const row = { _id: orderId, kind: 'order', buyerId: ownId, sellerId: material.sellerId, materialId, versionId: version._id, sourceHash: version.sha256, title: material.title, description: material.description, catalog: version.catalog, priceCents: material.priceCents, paymentQr, paymentQrAssetId: paymentQr ? paymentQr.assetId : null, status: material.priceCents === 0 ? 'deliverable' : 'awaitingPayment', deliveryStatus: material.priceCents === 0 ? 'queued' : 'none', buyerAlias: `Reader-${randomBytes(5).toString('hex')}`, shortId: randomBytes(4).toString('hex').toUpperCase(), createdAt: at, updatedAt: at, revision: 1, afterSaleOpen: false };
      await tx.set('orders', orderId, row);
      if (row.priceCents === 0) await grantEntitlement(tx, row, version, at);
      else await tx.set('entitlements', entitlementId, { _id: entitlementId, kind: 'entitlement', buyerId: ownId, orderId, materialId, versionId: version._id, sourceHash: version.sha256, status: 'reserved', createdAt: at, updatedAt: at });
      await audit(tx, ownId, orderId, 'createOrder', 'none', row.status, 1, at);
      return { order: publicOrder(row, { _id: ownId }, at) };
    });
  }
  async function grantEntitlement(tx, order, version, at) {
    const entitlementId = key(`entitlement:${order.buyerId}:${version._id}`), existing = await tx.get('entitlements', entitlementId);
    if (existing && existing.orderId !== order._id) {
      const previous = existing.status === 'reserved' ? await tx.get('orders', existing.orderId) : null;
      if (existing.status !== 'reserved' || !previous || previous.status !== 'cancelled') fail('ALREADY_OWNED', '已有同一版本的购买记录，请返回原订单处理。');
    }
    const jobId = key(`watermark:${order._id}`);
    await tx.set('entitlements', entitlementId, { _id: entitlementId, kind: 'entitlement', buyerId: order.buyerId, orderId: order._id, materialId: order.materialId, versionId: version._id, sourceHash: version.sha256, status: 'active', createdAt: at, updatedAt: at });
    await tx.set('jobs', jobId, { _id: jobId, kind: 'fileJob', type: 'watermark', orderId: order._id, materialId: order.materialId, versionId: version._id, ownerId: order.buyerId, sourceFileId: version.sourceFileId, sourceHash: version.sha256, buyerAlias: order.buyerAlias, shortId: order.shortId, status: 'queued', attempts: 0, createdAt: at, updatedAt: at });
  }
  async function getOrder(e, member) {
    const order = await orderFor(e.orderId, member, { manage: true }), result = { order: publicOrder(order, member, now()) };
    if (member._id === order.buyerId && order.priceCents > 0 && order.status !== 'completed') {
      assertRetention(order);
      result.paymentNotice = '站外付款可能在微信转账页显示双方身份。凭证仅是买家提交材料，不代表到账。平台不代收、不垫付、不裁决款项。';
      result.canViewPaymentQr = !!order.paymentQr && !order.evidenceCleared;
    }
    return result;
  }
  async function getPaymentQr(e, member) {
    const order = await orderFor(e.orderId, member);
    if (order.buyerId !== member._id) fail('FORBIDDEN', '仅该订单买家可查看收款码。');
    assertRetention(order);
    if (!order.paymentQr || !['awaitingPayment', 'awaitingSeller', 'cancelled'].includes(order.status)) fail('NOT_FOUND', '当前订单没有可用收款码。');
    const signed = await signPrivate(order.paymentQr.fileId, 'orderPaymentQr');
    return repo.transaction(async tx => {
      const actor = approved(await tx.get('members', member._id), { existing: true });
      const current = await orderFor(e.orderId, actor, {}, tx); assertRetention(current);
      if (current.buyerId !== actor._id) fail('FORBIDDEN', '仅该订单买家可查看收款码。');
      if (!current.paymentQr || current.paymentQr.fileId !== order.paymentQr.fileId || !['awaitingPayment', 'awaitingSeller', 'cancelled'].includes(current.status)) fail('CONFLICT', '订单状态已变化，请刷新后查看收款信息。');
      return signed;
    });
  }
  async function submitPaymentProof(e, ownId, openid) {
    const orderId = id(e.orderId), requestId = req(e.requestId), assetId = id(e.assetId), transferReference = str(e.transferReference, 80, '转账单号', 2), note = e.note ? str(e.note, 200, '补充说明', 2) : '';
    await checked(openid, `${transferReference}\n${note}`);
    const at = now(), submissionHash = hash(JSON.stringify([assetId, transferReference, note]));
    return repo.transaction(async tx => {
      approved(await tx.get('members', ownId), { existing: true });
      const order = await tx.get('orders', orderId);
      if (!order || order.buyerId !== ownId) fail('NOT_FOUND', '订单不存在。');
      if (order.priceCents === 0) fail('INVALID_INPUT', '免费资料无需付款凭证。');
      if (order.proofRequestId === requestId) { if (order.proofHash !== submissionHash) fail('REQUEST_CONFLICT', '同一凭证请求内容发生变化。'); return { order: publicOrder(order, { _id: ownId }, at) }; }
      rev(order, e.revision);
      assertRetention(order);
      const late = order.status === 'cancelled' || (order.status === 'awaitingPayment' && at - order.createdAt >= 48 * HOUR);
      if (late && e.latePaymentAcknowledged !== true) fail('LATE_PAYMENT', '订单已取消或超时。确认仅保存迟到付款材料后可提交，不会恢复订单或开放文件，请申请人工协调。');
      if ((!late && order.status !== 'awaitingPayment') || order.proofEvidenceId) fail('CONFLICT', '订单已提交凭证或状态已变化。');
      const asset = await tx.get('assets', assetId);
      if (!asset || asset.status !== 'ready' || asset.ownerId !== ownId || asset.orderId !== orderId || asset.purpose !== 'paymentProof' || asset.expiresAt <= at) fail('INVALID_INPUT', '凭证图片未完成上传或已过期。');
      const evidenceId = key(`proof:${orderId}:${requestId}`);
      await tx.set('evidence', evidenceId, { _id: evidenceId, kind: 'paymentProof', orderId, evidenceEpoch: evidenceEpoch(order), buyerId: ownId, assetId, fileId: asset.fileId, transferReference, note, createdAt: at });
      await tx.set('assets', assetId, { ...asset, retained: true, expiresAt: null });
      const updated = { ...order, proofEvidenceId: evidenceId, proofRequestId: requestId, proofHash: submissionHash, status: late ? 'cancelled' : 'awaitingSeller', ...(late ? { cancelledAt: order.cancelledAt || at, retentionExpiresAt: order.afterSaleOpen ? null : order.retentionExpiresAt || at + RETENTION_DAYS * DAY, latePaymentEvidence: true } : {}), submittedAt: at, revision: order.revision + 1, updatedAt: at };
      await tx.set('orders', orderId, updated);
      await audit(tx, ownId, orderId, late ? 'recordLatePaymentProof' : 'submitPaymentProof', order.status, updated.status, updated.revision, at);
      return { order: publicOrder(updated, { _id: ownId }, at), latePayment: late, notice: late ? '迟到付款材料已私有保存，订单仍已取消，不会开放文件。请申请人工协调。' : '凭证已提交；尚未认定卖家到账。' };
    });
  }
  async function getPaymentProof(e, member) {
    const order = await orderFor(e.orderId, member, { manage: true }); assertRetention(order);
    const proof = order.proofEvidenceId && await repo.get('evidence', order.proofEvidenceId);
    if (!proof || privateContentExpired(order, proof, now())) fail('NOT_FOUND', '当前没有可查看的凭证。');
    const signed = await signPrivate(proof.fileId, 'orderPaymentProof');
    return repo.transaction(async tx => {
      const actor = approved(await tx.get('members', member._id), { existing: true });
      const current = await orderFor(e.orderId, actor, { manage: true }, tx); assertRetention(current);
      const currentProof = current.proofEvidenceId && await tx.get('evidence', current.proofEvidenceId);
      if (current.proofEvidenceId !== proof._id || !currentProof || currentProof.fileId !== proof.fileId || privateContentExpired(current, currentProof, now())) fail('CONFLICT', '订单凭证已变化，请刷新。');
      return { transferReference: currentProof.transferReference, note: currentProof.note || '', ...signed, notice: '买家提交材料，不代表到账。' };
    });
  }
  async function confirmReceipt(e, ownId) {
    if (e.receiptConfirmed !== true || e.deliveryUnderstood !== true) fail('INVALID_INPUT', '仅卖家本人核对真实到账，并确认将开放文件后才能继续。');
    const orderId = id(e.orderId), requestId = req(e.requestId), at = now();
    return repo.transaction(async tx => {
      approved(await tx.get('members', ownId), { existing: true });
      const order = await tx.get('orders', orderId);
      if (!order || order.sellerId !== ownId) fail('FORBIDDEN', '只有订单卖家本人可以确认到账，管理员不能代确认。');
      if (order.receiptRequestId === requestId && ['deliverable', 'completed'].includes(order.status)) return { order: publicOrder(order, { _id: ownId }, at) };
      rev(order, e.revision);
      if (order.status !== 'awaitingSeller') fail('CONFLICT', '订单当前不能确认到账，请刷新。');
      const material = await tx.get('materials', order.materialId), version = await tx.get('versions', order.versionId);
      if (!material || material.status === 'held' || !version || version.status !== 'approved' || version.sha256 !== order.sourceHash) fail('DELIVERY_HELD', '资料正在核查或文件版本不可用，暂不能开放交付。');
      await grantEntitlement(tx, order, version, at);
      const updated = { ...order, status: 'deliverable', deliveryStatus: 'queued', receiptRequestId: requestId, receiptConfirmedAt: at, revision: order.revision + 1, updatedAt: at };
      await tx.set('orders', orderId, updated);
      await audit(tx, ownId, orderId, 'sellerConfirmReceipt', 'awaitingSeller', 'deliverable', updated.revision, at);
      return { order: publicOrder(updated, { _id: ownId }, at) };
    });
  }
  async function cancelOrder(e, ownId) {
    const orderId = id(e.orderId), at = now();
    return repo.transaction(async tx => {
      approved(await tx.get('members', ownId), { existing: true });
      const order = await tx.get('orders', orderId);
      if (!order || order.buyerId !== ownId) fail('NOT_FOUND', '订单不存在。');
      if (order.status === 'cancelled') return { order: publicOrder(order, { _id: ownId }, at) };
      rev(order, e.revision);
      if (order.status !== 'awaitingPayment') fail('CONFLICT', '凭证已提交，不能直接取消。请通过售后协调处理。');
      const updated = { ...order, status: 'cancelled', cancelledAt: at, revision: order.revision + 1, updatedAt: at, retentionExpiresAt: at + RETENTION_DAYS * DAY };
      await tx.set('orders', orderId, updated);
      await audit(tx, ownId, orderId, 'cancelOrder', order.status, 'cancelled', updated.revision, at);
      return { order: publicOrder(updated, { _id: ownId }, at) };
    });
  }
  async function claimOrder(e, ownId) {
    if (e.termsAccepted !== true) fail('CLAIM_NOTICE_REQUIRED', '请确认首次领取起7天完成与内容售后期限；技术交付问题可持续报修。');
    const orderId = id(e.orderId), at = now();
    const initial = await repo.get('orders', orderId);
    if (!initial || initial.buyerId !== ownId) fail('NOT_FOUND', '订单不存在。');
    const initialMaterial = await repo.get('materials', initial.materialId);
    if (!['deliverable', 'completed'].includes(initial.status)) fail('NOT_ENTITLED', '订单尚未取得领取权益。');
    if (!initialMaterial || initialMaterial.status === 'held') fail('DELIVERY_HELD', '资料正在核查，暂停新的文件签发。');
    if (initial.deliveryStatus !== 'ready' || !initial.watermarkedFileId || initial.watermarkSourceHash !== initial.sourceHash) fail(initial.deliveryStatus === 'failed' ? 'DELIVERY_FAILED' : 'DELIVERY_PROCESSING', '专属副本尚未生成成功，领取期限尚未开始。');
    // Signing failure must not start the user's seven-day window. The URL is only
    // returned after the following transaction revalidates the current entitlement/hold.
    const signed = await signPrivate(initial.watermarkedFileId, 'watermarkedDelivery');
    const result = await repo.transaction(async tx => {
      approved(await tx.get('members', ownId), { existing: true });
      const order = await tx.get('orders', orderId);
      if (!order || order.buyerId !== ownId) fail('NOT_FOUND', '订单不存在。');
      if (!['deliverable', 'completed'].includes(order.status)) fail('NOT_ENTITLED', '订单尚未取得领取权益。');
      const entitlement = await tx.get('entitlements', key(`entitlement:${ownId}:${order.versionId}`));
      const material = await tx.get('materials', order.materialId), version = await tx.get('versions', order.versionId);
      if (!entitlement || entitlement.status !== 'active' || entitlement.orderId !== orderId || !version || version.status !== 'approved') fail('NOT_ENTITLED', '领取权益暂不可用。');
      if (!material || material.status === 'held') fail('DELIVERY_HELD', '资料版权或安全核查中，暂停新的文件签发。已下载文件无法远程收回，旧短链接有短暂失效延迟。');
      if (order.deliveryStatus !== 'ready' || !order.watermarkedFileId || order.watermarkSourceHash !== order.sourceHash) fail(order.deliveryStatus === 'failed' ? 'DELIVERY_FAILED' : 'DELIVERY_PROCESSING', '专属副本尚未生成成功，领取期限尚未开始，可稍后重试。');
      if (order.watermarkedFileId !== initial.watermarkedFileId) fail('CONFLICT', '专属副本已更新，请重新领取。');
      const firstClaimAt = order.firstClaimAt || at, updated = { ...order, firstClaimAt, lastClaimAt: at, deliveryCredentialExpiresAt: at + 7 * DAY, updatedAt: at, revision: order.revision + 1 };
      await tx.set('orders', orderId, updated);
      await audit(tx, ownId, orderId, order.firstClaimAt ? 'renewDeliveryCredential' : 'firstClaim', order.status, order.status, updated.revision, at);
      return { fileId: order.watermarkedFileId, order: publicOrder(updated, { _id: ownId }, at), credentialExpiresAt: updated.deliveryCredentialExpiresAt };
    });
    return { order: result.order, credentialExpiresAt: result.credentialExpiresAt, ...signed, notice: '链接签发不表示已下载成功；重领不重置首次领取和售后期限。' };
  }
  async function retryDelivery(e, ownId) {
    const orderId = id(e.orderId), at = now();
    return repo.transaction(async tx => {
      approved(await tx.get('members', ownId), { existing: true });
      const order = await tx.get('orders', orderId);
      if (!order || order.buyerId !== ownId) fail('NOT_FOUND', '订单不存在。');
      const job = await tx.get('jobs', key(`watermark:${orderId}`));
      if (!job || job.status !== 'failed') fail('CONFLICT', '任务仍在处理中或已经成功。');
      if (job.attempts >= 3) fail('RETRY_LIMIT', '已达到自动重试上限，请提交技术交付报修。');
      await tx.set('jobs', job._id, { ...job, status: 'queued', errorCode: null, updatedAt: at });
      await tx.set('orders', orderId, { ...order, deliveryStatus: 'queued', revision: order.revision + 1, updatedAt: at });
      return { status: 'queued' };
    });
  }
  async function completeOrder(e, ownId) {
    const orderId = id(e.orderId), at = now();
    return repo.transaction(async tx => {
      approved(await tx.get('members', ownId), { existing: true });
      const order = await tx.get('orders', orderId);
      if (!order || order.buyerId !== ownId) fail('NOT_FOUND', '订单不存在。');
      if (order.status === 'completed') return { order: publicOrder(order, { _id: ownId }, at) };
      rev(order, e.revision);
      if (order.status !== 'deliverable' || !order.firstClaimAt || order.afterSaleOpen) fail('CONFLICT', '请先领取文件并结清售后后再确认完成。');
      const updated = { ...order, status: 'completed', completedAt: at, retentionExpiresAt: at + RETENTION_DAYS * DAY, revision: order.revision + 1, updatedAt: at };
      await tx.set('orders', orderId, updated); await audit(tx, ownId, orderId, 'buyerComplete', order.status, updated.status, updated.revision, at);
      return { order: publicOrder(updated, { _id: ownId }, at) };
    });
  }

  async function sendOrderMessage(e, ownId, openid) {
    const orderId = id(e.orderId), requestId = req(e.requestId), content = str(e.content, 500, '留言'), messageId = key(`message:${ownId}:${orderId}:${requestId}`);
    const actor = await repo.get('members', ownId), order = await orderFor(orderId, actor, { manage: true }); assertRetention(order);
    await checked(openid, content); const at = now();
    return repo.transaction(async tx => {
      const currentActor = approved(await tx.get('members', ownId), { existing: true }), current = await tx.get('orders', orderId);
      if (!current || (current.buyerId !== ownId && current.sellerId !== ownId && !(currentActor.status === 'approved' && currentActor.role === 'admin'))) fail('FORBIDDEN', '没有订单访问权限。'); assertRetention(current);
      const existing = await tx.get('messages', messageId);
      if (existing) { if (existing.contentHash !== hash(content)) fail('REQUEST_CONFLICT', '同一留言请求内容发生变化。'); return { messageId, status: 'sent' }; }
      const speaker = current.buyerId === ownId ? 'buyer' : current.sellerId === ownId ? 'seller' : 'admin';
      await tx.set('messages', messageId, { _id: messageId, kind: 'orderMessage', orderId, evidenceEpoch: evidenceEpoch(current), authorId: ownId, speaker, content, contentHash: hash(content), createdAt: at });
      await audit(tx, ownId, orderId, 'orderMessage', 'none', 'sent', messageId, at);
      return { messageId, status: 'sent' };
    });
  }
  async function listOrderMessages(e, member) {
    const order = await orderFor(e.orderId, member, { manage: true }); assertRetention(order);
    return paginate('messages', { orderId: order._id, kind: 'orderMessage' }, e.cursor, `messages:${order._id}`, row => ({ _id: row._id, speaker: row.speaker, content: privateContentExpired(order, row, now()) ? '' : row.content, createdAt: row.createdAt, cleared: privateContentExpired(order, row, now()) }));
  }
  async function openAfterSale(e, ownId, openid) {
    const orderId = id(e.orderId), requestId = req(e.requestId), type = e.type, description = str(e.description, 1000, '事实说明', 2);
    if (!AFTER_SALE_TYPES.includes(type)) fail('INVALID_INPUT', '请选择售后类别。');
    await checked(openid, description); const at = now(), caseId = key(`afterSale:${orderId}:${requestId}`), payloadHash = hash(JSON.stringify([type, description]));
    return repo.transaction(async tx => {
      approved(await tx.get('members', ownId), { existing: true });
      const order = await tx.get('orders', orderId);
      if (!order || order.buyerId !== ownId) fail('NOT_FOUND', '订单不存在。');
      const existing = await tx.get('afterSales', caseId);
      if (existing) { if (existing.payloadHash !== payloadHash) fail('REQUEST_CONFLICT', '同一售后请求内容发生变化。'); return { caseId, status: existing.status }; }
      if (order.afterSaleOpen) fail('CONFLICT', '已有未结售后，请在原记录补充说明。');
      if (order.evidenceClearing) fail('IN_PROGRESS', '历史证据正在到期清理，请稍后重新提交技术报修。');
      const technical = type === '技术交付问题', latePayment = type === '迟到付款';
      if (technical && !['deliverable', 'completed'].includes(order.status)) fail('NOT_ENTITLED', '取得文件交付权益后可申请技术报修；迟到付款请使用对应协调入口。');
      if (latePayment && order.status !== 'cancelled' && !(order.status === 'awaitingPayment' && at - order.createdAt >= 48 * HOUR)) fail('INVALID_INPUT', '当前不是迟到付款订单。');
      if (!latePayment && !technical && order.status === 'awaitingSeller' && at - order.submittedAt < 72 * HOUR) fail('INTERVENTION_NOT_DUE', '提交凭证72小时后可申请介入，可先向卖家留言。');
      if (!technical && !latePayment && order.firstClaimAt && at >= order.firstClaimAt + 7 * DAY) fail('AFTER_SALE_WINDOW_CLOSED', '普通内容售后期限已结束；技术交付问题仍可报修。');
      if (!latePayment && !technical && !['awaitingSeller', 'deliverable', 'completed'].includes(order.status)) fail('INVALID_INPUT', '当前订单暂不能申请此类售后。');
      // A later technical repair cannot revive the preceding, already-expired
      // evidence. Close its privacy epoch before saving any new free content.
      const expired = !!(order.retentionExpiresAt && order.retentionExpiresAt <= at);
      const epoch = evidenceEpoch(order) + (expired ? 1 : 0);
      const expiredThrough = expired ? Math.max(order.evidenceExpiredThroughEpoch || 0, evidenceEpoch(order)) : order.evidenceExpiredThroughEpoch || 0;
      await tx.set('afterSales', caseId, { _id: caseId, kind: 'afterSale', orderId, evidenceEpoch: epoch, buyerId: order.buyerId, sellerId: order.sellerId, type, description, payloadHash, status: 'open', revision: 1, createdAt: at, updatedAt: at });
      await tx.set('orders', orderId, { ...order, evidenceEpoch: epoch, evidenceExpiredThroughEpoch: expiredThrough, ...(expired ? { paymentQr: null, paymentQrAssetId: null, proofEvidenceId: null, proofHash: null } : {}), afterSaleOpen: true, retentionExpiresAt: null, evidenceCleared: false, revision: order.revision + 1, updatedAt: at });
      await audit(tx, ownId, caseId, 'openAfterSale', 'none', 'open', 1, at);
      return { caseId, status: 'open', notice: '平台记录事实并人工协调，不代退款、不裁决钱款。' };
    });
  }
  async function getAfterSale(e, member) {
    const row = await repo.get('afterSales', id(e.caseId));
    if (!row) fail('NOT_FOUND', '售后记录不存在。');
    const order = await orderFor(row.orderId, member, { manage: true });
    const expired = privateContentExpired(order, row, now());
    return { afterSale: { _id: row._id, orderId: row.orderId, type: row.type, status: row.status, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt, description: expired || row.clearedAt ? '' : row.description, coordination: expired || row.clearedAt ? '' : row.coordination || '', contentCleared: !!expired || !!row.clearedAt, result: row.result || null, notice: '协调记录不代表平台确认退款到账。' } };
  }
  async function listOrderAfterSales(e, member) {
    const order = await orderFor(e.orderId, member, { manage: true });
    return paginate('afterSales', { kind: 'afterSale', orderId: order._id }, e.cursor, `orderAfterSales:${order._id}`, row => ({ _id: row._id, orderId: row.orderId, type: row.type, status: row.status, result: row.result || null, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt, contentCleared: privateContentExpired(order, row, now()) }));
  }
  async function resolveAfterSale(e, ownId, openid) {
    const caseId = id(e.caseId), coordination = str(e.coordination, 1000, '核查与协调记录', 2);
    if (!['coordinated', 'unresolved', 'technicalFixed', 'statementsRecorded'].includes(e.result)) fail('INVALID_INPUT', '请选择事实处理结果。');
    await checked(openid, coordination); const at = now();
    return repo.transaction(async tx => {
      admin(await tx.get('members', ownId));
      const row = await tx.get('afterSales', caseId);
      if (!row || row.status !== 'open') fail('CONFLICT', '售后已被处理，请刷新。'); rev(row, e.revision);
      const order = await tx.get('orders', row.orderId);
      if (!order) fail('NOT_FOUND', '订单不存在。');
      await tx.set('afterSales', caseId, { ...row, status: 'closed', result: e.result, coordination, closedAt: at, updatedAt: at, revision: row.revision + 1 });
      await tx.set('orders', order._id, { ...order, afterSaleOpen: false, afterSaleClosedAt: at, retentionExpiresAt: ['completed', 'cancelled'].includes(order.status) ? Math.max(order.completedAt || order.cancelledAt || at, at) + RETENTION_DAYS * DAY : null, updatedAt: at, revision: order.revision + 1 });
      await audit(tx, ownId, caseId, 'resolveAfterSale', 'open', 'closed', row.revision + 1, at);
      return { caseId, status: 'closed', notice: '仅记录协调结果，不宣称退款已经到账。' };
    });
  }
  async function reportMaterial(e, ownId, openid) {
    const materialId = id(e.materialId), reason = str(e.reason, 200, '投诉事实', 2); req(e.requestId);
    const complaintId = key(`complaint:${ownId}:${materialId}`);
    await checked(openid, reason); const at = now();
    return repo.transaction(async tx => {
      approved(await tx.get('members', ownId));
      const existing = await tx.get('complaints', complaintId);
      if (existing) return { complaintId, status: existing.status, duplicate: true };
      const material = await tx.get('materials', materialId);
      if (!material || !material.currentVersionId) fail('NOT_FOUND', '资料暂不可投诉。');
      await tx.set('complaints', complaintId, { _id: complaintId, kind: 'materialComplaint', materialId, reporterId: ownId, versionId: material.currentVersionId, reason, status: 'open', revision: 1, createdAt: at, updatedAt: at });
      await tx.set('materials', materialId, { ...material, status: 'held', holdFromStatus: material.holdFromStatus || material.status, openComplaintCount: (material.openComplaintCount || 0) + 1, revision: material.revision + 1, updatedAt: at });
      await audit(tx, ownId, complaintId, 'reportMaterial', 'none', 'open', 1, at);
      return { complaintId, status: 'open', notice: '资料已暂停新售卖和文件签发，等待管理员核查。' };
    });
  }
  async function resolveMaterialComplaint(e, ownId, openid) {
    const complaintId = id(e.complaintId), reason = str(e.reason, 200, '核查说明', 2);
    if (!['restore', 'restrict'].includes(e.decision)) fail('INVALID_INPUT', '请选择处理结果。');
    await checked(openid, reason); const at = now();
    return repo.transaction(async tx => {
      admin(await tx.get('members', ownId));
      const complaint = await tx.get('complaints', complaintId);
      if (!complaint || complaint.status !== 'open') fail('CONFLICT', '投诉已被处理。'); rev(complaint, e.revision);
      const material = await tx.get('materials', complaint.materialId);
      if (!material || material.status !== 'held') fail('CONFLICT', '资料状态已变化。');
      // Restoration requires an explicit all-open-complaints check in the same transaction.
      // A per-material counter prevents one resolved complaint from hiding another open one.
      const openCount = material.openComplaintCount || 1, left = Math.max(0, openCount - 1);
      // A replaced draft/pending file cannot become publicly sellable merely
      // because a complaint against its previous approved version was closed.
      const restoredStatus = ['draft', 'rejected', 'offline', 'published', 'pending'].includes(material.holdFromStatus) ? material.holdFromStatus : 'offline';
      const status = e.decision === 'restore' && left === 0 && !material.restrictionConfirmed ? restoredStatus : 'held';
      await tx.set('complaints', complaintId, { ...complaint, status: 'closed', decision: e.decision, resolution: reason, closedAt: at, updatedAt: at, revision: complaint.revision + 1 });
      await tx.set('materials', material._id, { ...material, status, openComplaintCount: left, restrictionConfirmed: material.restrictionConfirmed || e.decision === 'restrict', updatedAt: at, revision: material.revision + 1 });
      await audit(tx, ownId, complaintId, 'resolveMaterialComplaint', 'open', e.decision, complaint.revision + 1, at);
      return { complaintId, status: 'closed', materialStatus: status };
    });
  }
  async function submitFeedback(e, ownId) {
    const orderId = id(e.orderId); if (!FEEDBACK.includes(e.feedback)) fail('INVALID_INPUT', '请选择有效反馈。');
    const at = now();
    return repo.transaction(async tx => {
      approved(await tx.get('members', ownId), { existing: true });
      const order = await tx.get('orders', orderId);
      if (!order || order.buyerId !== ownId || !order.firstClaimAt || !['deliverable', 'completed'].includes(order.status)) fail('NOT_ENTITLED', '领取资料后可提交反馈。');
      assertRetention(order);
      const feedbackId = key(`feedback:${orderId}`);
      await tx.set('evidence', feedbackId, { _id: feedbackId, kind: 'privateFeedback', orderId, evidenceEpoch: evidenceEpoch(order), feedback: e.feedback, createdAt: at });
      return { saved: true, notice: '反馈私有保存，不计入信用分或销量榜。' };
    });
  }
  async function privatePdf(e, member) {
    const version = await repo.get('versions', id(e.versionId));
    if (!version) fail('NOT_FOUND', '文件版本不存在。');
    if (version.sellerId !== member._id) admin(member);
    // A private administrator source access is auditable; this endpoint never grants purchase rights.
    const at = now();
    await repo.transaction(async tx => {
      const actor = approved(await tx.get('members', member._id));
      if (version.sellerId !== actor._id) admin(actor);
      await audit(tx, actor._id, version._id, 'inspectPrivatePdf', 'private', 'private', randomId(), at);
    });
    const signed = await signPrivate(version.sourceFileId, 'privateFullDocumentInspection');
    return repo.transaction(async tx => {
      const actor = approved(await tx.get('members', member._id));
      const current = await tx.get('versions', version._id);
      if (!current || !current.sourceFileId || current.sourceFileId !== version.sourceFileId || current.sellerId !== version.sellerId) fail('FILE_UNAVAILABLE', '文件版本已变化，请刷新后重新核查。');
      if (current.sellerId !== actor._id) admin(actor);
      return signed;
    });
  }
  async function previewMaterial(e, member) {
    const material = await repo.get('materials', id(e.materialId));
    if (!material || material.status !== 'published') fail('NOT_FOUND', '资料暂不可试读。');
    const version = await repo.get('versions', material.currentVersionId);
    if (!version || version.status !== 'approved' || !version.previewFileId) fail('FILE_NOT_READY', '试读文件暂不可用。');
    const signed = await signPrivate(version.previewFileId, 'standalonePreview');
    const current = await repo.get('materials', material._id), actor = await repo.get('members', member._id);
    approved(actor);
    if (!current || current.status !== 'published' || current.currentVersionId !== version._id) fail('DELIVERY_HELD', '资料状态已变化，暂停新的试读签发，请刷新。');
    return { pageNumbers: version.previewPages, ...signed };
  }

  return async function handle(event = {}, context = {}) {
    try {
      if (!context.OPENID || context.APPID !== APPID) fail('UNAUTHENTICATED', '请使用微信登录后重试。');
      const ownId = memberId(context.OPENID), member = await repo.get('members', ownId), action = event.action;
      if (action === 'session') {
        const profile = await repo.get('profiles', ownId);
        return { ok: true, version: VERSION, authenticated: true, paidEnabled, adultConfirmed: !!(profile && profile.adultConfirmedAt && profile.termsVersion === TERMS_VERSION), limits: LIMITS, termsVersion: TERMS_VERSION, paymentQrConfigured: !!(profile && profile.paymentQrAssetId), access: member && member.status || 'none' };
      }
      const existingActions = ['checkSellerFeePayment', 'listOrders', 'getOrder', 'getPaymentQr', 'submitPaymentProof', 'getPaymentProof', 'confirmReceipt', 'cancelOrder', 'claimOrder', 'completeOrder', 'retryDelivery', 'sendOrderMessage', 'listOrderMessages', 'openAfterSale', 'getAfterSale', 'listOrderAfterSales', 'submitFeedback', 'uploadPrivateImage'];
      approved(member, { existing: existingActions.includes(action) });
      let result;
      switch (action) {
        case 'quoteSellerServiceFee': result = sellerServiceFee(event, member); break;
        case 'startSellerFeeCheckout': result = await startSellerFeeCheckout(event, member, context.OPENID); break;
        case 'checkSellerFeePayment': result = await checkSellerFeePayment(event, ownId, context.OPENID); break;
        case 'confirmAdult': result = await confirmAdult(event, ownId); break;
        case 'saveMaterialDraft': result = await saveMaterialDraft(event, context.OPENID, ownId); break;
        case 'startPdfUpload': result = await startPdfUpload(event, ownId); break;
        case 'uploadPdfChunk': result = await uploadPdfChunk(event, ownId); break;
        case 'finalizePdfUpload': result = await finalizePdfUpload(event, ownId); break;
        case 'getUpload': result = await getUpload(event, member); break;
        case 'submitMaterial': result = await submitMaterial(event, context.OPENID, ownId); break;
        case 'listMaterials': result = await paginate('materials', { kind: 'material', status: 'published' }, event.cursor, 'publishedMaterials', publicMaterial); break;
        case 'listMyMaterials': result = await paginate('materials', { kind: 'material', sellerId: ownId }, event.cursor, `myMaterials:${ownId}`, row => ({ ...publicMaterial(row), reviewReason: row.reviewReason || '', pendingVersionId: row.pendingVersionId || null })); break;
        case 'getMaterial': result = await getMaterial(event, member); break;
        case 'reviewMaterials': admin(member); result = await paginate('materials', { kind: 'material', status: 'pending' }, event.cursor, 'reviewMaterials', row => ({ ...publicMaterial(row), pendingVersionId: row.pendingVersionId })); break;
        case 'reviewMaterial': admin(member); result = await reviewMaterial(event, ownId, context.OPENID); break;
        case 'setMaterialPrice': result = await setMaterialPrice(event, ownId); break;
        case 'setMaterialAvailability': result = await setMaterialAvailability(event, ownId); break;
        case 'previewMaterial': result = await previewMaterial(event, member); break;
        case 'getPrivatePdf': result = await privatePdf(event, member); break;
        case 'uploadPrivateImage': result = await uploadPrivateImage(event, ownId); break;
        case 'setPaymentQr': result = await setPaymentQr(event, ownId); break;
        case 'createOrder': result = await createOrder(event, ownId); break;
        case 'listOrders': {
          const side = event.side === 'seller' ? 'seller' : 'buyer';
          result = await paginate('orders', { kind: 'order', [side === 'buyer' ? 'buyerId' : 'sellerId']: ownId }, event.cursor, `orders:${ownId}:${side}`, row => publicOrder(row, member, now())); break;
        }
        case 'getOrder': result = await getOrder(event, member); break;
        case 'reviewOrders': admin(member); result = await paginate('orders', { kind: 'order' }, event.cursor, 'adminOrders', row => publicOrder(row, member, now())); break;
        case 'getPaymentQr': result = await getPaymentQr(event, member); break;
        case 'submitPaymentProof': result = await submitPaymentProof(event, ownId, context.OPENID); break;
        case 'getPaymentProof': result = await getPaymentProof(event, member); break;
        case 'confirmReceipt': result = await confirmReceipt(event, ownId); break;
        case 'cancelOrder': result = await cancelOrder(event, ownId); break;
        case 'claimOrder': result = await claimOrder(event, ownId); break;
        case 'retryDelivery': result = await retryDelivery(event, ownId); break;
        case 'completeOrder': result = await completeOrder(event, ownId); break;
        case 'sendOrderMessage': result = await sendOrderMessage(event, ownId, context.OPENID); break;
        case 'listOrderMessages': result = await listOrderMessages(event, member); break;
        case 'openAfterSale': result = await openAfterSale(event, ownId, context.OPENID); break;
        case 'getAfterSale': result = await getAfterSale(event, member); break;
        case 'listOrderAfterSales': result = await listOrderAfterSales(event, member); break;
        case 'resolveAfterSale': admin(member); result = await resolveAfterSale(event, ownId, context.OPENID); break;
        case 'listAfterSales': admin(member); result = await paginate('afterSales', { kind: 'afterSale', status: 'open' }, event.cursor, 'adminAfterSales', row => ({ _id: row._id, orderId: row.orderId, type: row.type, status: row.status, revision: row.revision, createdAt: row.createdAt, overdue: now() - row.createdAt > DAY })); break;
        case 'reportMaterial': result = await reportMaterial(event, ownId, context.OPENID); break;
        case 'resolveMaterialComplaint': admin(member); result = await resolveMaterialComplaint(event, ownId, context.OPENID); break;
        case 'listMaterialComplaints': admin(member); result = await paginate('complaints', { kind: 'materialComplaint', status: 'open' }, event.cursor, 'materialComplaints', row => ({ _id: row._id, materialId: row.materialId, versionId: row.versionId, reason: row.reason, status: row.status, revision: row.revision, createdAt: row.createdAt, overdue: now() - row.createdAt > DAY })); break;
        case 'submitFeedback': result = await submitFeedback(event, ownId); break;
        default: fail('INVALID_ACTION', '不支持的资料操作。');
      }
      return { ok: true, version: VERSION, ...result };
    } catch (error) {
      if (!(error instanceof TradeError)) logger.error('trade_request_failed', { code: error.code || error.errCode || 'unknown' });
      return { ok: false, version: VERSION, code: error instanceof TradeError ? error.code : 'SERVICE_UNAVAILABLE', message: error instanceof TradeError ? error.message : '服务暂不可用，请保留输入稍后重试。' };
    }
  };
}
module.exports = { createTradeService, VERSION, TERMS_VERSION, APPID, LIMITS, DAY, HOUR, RETENTION_DAYS, LEARNING_MODES, MATERIAL_TYPES, AFTER_SALE_TYPES, FEEDBACK, memberId, hash, key };
