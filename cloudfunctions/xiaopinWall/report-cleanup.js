'use strict';

// Server-only worker. Not registered as a client action and never accepts a user-supplied clock.
async function cleanupExpired({ repo, now = Date.now, logger = console, batchSize = 100, maxBatches = 20, mediaGarbageCollect }) {
  if (!repo || typeof repo.queryExpiredEvidence !== 'function') throw new Error('cleanup repository required');
  const at = now(); let cursor = null, scanned = 0, cleared = 0, failed = 0, hasMore = false;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await repo.queryExpiredEvidence({ at, cursor, limit: batchSize });
    if (!rows.length) { hasMore = false; break; }
    for (const row of rows) {
      scanned += 1;
      try {
        const changed = await repo.transaction(async tx => {
          const evidence = await tx.get('reportEvidence', row._id);
          if (!evidence || evidence.retentionStatus !== 'expiring' || !Number.isSafeInteger(evidence.expiresAt) || evidence.expiresAt > at) return false;
          const report = await tx.get('reports', evidence.reportId);
          if (!report || report.kind !== 'report' || report.status === 'pending' || report.evidenceExpiresAt !== evidence.expiresAt) {
            const error = new Error('Evidence retention metadata mismatch'); error.code = 'RETENTION_MISMATCH'; throw error;
          }
          for (const mediaId of evidence.snapshot?.mediaIds || []) {
            const asset = await tx.get('media', mediaId);
            if (asset) {
              const evidenceRefs = { ...(asset.evidenceRefs || {}) };
              delete evidenceRefs[evidence.reportId];
              await tx.set('media', mediaId, { ...asset, evidenceRefs, gcCandidateAt: at });
            }
          }
          // Replace rather than patch so raw fields and any future content fields are removed too.
          await tx.set('reportEvidence', row._id, { kind: 'reportEvidence', reportId: evidence.reportId, createdAt: evidence.createdAt, expiresAt: evidence.expiresAt, retentionStatus: 'cleared', clearedAt: at });
          return true;
        });
        if (changed) cleared += 1;
      } catch (error) {
        failed += 1;
        logger.error('report_evidence_cleanup_failed', { code: error.code || error.errCode || 'unknown' });
      }
    }
    const last = rows[rows.length - 1]; cursor = { expiresAt: last.expiresAt, _id: last._id };
    hasMore = rows.length === batchSize;
    if (!hasMore) break;
  }
  if (failed || hasMore) logger.error('report_evidence_cleanup_incomplete', { failed, hasMore });
  let mediaCleanup = null;
  if (typeof mediaGarbageCollect === 'function') {
    try { mediaCleanup = await mediaGarbageCollect({ at }); if (mediaCleanup.failed) failed += mediaCleanup.failed; if (mediaCleanup.hasMore) hasMore = true; }
    catch (error) { failed += 1; logger.error('report_media_cleanup_failed', { code: error.code || 'unknown' }); }
  }
  return { scanned, cleared, failed, hasMore, ...(mediaCleanup ? { mediaCleanup } : {}) };
}

module.exports = { cleanupExpired };
