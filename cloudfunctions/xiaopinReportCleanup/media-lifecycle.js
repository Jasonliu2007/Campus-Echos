'use strict';
const { createHash, randomUUID } = require('crypto');
const fileKey = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

// Called inside the same transaction as every post revision. A deleting asset
// cannot gain a new reference after the cleanup worker acquires its lock.
async function replacePostMediaReferences(tx, { postId, before = [], after = [], at }) {
  const retained = new Set(after);
  for (const mediaId of new Set([...before, ...after])) {
    const asset = await tx.get('media', mediaId);
    if (!asset && !retained.has(mediaId)) continue;
    if (!asset || (retained.has(mediaId) && ['deleting', 'deleted'].includes(asset.status))) {
      const error = new Error('Media changed before post commit'); error.code = 'MEDIA_NOT_APPROVED'; throw error;
    }
    const postRefs = { ...(asset.postRefs || {}) };
    if (retained.has(mediaId)) postRefs[postId] = true; else delete postRefs[postId];
    await tx.set('media', mediaId, { ...asset, postRefs, ...(retained.has(mediaId) ? { gcCandidateAt: null } : { gcCandidateAt: at }), updatedAt: at });
  }
}

async function scan(repo, type, where) {
  const rows = []; let cursor = null;
  for (;;) {
    const batch = await repo.query(type, { where, cursor, limit: 100 });
    rows.push(...batch); if (batch.length < 100) return rows;
    const last = batch[batch.length - 1];
    if (cursor && cursor._id === last._id && cursor.createdAt === last.createdAt) throw Error('Cleanup scan did not advance');
    cursor = { createdAt: last.createdAt, _id: last._id };
  }
}
function references(asset) { return Object.keys(asset.postRefs || {}).length || Object.keys(asset.evidenceRefs || {}).length || asset.directMessageId; }

// The public function never registers this as a client action. Each deletion is
// locked in the database before storage I/O; failed storage deletion stays locked
// and is safe for a later timer to retry.
async function garbageCollectMedia({ repo, storage, at = Date.now(), logger = console, maxFiles = 100 }) {
  if (!storage || typeof storage.delete !== 'function') throw Error('Private storage delete adapter required');
  const livePosts = await scan(repo, 'posts', { kind: 'post' });
  const liveEvidence = await scan(repo, 'reportEvidence', { kind: 'reportEvidence' });
  const protectedIds = new Set();
  for (const post of livePosts) if (['published', 'pending'].includes(post.status)) for (const mediaId of post.mediaIds || []) protectedIds.add(mediaId);
  for (const evidence of liveEvidence) if (evidence.retentionStatus !== 'cleared' && (!evidence.expiresAt || evidence.expiresAt > at)) for (const mediaId of evidence.snapshot?.mediaIds || []) protectedIds.add(mediaId);
  const assets = (await scan(repo, 'media', { kind: 'media' })).concat(await scan(repo, 'media', { kind: 'directMedia' }));
  let scanned = 0, deleted = 0, failed = 0, deferred = 0, retiredDeleted = 0;
  for (const candidate of assets) {
    // Failed attempts are never valid evidence versions. Clean their distinct
    // provider IDs even if a later successful attempt is now publicly referenced.
    const retiredToken = randomUUID();
    try {
      const retired = await repo.transaction(async tx => {
        const asset = await tx.get('media', candidate._id);
        if (!asset || ['deleting', 'deleted'].includes(asset.status) || asset.retiredDeleteLeaseUntil > at) return null;
        const protectedFiles = new Set([asset.fileId, ...(asset.stagedFileIds || [])]);
        const fileIds = (asset.retiredFileIds || []).filter(fileId => !protectedFiles.has(fileId) && at - (asset.retiredFileAt?.[fileKey(fileId)] || Math.max(asset.createdAt || 0, asset.updatedAt || 0)) >= ORPHAN_GRACE_MS);
        if (!fileIds.length) return null;
        if (scanned >= maxFiles) { deferred += 1; return null; }
        scanned += 1;
        await tx.set('media', candidate._id, { ...asset, retiredDeleteToken: retiredToken, retiredDeleteLeaseUntil: at + 120000 });
        return fileIds;
      });
      if (retired) {
        await storage.delete(retired);
        await repo.transaction(async tx => {
          const asset = await tx.get('media', candidate._id);
          if (!asset || asset.retiredDeleteToken !== retiredToken) throw Error('Retired media deletion lock changed');
          const removed = new Set(retired), retiredFileAt = { ...(asset.retiredFileAt || {}) };
          for (const fileId of removed) delete retiredFileAt[fileKey(fileId)];
          await tx.set('media', candidate._id, { ...asset, retiredFileIds: (asset.retiredFileIds || []).filter(fileId => !removed.has(fileId)), retiredFileAt, retiredDeleteLeaseUntil: 0 });
        });
        retiredDeleted += retired.length;
      }
    } catch (error) {
      failed += 1; logger.error('forum_retired_media_gc_failed', { code: error.code || 'unknown' });
      await repo.transaction(async tx => {
        const asset = await tx.get('media', candidate._id);
        if (asset?.retiredDeleteToken === retiredToken) await tx.set('media', candidate._id, { ...asset, retiredDeleteLeaseUntil: 0 });
      });
    }
    if (candidate.status === 'deleted' || protectedIds.has(candidate._id) || (candidate.status === 'uploading' && candidate.uploadLeaseUntil > at)) continue;
    if (scanned >= maxFiles) { deferred += 1; continue; }
    if (candidate.status !== 'deleting' && candidate.gcCandidateAt == null && at - Math.max(candidate.createdAt || 0, candidate.updatedAt || 0) < ORPHAN_GRACE_MS) continue;
    scanned += 1; const token = randomUUID();
    try {
      const locked = await repo.transaction(async tx => {
        const asset = await tx.get('media', candidate._id);
        if (!asset || asset.status === 'deleted' || references(asset) || (asset.status === 'uploading' && asset.uploadLeaseUntil > at)) return null;
        if (asset.status !== 'deleting' && asset.gcCandidateAt == null && at - Math.max(asset.createdAt || 0, asset.updatedAt || 0) < ORPHAN_GRACE_MS) return null;
        if (asset.status === 'deleting' && asset.deleteLeaseUntil > at) return null;
        await tx.set('media', candidate._id, { ...asset, status: 'deleting', deleteToken: token, deleteLeaseUntil: at + 120000, updatedAt: at });
        return asset;
      });
      if (!locked) continue;
      const fileIds = [...new Set([locked.fileId, ...(locked.retiredFileIds || []), ...(locked.stagedFileIds || [])].filter(Boolean))];
      if (fileIds.length) await storage.delete(fileIds);
      await repo.transaction(async tx => {
        const asset = await tx.get('media', candidate._id);
        if (!asset || asset.status !== 'deleting' || asset.deleteToken !== token || references(asset)) throw Error('Media deletion lock changed');
        await tx.set('media', candidate._id, { kind: 'media', ownerId: asset.ownerId, status: 'deleted', bytes: asset.bytes, sha256: asset.sha256, createdAt: asset.createdAt, updatedAt: at, deletedAt: at, postRefs: {}, evidenceRefs: {} });
      });
      deleted += 1;
    } catch (error) {
      failed += 1; logger.error('forum_media_gc_failed', { code: error.code || 'unknown' });
      await repo.transaction(async tx => {
        const asset = await tx.get('media', candidate._id);
        if (asset?.deleteToken === token) await tx.set('media', candidate._id, { ...asset, deleteLeaseUntil: 0, updatedAt: at });
      });
    }
  }
  return { scanned, deleted, retiredDeleted, failed, deferred, hasMore: deferred > 0 };
}
module.exports = { replacePostMediaReferences, garbageCollectMedia, ORPHAN_GRACE_MS };
