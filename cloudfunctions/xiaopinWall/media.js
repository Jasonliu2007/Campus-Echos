'use strict';
const { createHash, randomUUID } = require('crypto');
const { replacePostMediaReferences } = require('./media-lifecycle');
const MAX_BYTES = 600 * 1024;
const DIRECT_MAX_BYTES = 500 * 1000;
function createMediaService({ repo, now, hash, id, approved, fail, storage, mediaCheck, logger = console }) {
  function file(data) {
    if (typeof data !== 'string' || data.length > 820000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) fail('INVALID_MEDIA', '图片数据无效或超过600KiB。');
    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length || buffer.length > MAX_BYTES || buffer.toString('base64') !== data) fail('INVALID_MEDIA', '图片压缩后不能超过600KiB。');
    const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const isPng = buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const isWebp = buffer.subarray(0,4).toString() === 'RIFF' && buffer.subarray(8,12).toString() === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) fail('INVALID_MEDIA', '仅支持JPEG、PNG及WebP图片。');
    return { buffer, ext: isJpeg ? 'jpg' : isPng ? 'png' : 'webp', sha256: createHash('sha256').update(buffer).digest('hex') };
  }
  async function validateMedia(value, ownId, source = repo) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 9 || new Set(value).size !== value.length) fail('INVALID_MEDIA', '每帖最多9张图片，同一图片不能重复添加。');
    for (const key of value) {
      id(key, '图片'); const record = await source.get('media', key);
      if (!record || record.ownerId !== ownId || record.kind !== 'media' || record.directThreadId || record.status !== 'approved' || !record.fileId || !record.sha256 || !record.traceId || record.moderationVersion !== 1) fail('MEDIA_NOT_APPROVED', '图片尚未通过微信审核，请等待或移除后再提交。');
    }
    return value;
  }
  async function isPublicSafe(post, source = repo) {
    if (!Array.isArray(post.mediaIds) || !post.mediaIds.length) return true;
    for (const key of post.mediaIds) { const record = await source.get('media', key); if (!record || record.status !== 'approved' || record.ownerId !== post.authorId || !record.traceId || !record.sha256 || record.moderationVersion !== 1) return false; }
    return true;
  }
  async function uploadMedia(event, openid, ownId, directThreadId) {
    if (!storage || typeof storage.reserve !== 'function' || typeof storage.put !== 'function' || !mediaCheck) fail('MEDIA_UNAVAILABLE', '图片服务尚未连接，请稍后重试。');
    if (typeof event.requestId !== 'string' || !/^[a-z0-9-]{10,64}$/.test(event.requestId)) fail('INVALID_INPUT', '上传请求无效。');
    const data = file(event.base64);
    if (directThreadId && data.buffer.length > DIRECT_MAX_BYTES) fail('INVALID_MEDIA', '图片不能超过 500 KB。');
    const mediaId = hash(directThreadId ? `${ownId}:direct:${directThreadId}:${event.requestId}` : `${ownId}:media:${event.requestId}`);
    const token = randomUUID();
    const reservation = await repo.transaction(async tx => {
      const actor = approved(await tx.get('members', ownId)); if (actor.banned || actor.mutedUntil > now()) fail('ACCESS_DENIED', '当前账号不能上传新图片。');
      const prior = await tx.get('media', mediaId);
      if (prior && prior.sha256 !== data.sha256) fail('REQUEST_CONFLICT', '同一上传请求不能替换图片。');
      if (prior && prior.status !== 'failed' && !(prior.status === 'uploading' && (prior.uploadLeaseUntil || 0) <= now())) return { duplicate: true, media: prior };
      const retiredFileIds = [...new Set([...(prior?.retiredFileIds || []), ...(prior?.stagedFileIds || []), prior?.fileId].filter(Boolean))];
      const retiredFileAt = { ...(prior?.retiredFileAt || {}) };
      for (const retiredId of retiredFileIds) if (!retiredFileAt[hash(retiredId)]) retiredFileAt[hash(retiredId)] = now();
      const media = { kind: directThreadId ? 'directMedia' : 'media', ownerId: ownId, ...(directThreadId ? { directThreadId } : {}), sha256: data.sha256, bytes: data.buffer.length, status: 'uploading', attempt: token, uploadLeaseUntil: now() + 120000, moderationVersion: 1, retiredFileIds, retiredFileAt, stagedFileIds: [], createdAt: prior?.createdAt || now(), updatedAt: now() };
      await tx.set('media', mediaId, media); return { media };
    });
    if (reservation.duplicate) return { mediaId, status: reservation.media.status, duplicate: true };
    let fileId;
    try {
      const path = `forum-private/sealed/${mediaId}/${token}.${data.ext}`;
      fileId = await storage.reserve(path);
      if (typeof fileId !== 'string' || !fileId.startsWith('cloud://')) throw Error('upload reservation missing file');
      // Persist the final provider ID before any bytes are uploaded. A killed
      // invocation leaves a staged ID for the independent cleanup worker.
      await repo.transaction(async tx => {
        const r = await tx.get('media', mediaId);
        if (r?.attempt !== token || r.status !== 'uploading' || r.uploadLeaseUntil <= now()) fail('CONFLICT', '上传任务已变化。');
        await tx.set('media', mediaId, { ...r, stagedFileIds: [...new Set([...(r.stagedFileIds || []), fileId])], updatedAt: now() });
      });
      await storage.put(path, data.buffer, fileId);
      await repo.transaction(async tx => {
        const r = await tx.get('media', mediaId);
        if (r?.attempt !== token || r.status !== 'uploading' || r.uploadLeaseUntil <= now() || !r.stagedFileIds?.includes(fileId)) fail('CONFLICT', '上传任务已变化。');
        await tx.set('media', mediaId, { ...r, fileId, stagedFileIds: r.stagedFileIds.filter(value => value !== fileId), status: 'checking', updatedAt: now() });
      });
      const url = await storage.url(fileId, 600);
      const response = await mediaCheck(openid, url);
      if (!response || (response.errcode !== undefined && response.errcode !== 0) || (response.errCode !== undefined && response.errCode !== 0)) throw Error('security request was not accepted');
      const traceId = response.traceId || response.trace_id;
      if (typeof traceId !== 'string' || !traceId || traceId.length > 200) throw Error('missing security trace');
      const saved = await repo.transaction(async tx => {
        const record = await tx.get('media', mediaId); if (record?.attempt !== token || record.fileId !== fileId || record.sha256 !== data.sha256) fail('CONFLICT', '图片封存版本已变化。');
        const receipt = await tx.get('mediaCallbacks', hash(traceId));
        const status = receipt?.suggestion === 'risky' ? 'rejected' : receipt?.suggestion === 'pass' ? 'approved' : receipt ? 'review' : 'checking';
        const updated = { ...record, traceId, status, updatedAt: now() };
        await tx.set('media', mediaId, updated);
        await tx.set('mediaTraces', hash(traceId), { kind: 'mediaTrace', mediaId, traceId, sha256: data.sha256, fileId, moderationVersion: 1, createdAt: now() });
        return updated;
      });
      return { mediaId, status: saved.status, bytes: data.buffer.length };
    } catch (error) {
      logger.error('wall_media_upload_failed', { code: error.code || 'unknown' });
      await repo.transaction(async tx => { const r = await tx.get('media', mediaId); if (r?.attempt === token && !r.traceId && !['deleting', 'deleted'].includes(r.status)) await tx.set('media', mediaId, { ...r, status: 'failed', updatedAt: now() }); });
      fail('MEDIA_UNAVAILABLE', '图片上传或微信审核暂不可用，正文已保留，可单张重试。');
    }
  }
  async function handleCallback(event, trusted = false) {
    // trusted is supplied only by the independent server entry, never event data.
    if (trusted !== true) fail('FORBIDDEN', '审核回调来源不可信。');
    const traceId = event.trace_id || event.traceId;
    const suggestion = event.result?.suggest || event.result?.suggestion;
    if ((event.errcode !== undefined && event.errcode !== 0) || (event.errCode !== undefined && event.errCode !== 0)) fail('INVALID_CALLBACK', '审核回调未成功。');
    if (event.Event !== 'wxa_media_check' || typeof traceId !== 'string' || !traceId || traceId.length > 200 || !['pass','review','risky'].includes(suggestion)) fail('INVALID_CALLBACK', '审核回调格式无效。');
    let mediaId;
    const result = await repo.transaction(async tx => {
      const key = hash(traceId), previous = await tx.get('mediaCallbacks', key), link = await tx.get('mediaTraces', key);
      const finalSuggestion = previous?.suggestion === 'risky' || suggestion === 'risky' ? 'risky' : previous?.suggestion === 'review' || suggestion === 'review' ? 'review' : 'pass';
      await tx.set('mediaCallbacks', key, { kind: 'mediaCallback', traceId, suggestion: finalSuggestion, createdAt: previous?.createdAt || now(), updatedAt: now() });
      if (!link) return { associated: false };
      const record = await tx.get('media', link.mediaId);
      if (!record || record.traceId !== traceId || record.sha256 !== link.sha256 || record.fileId !== link.fileId || record.moderationVersion !== link.moderationVersion) fail('CALLBACK_CONFLICT', '审核结果与封存版本不匹配。');
      mediaId = link.mediaId;
      if (['deleting', 'deleted'].includes(record.status)) return { associated: true, mediaId, status: record.status };
      const status = record.status === 'rejected' || finalSuggestion === 'risky' ? 'rejected' : finalSuggestion === 'pass' ? 'approved' : 'review';
      await tx.set('media', mediaId, { ...record, status, updatedAt: now() });
      return { associated: true, mediaId, status };
    });
    // A later non-pass must also remove references from public visibility.
    if (mediaId && result.status !== 'approved') {
      let cursor = null;
      do {
        const rows = await repo.query('posts', { where: { kind: 'post', status: 'published' }, cursor, limit: 100 });
        for (const p of rows) if (p.mediaIds?.includes(mediaId)) await repo.transaction(async tx => {
          const current = await tx.get('posts', p._id); if (current?.status === 'published' && current.mediaIds?.includes(mediaId)) {
            await replacePostMediaReferences(tx, { postId: p._id, before: current.mediaIds || [], at: now() });
            await tx.set('posts', p._id, { ...current, status: 'hidden', reviewReason: '图片微信审核结果变化，内容暂停展示。', revision: current.revision + 1, updatedAt: now() });
            await tx.set('audit', hash(`${mediaId}:${p._id}:${current.revision}`), { kind: 'audit', action: 'mediaSecurityHide', targetId: p._id, createdAt: now(), revision: current.revision + 1 });
          }
        });
        if (rows.length < 100) break; const last = rows[rows.length-1]; cursor = { createdAt: last.createdAt, _id: last._id };
      } while (true);
    }
    return result;
  }
  async function getMedia(event, member) {
    const key = id(event.mediaId, '图片');
    const authorize = async (tx, recordAudit = false) => {
      const actor = approved(await tx.get('members', member._id));
      const record = await tx.get('media', key);
      if (!record || ['deleting', 'deleted'].includes(record.status)) fail('NOT_FOUND', '图片不存在或已清除。');
      let maxAge = 600, evidenceAccess = false;
      if (event.reportId) {
        if (actor.role !== 'admin') fail('NOT_FOUND', '图片不存在或无权查看。');
        const reportId = id(event.reportId, '举报'), report = await tx.get('reports', reportId), evidence = await tx.get('reportEvidence', reportId);
        if (!report || report.kind !== 'report' || !evidence || !['pending', 'expiring'].includes(evidence.retentionStatus) || evidence.expiresAt !== report.evidenceExpiresAt || (report.evidenceExpiresAt && report.evidenceExpiresAt <= now()) || !evidence.snapshot?.mediaIds?.includes(key) || !Object.prototype.hasOwnProperty.call(record.evidenceRefs || {}, reportId)) fail('NOT_FOUND', '证据已到期或不可查看。');
        if (report.evidenceExpiresAt) maxAge = Math.min(maxAge, Math.floor((report.evidenceExpiresAt - now()) / 1000));
        if (maxAge < 1) fail('NOT_FOUND', '证据已到期。');
        evidenceAccess = true;
        if (recordAudit) await tx.set('audit', hash(`evidence-media:${member._id}:${reportId}:${key}:${randomUUID()}`), { kind: 'audit', actorId: member._id, targetId: reportId, mediaId: key, action: 'inspectReportMedia', createdAt: now() });
      } else if (record.ownerId !== member._id) {
        const post = await tx.get('posts', id(event.postId));
        if (!post || !post.mediaIds?.includes(key) || (post.status !== 'published' && actor.role !== 'admin')) fail('NOT_FOUND', '图片不存在或无权查看。');
      }
      return { record, maxAge, evidenceAccess };
    };
    const grant = await repo.transaction(tx => authorize(tx, true));
    const result = { mediaId: key, status: grant.record.status, bytes: grant.record.bytes };
    if (!grant.record.directThreadId && (grant.record.status === 'approved' || grant.evidenceAccess) && storage) {
      const url = await storage.url(grant.record.fileId, grant.maxAge);
      // Signing is asynchronous. Recheck the current principal, evidence deadline,
      // public post and immutable file before returning any newly issued link.
      const current = await repo.transaction(tx => authorize(tx));
      if (current.record.fileId !== grant.record.fileId || current.record.sha256 !== grant.record.sha256 ||
          current.record.moderationVersion !== grant.record.moderationVersion || current.record.status !== grant.record.status) {
        fail('CONFLICT', '图片版本或审核状态已变化，请重新查看。');
      }
      result.url = url;
    }
    return result;
  }
  return { validateMedia, isPublicSafe, uploadMedia, getMedia, handleCallback };
}
module.exports = { createMediaService, MAX_BYTES, DIRECT_MAX_BYTES };
