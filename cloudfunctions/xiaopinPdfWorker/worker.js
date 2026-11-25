'use strict';
const { createHash, randomBytes } = require('crypto');
const VERSION = 'trade-worker-20261113-v1.2';
const DAY = 86400000;
const HOUR = 3600000;
const TRIGGER_NAME = 'trade-maintenance';
const key = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const hash = value => createHash('sha256').update(value).digest('hex');
const evidenceEpoch = row => Number.isSafeInteger(row.evidenceEpoch) && row.evidenceEpoch > 0 ? row.evidenceEpoch : 1;
function error(code) { const value = new Error(code); value.code = code; return value; }

function createWorker({ repo, storage, runPdf, context, now = Date.now, logger = console, deadlineMs = 48000 }) {
  async function setAudit(tx, actorId, targetId, action, from, to, revision, at) {
    const auditId = key(`${actorId}:${targetId}:${action}:${revision}`);
    await tx.set('audit', auditId, { _id: auditId, kind: 'tradeAudit', actorId, targetId, action, from, to, revision, createdAt: at });
  }
  async function takeJob(jobId) {
    const at = now(), token = randomBytes(16).toString('hex');
    return repo.transaction(async tx => {
      const job = await tx.get('jobs', jobId);
      if (!job || job.kind !== 'fileJob' || job.status === 'ready' || job.status === 'failed' || (job.status === 'processing' && job.leaseUntil > at)) return null;
      if (!['queued', 'processing'].includes(job.status)) return null;
      if (job.attempts >= 3) {
        await markJobFailure(tx, job, 'RETRY_LIMIT'); return null;
      }
      const leased = { ...job, status: 'processing', token, leaseUntil: at + 90000, attempts: (job.attempts || 0) + 1, updatedAt: at };
      await tx.set('jobs', jobId, leased);
      if (job.uploadId) { const upload = await tx.get('uploads', job.uploadId); if (upload) await tx.set('uploads', job.uploadId, { ...upload, status: 'processing', updatedAt: at }); }
      if (job.orderId) { const order = await tx.get('orders', job.orderId); if (order) await tx.set('orders', order._id, { ...order, deliveryStatus: 'processing', updatedAt: at, revision: order.revision + 1 }); }
      return leased;
    });
  }
  async function markJobFailure(tx, job, code) {
    await tx.set('jobs', job._id, { ...job, status: 'failed', leaseUntil: 0, errorCode: code, updatedAt: now() });
    if (job.uploadId) {
      const upload = await tx.get('uploads', job.uploadId);
      if (upload) await tx.set('uploads', upload._id, { ...upload, status: 'failed', errorCode: code, updatedAt: now() });
    }
    if (job.orderId) {
      const order = await tx.get('orders', job.orderId);
      if (order) await tx.set('orders', order._id, { ...order, deliveryStatus: 'failed', updatedAt: now(), revision: order.revision + 1 });
    }
    if (job.type === 'preview') {
      const material = await tx.get('materials', job.materialId), version = await tx.get('versions', job.versionId);
      if (version && version.status === 'previewQueued') await tx.set('versions', version._id, { ...version, status: 'processed', errorCode: code, updatedAt: now() });
      if (material && material.pendingVersionId === job.versionId && material.status === 'processing') await tx.set('materials', material._id, { ...material, status: 'draft', reviewReason: '试读生成失败，请重新提交或联系维护者。', revision: material.revision + 1, updatedAt: now() });
    }
  }
  async function finish(job, change) {
    await repo.transaction(async tx => {
      const latest = await tx.get('jobs', job._id);
      if (!latest || latest.token !== job.token || latest.status !== 'processing') throw error('JOB_LEASE_LOST');
      await change(tx, latest);
      for (const reservationId of job.reservations || []) {
        const reserved = await tx.get('jobs', reservationId);
        if (!reserved || reserved.status !== 'staged') throw error('FILE_RESERVATION_LOST');
        await tx.set('jobs', reservationId, { ...reserved, status: 'attached', attachedAt: now() });
      }
      await tx.set('jobs', job._id, { ...latest, status: 'ready', leaseUntil: 0, completedAt: now(), updatedAt: now() });
    });
  }
  async function failJob(job, err) {
    const code = /^[A-Z0-9_]{1,80}$/.test(err.code || '') ? err.code : 'PDF_PROCESSING_FAILED';
    await repo.transaction(async tx => {
      const latest = await tx.get('jobs', job._id);
      if (!latest || latest.token !== job.token || latest.status !== 'processing') return;
      await markJobFailure(tx, latest, code);
    });
    logger.error('trade_pdf_job_failed', { jobId: job._id, type: job.type, code });
  }
  async function processJob(job) {
    const outputs = [];
    async function putOutput(path, bytes) {
      const fileId = await storage.reserve(path), reservationId = key(`staged:${fileId}`);
      await repo.transaction(tx => tx.set('jobs', reservationId, { _id: reservationId, kind: 'fileReservation', status: 'staged', fileId, targetId: job._id, expiresAt: now() + DAY, createdAt: now() }));
      outputs.push(fileId); job.reservations = [...(job.reservations || []), reservationId];
      await storage.put(path, bytes, fileId); return fileId;
    }
    try {
      if (job.type === 'processUpload') {
        let size = 0; const pieces = [];
        for (const chunk of job.chunks) {
          const bytes = Buffer.from(await storage.get(chunk.fileId));
          if (bytes.length !== chunk.size || hash(bytes) !== chunk.sha256) throw error('CHUNK_HASH_MISMATCH');
          size += bytes.length; if (size > 20 * 1024 * 1024) throw error('PDF_SIZE_LIMIT'); pieces.push(bytes);
        }
        if (size !== job.expectedSize) throw error('UPLOAD_SIZE_MISMATCH');
        const bytes = Buffer.concat(pieces), inspected = await runPdf({ type: 'inspect' }, bytes);
        const sourceFileId = await putOutput(`private/trade/source/${job.versionId}/${job.token}.pdf`, bytes);
        await finish(job, async tx => {
          const upload = await tx.get('uploads', job.uploadId);
          if (!upload || upload.status !== 'processing') throw error('UPLOAD_STATE_CHANGED');
          await tx.set('versions', job.versionId, { _id: job.versionId, kind: 'materialVersion', materialId: job.materialId, sellerId: job.ownerId, sourceFileId, sha256: inspected.sha256, byteLength: size, pageCount: inspected.pageCount, suggestedCatalog: inspected.suggestedCatalog || [], status: 'processed', createdAt: now(), updatedAt: now() });
          await tx.set('uploads', upload._id, { ...upload, status: 'ready', revision: upload.revision + 1, updatedAt: now() });
          await setAudit(tx, 'server-worker', job.versionId, 'sealPdfVersion', 'none', 'processed', 1, now());
        });
      } else if (job.type === 'preview' || job.type === 'watermark') {
        const bytes = Buffer.from(await storage.get(job.sourceFileId));
        if (hash(bytes) !== job.sourceHash) throw error('SOURCE_HASH_MISMATCH');
        const task = job.type === 'preview' ? { type: 'preview', pages: job.previewPages, expectedHash: job.sourceHash } : { type: 'watermark', alias: job.buyerAlias, shortId: job.shortId, expectedHash: job.sourceHash };
        const generated = await runPdf(task, bytes);
        const fileId = await putOutput(`private/trade/${job.type}/${job._id}/${job.token}.pdf`, Buffer.from(generated.bytes));
        await finish(job, async tx => {
          if (job.type === 'preview') {
            const version = await tx.get('versions', job.versionId), material = await tx.get('materials', job.materialId);
            if (!version || version.status !== 'previewQueued' || !material || material.pendingVersionId !== version._id || material.status !== 'processing') throw error('MATERIAL_STATE_CHANGED');
            await tx.set('versions', version._id, { ...version, previewFileId: fileId, previewHash: hash(Buffer.from(generated.bytes)), status: 'pending', updatedAt: now() });
            await tx.set('materials', material._id, { ...material, status: 'pending', revision: material.revision + 1, updatedAt: now() });
          } else {
            const order = await tx.get('orders', job.orderId), entitlement = order && await tx.get('entitlements', key(`entitlement:${order.buyerId}:${order.versionId}`));
            if (!order || !['deliverable', 'completed'].includes(order.status) || order.sourceHash !== job.sourceHash || !entitlement || entitlement.status !== 'active') throw error('ENTITLEMENT_CHANGED');
            await tx.set('orders', order._id, { ...order, watermarkedFileId: fileId, watermarkSourceHash: job.sourceHash, watermarkedAt: now(), deliveryStatus: 'ready', revision: order.revision + 1, updatedAt: now() });
            await setAudit(tx, 'server-worker', order._id, 'watermarkReady', 'processing', 'ready', order.revision + 1, now());
          }
        });
      } else throw error('JOB_TYPE_INVALID');
      return true;
    } catch (err) {
      for (const fileId of outputs) {
        let reservation;
        try { reservation = await repo.get('jobs', key(`staged:${fileId}`)); }
        catch (_) { logger.error('trade_staged_file_state_unknown', { jobId: job._id }); continue; }
        if (reservation && reservation.status === 'attached') continue;
        try {
          await storage.remove(fileId);
        }
        catch (_) {
          const garbageId = key(`garbage:${fileId}`);
          await repo.transaction(tx => tx.set('jobs', garbageId, { _id: garbageId, kind: 'fileGarbage', fileId, targetId: job._id, status: 'pending', createdAt: now() }));
          logger.error('trade_staged_file_delete_queued', { jobId: job._id });
        }
      }
      await failJob(job, err); return false;
    }
  }
  async function scan(type, where, work, budget, { limit = 50, checkpoint = null } = {}) {
    const saved = checkpoint ? await repo.get('jobs', checkpoint) : null;
    let cursor = saved && saved.cursor || null, count = 0;
    async function remember(value) {
      if (!checkpoint) return;
      await repo.transaction(tx => tx.set('jobs', checkpoint, { _id: checkpoint, kind: 'maintenanceCursor', cursor: value, createdAt: now(), updatedAt: now() }));
    }
    do {
      if (Date.now() >= budget) return { processed: count, hasMore: true };
      const rows = await repo.query(type, { where, cursor, limit });
      for (const row of rows) {
        if (Date.now() >= budget) return { processed: count, hasMore: true };
        await work(row); count += 1;
        await remember({ createdAt: row.createdAt, _id: row._id });
      }
      if (rows.length < limit) { await remember(null); return { processed: count, hasMore: false }; }
      cursor = { createdAt: rows[rows.length - 1].createdAt, _id: rows[rows.length - 1]._id };
    } while (true);
  }
  async function maintainOrder(row) {
    await repo.transaction(async tx => {
      const order = await tx.get('orders', row._id), at = now();
      if (!order) return;
      if (order.status === 'awaitingPayment' && at - order.createdAt >= 48 * HOUR) {
        const updated = { ...order, status: 'cancelled', cancelledAt: at, updatedAt: at, revision: order.revision + 1, retentionExpiresAt: order.afterSaleOpen ? null : at + 90 * DAY };
        await tx.set('orders', order._id, updated);
        await setAudit(tx, 'server-worker', order._id, 'paymentTimeout', order.status, updated.status, updated.revision, at);
      } else if (order.status === 'deliverable' && order.firstClaimAt && at - order.firstClaimAt >= 7 * DAY && !order.afterSaleOpen) {
        const updated = { ...order, status: 'completed', completedAt: at, updatedAt: at, revision: order.revision + 1, retentionExpiresAt: at + 90 * DAY };
        await tx.set('orders', order._id, updated);
        await setAudit(tx, 'server-worker', order._id, 'autoCompleteOrder', order.status, updated.status, updated.revision, at);
      }
    });
  }
  async function clearOrder(row, budget) {
    let order = await repo.get('orders', row._id); const at = now();
    if (!order) return;
    const expired = !order.afterSaleOpen && ['completed', 'cancelled'].includes(order.status)
      && order.retentionExpiresAt && order.retentionExpiresAt <= at && !order.evidenceCleared;
    const oldEpochPending = (order.evidenceExpiredThroughEpoch || 0) > (order.evidenceClearedThroughEpoch || 0);
    if (!expired && !oldEpochPending) return;
    if (expired) await repo.transaction(async tx => {
      const current = await tx.get('orders', order._id);
      if (!current || current.afterSaleOpen || !current.retentionExpiresAt || current.retentionExpiresAt > now()) throw error('RETENTION_STATE_CHANGED');
      await tx.set('orders', order._id, { ...current, evidenceClearing: true, evidenceExpiredThroughEpoch: Math.max(current.evidenceExpiredThroughEpoch || 0, evidenceEpoch(current)) });
    });
    order = await repo.get('orders', order._id);
    const clearThrough = order.evidenceExpiredThroughEpoch || 0;
    // Keep each transaction small and checkpoint each collection. A failed delete leaves
    // the source record intact for a later retry; no active dispute can open during clearing.
    const clearOne = type => async item => {
      if (item.clearedAt || evidenceEpoch(item) > clearThrough) return;
      if (type === 'evidence' && item.kind === 'paymentProof' && item.fileId) await storage.remove(item.fileId);
      await repo.transaction(async tx => {
        const current = await tx.get('orders', order._id), saved = await tx.get(type, item._id);
        if (!current || (current.evidenceExpiredThroughEpoch || 0) < clearThrough) throw error('RETENTION_STATE_CHANGED');
        if (!saved || saved.clearedAt) return;
        if (evidenceEpoch(saved) > clearThrough) return;
        if (type === 'afterSales' && saved.status !== 'closed') throw error('RETENTION_STATE_CHANGED');
        const minimal = { _id: saved._id, kind: saved.kind, orderId: order._id, evidenceEpoch: evidenceEpoch(saved), createdAt: saved.createdAt, clearedAt: now() };
        if (type === 'messages') minimal.speaker = saved.speaker;
        if (type === 'afterSales') Object.assign(minimal, { type: saved.type, status: saved.status, result: saved.result, revision: saved.revision, closedAt: saved.closedAt });
        if (saved.kind === 'privateFeedback') minimal.feedback = saved.feedback;
        await tx.set(type, saved._id, minimal);
        if (saved.assetId) { const asset = await tx.get('assets', saved.assetId); if (asset) await tx.set('assets', asset._id, { _id: asset._id, kind: asset.kind, purpose: asset.purpose, orderId: asset.orderId, status: 'cleared', createdAt: asset.createdAt, clearedAt: now() }); }
      });
    };
    for (const type of ['evidence', 'messages', 'afterSales']) {
      const result = await scan(type, { orderId: order._id }, clearOne(type), budget, { limit: 20, checkpoint: key(`retention:${order._id}:${clearThrough}:${type}`) });
      if (result.hasMore) return;
    }
    await repo.transaction(async tx => {
      const current = await tx.get('orders', order._id);
      if (!current || (current.evidenceExpiredThroughEpoch || 0) < clearThrough) throw error('RETENTION_STATE_CHANGED');
      const allCleared = !current.afterSaleOpen && evidenceEpoch(current) <= clearThrough;
      await tx.set('orders', order._id, { ...current, ...(allCleared ? { paymentQr: null, paymentQrAssetId: null, proofEvidenceId: null, proofHash: null } : {}), evidenceClearedThroughEpoch: clearThrough, evidenceClearing: false, evidenceCleared: allCleared, evidenceClearedAt: now(), revision: current.revision + 1, updatedAt: now() });
      await setAudit(tx, 'server-worker', order._id, 'clearTradeEvidence', 'expiring', 'cleared', `${clearThrough}:${current.revision + 1}`, now());
    });
  }
  async function clearUpload(row, budget) {
    if (row.expiresAt > now() || row.cleanedAt) return;
    await repo.transaction(async tx => {
      const upload = await tx.get('uploads', row._id);
      if (!upload || upload.cleanedAt || upload.expiresAt > now()) throw error('UPLOAD_RETENTION_CHANGED');
      if (upload.status === 'uploading') await tx.set('uploads', upload._id, { ...upload, status: 'expired', updatedAt: now() });
    });
    const job = row.jobId ? await repo.get('jobs', row.jobId) : null;
    if (job && ['queued', 'processing'].includes(job.status)) return;
    const chunks = await repo.query('chunks', { where: { uploadId: row._id }, limit: 80 });
    for (const chunk of chunks) {
      if (Date.now() >= budget) return;
      if (chunk.status === 'cleared') continue;
      if (chunk.fileId) await storage.remove(chunk.fileId);
      await repo.transaction(async tx => {
        const current = await tx.get('chunks', chunk._id);
        if (current && current.status !== 'cleared') await tx.set('chunks', chunk._id, { _id: chunk._id, kind: 'pdfChunk', uploadId: row._id, index: chunk.index, status: 'cleared', createdAt: chunk.createdAt, clearedAt: now() });
      });
    }
    await repo.transaction(async tx => {
      const upload = await tx.get('uploads', row._id);
      if (!upload || upload.cleanedAt) return;
      await tx.set('uploads', row._id, { ...upload, cleanedAt: now(), status: ['uploading', 'failed'].includes(upload.status) ? 'expired' : upload.status });
    });
  }
  async function clearAsset(row) {
    if (row.purpose === 'paymentQr' && row.retained && row.status !== 'cleared') {
      const reserved = await repo.transaction(async tx => {
        const latest = await tx.get('assets', row._id);
        if (!latest || latest.status === 'cleared') return false;
        await tx.set('assets', row._id, { ...latest, status: 'clearing' }); return true;
      });
      if (!reserved) return;
      const profileRefs = await repo.query('profiles', { where: { paymentQrAssetId: row._id }, limit: 1 });
      const orderRefs = await repo.query('orders', { where: { paymentQrAssetId: row._id }, limit: 1 });
      if (profileRefs.length || orderRefs.length) {
        await repo.transaction(async tx => { const latest = await tx.get('assets', row._id); if (latest && latest.status === 'clearing') await tx.set('assets', row._id, { ...latest, status: 'ready' }); });
        return;
      }
      if (row.fileId) await storage.remove(row.fileId);
      await repo.transaction(async tx => { const latest = await tx.get('assets', row._id); if (latest && latest.status === 'clearing') await tx.set('assets', row._id, { _id: row._id, kind: row.kind, purpose: row.purpose, status: 'cleared', createdAt: row.createdAt, clearedAt: now() }); });
      return;
    }
    if (row.retained || !row.expiresAt || row.expiresAt > now() || row.status === 'cleared') return;
    const reserved = await repo.transaction(async tx => {
      const latest = await tx.get('assets', row._id);
      if (!latest || latest.retained || !latest.expiresAt || latest.expiresAt > now() || latest.status === 'cleared') return false;
      await tx.set('assets', row._id, { ...latest, status: 'clearing' }); return true;
    });
    if (!reserved) return;
    if (row.fileId) await storage.remove(row.fileId);
    await repo.transaction(async tx => {
      const latest = await tx.get('assets', row._id);
      if (!latest || latest.retained || !latest.expiresAt || latest.expiresAt > now()) return;
      await tx.set('assets', row._id, { _id: row._id, kind: row.kind, purpose: row.purpose, status: 'cleared', createdAt: row.createdAt, clearedAt: now() });
    });
  }
  async function clearGarbage(row) {
    if (row.status !== 'pending') return;
    await storage.remove(row.fileId);
    await repo.transaction(async tx => {
      const latest = await tx.get('jobs', row._id);
      if (latest && latest.status === 'pending') await tx.set('jobs', row._id, { _id: row._id, kind: 'fileGarbage', targetId: row.targetId, status: 'cleared', createdAt: row.createdAt, clearedAt: now() });
    });
  }
  async function clearReservation(row) {
    if (!['staged', 'clearing'].includes(row.status) || row.expiresAt > now()) return;
    const reserved = await repo.transaction(async tx => {
      const current = await tx.get('jobs', row._id);
      if (!current || current.status !== 'staged' || current.expiresAt > now()) return false;
      await tx.set('jobs', row._id, { ...current, status: 'clearing' }); return true;
    });
    if (!reserved && row.status !== 'clearing') return;
    await storage.remove(row.fileId);
    await repo.transaction(async tx => {
      const current = await tx.get('jobs', row._id);
      if (current && current.status === 'clearing') await tx.set('jobs', row._id, { _id: row._id, kind: 'fileReservation', targetId: row.targetId, status: 'cleared', createdAt: row.createdAt, clearedAt: now() });
    });
  }
  async function clearAbandonedVersion(row) {
    if (!['processed', 'clearing'].includes(row.status) || now() - row.createdAt < 7 * DAY) return;
    const reserved = await repo.transaction(async tx => {
      const latest = await tx.get('versions', row._id);
      if (!latest || !['processed', 'clearing'].includes(latest.status) || now() - latest.createdAt < 7 * DAY) return false;
      await tx.set('versions', row._id, { ...latest, status: 'clearing' }); return true;
    });
    if (!reserved) return;
    const references = await Promise.all([
      repo.query('materials', { where: { currentVersionId: row._id }, limit: 1 }),
      repo.query('materials', { where: { pendingVersionId: row._id }, limit: 1 }),
      repo.query('orders', { where: { versionId: row._id }, limit: 1 }),
    ]);
    if (references.some(rows => rows.length)) {
      await repo.transaction(async tx => { const latest = await tx.get('versions', row._id); if (latest && latest.status === 'clearing') await tx.set('versions', row._id, { ...latest, status: 'processed' }); });
      return;
    }
    if (row.sourceFileId) await storage.remove(row.sourceFileId);
    if (row.previewFileId) await storage.remove(row.previewFileId);
    await repo.transaction(async tx => {
      const latest = await tx.get('versions', row._id);
      if (latest && latest.status === 'clearing') await tx.set('versions', row._id, { _id: row._id, kind: 'materialVersion', materialId: row.materialId, sellerId: row.sellerId, sha256: row.sha256, pageCount: row.pageCount, status: 'cleared', createdAt: row.createdAt, clearedAt: now() });
    });
  }

  return async function handle(event = {}) {
    const identity = context();
    if (!identity || identity.SOURCE !== 'wx_trigger' || identity.OPENID || identity.UNIONID || identity.FROM_OPENID) return { ok: false, version: VERSION, code: 'FORBIDDEN' };
    if (!['Timer', 'timer'].includes(event.Type) || event.TriggerName !== TRIGGER_NAME) {
      // Log only bounded routing metadata after runtime-source authorization.
      // Never dump the event: it may contain caller-controlled private content.
      const metadata = value => typeof value === 'string' ? value.replace(/[^a-zA-Z0-9_:\-./]/g, '?').slice(0, 100) : typeof value;
      logger.error('trade_timer_route_rejected', {
        type: metadata(event.Type), triggerName: metadata(event.TriggerName),
        keys: Object.keys(event).filter(key => /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key)).slice(0, 20),
      });
      return { ok: false, version: VERSION, code: 'INVALID_TRIGGER' };
    }
    const budget = Date.now() + deadlineMs;
    // The lock limits processing to one worker invocation across overlapping timer events.
    const lockId = '__trade_worker_lock', token = randomBytes(12).toString('hex');
    const locked = await repo.transaction(async tx => {
      const lock = await tx.get('jobs', lockId);
      if (lock && lock.leaseUntil > now()) return false;
      await tx.set('jobs', lockId, { kind: 'workerLock', token, leaseUntil: now() + 90000, createdAt: now() }); return true;
    });
    if (!locked) return { ok: true, version: VERSION, busy: true };
    const counts = { processed: 0, failed: 0, maintenanceFailed: 0 };
    try {
      const safe = work => async row => { try { await work(row); } catch (err) { counts.maintenanceFailed += 1; logger.error('trade_maintenance_item_failed', { targetId: row._id, code: err.code || 'unknown' }); } };
      // Reserve maintenance time even while uploads arrive continuously. Saved
      // cursors also prevent newest-first job queues from starving older work.
      const jobBudget = budget - Math.min(24000, Math.floor(deadlineMs / 2));
      const jobSchedule = await repo.get('jobs', '__job_phase'), jobStart = jobSchedule && jobSchedule.next || 0;
      const jobStatuses = ['queued', 'processing'];
      for (let offset = 0; offset < jobStatuses.length; offset += 1) {
        const status = jobStatuses[(jobStart + offset) % jobStatuses.length];
        if (Date.now() > jobBudget - 16000) break;
        const checkpoint = `__process_${status}_cursor`, saved = await repo.get('jobs', checkpoint);
        const rows = await repo.query('jobs', { where: { kind: 'fileJob', status }, cursor: saved && saved.cursor, limit: 3 });
        let last = null;
        for (const row of rows) {
          if (Date.now() > jobBudget - 16000) break;
          const job = await takeJob(row._id);
          if (job) { if (await processJob(job)) counts.processed += 1; else counts.failed += 1; }
          last = { createdAt: row.createdAt, _id: row._id };
        }
        if (last || rows.length === 0) await repo.transaction(tx => tx.set('jobs', checkpoint, { _id: checkpoint, kind: 'maintenanceCursor', cursor: rows.length < 3 ? null : last, createdAt: now(), updatedAt: now() }));
      }
      await repo.transaction(tx => tx.set('jobs', '__job_phase', { _id: '__job_phase', kind: 'maintenanceSchedule', next: (jobStart + 1) % jobStatuses.length, createdAt: now(), updatedAt: now() }));
      // QR profiles are small retained records; expired proofs and unreferenced QR files
      // are swept without issuing public URLs or touching active purchase copies.
      const phases = [
        ['orders', { kind: 'order' }, maintainOrder, '__maintain_order_cursor'],
        ['orders', { kind: 'order' }, (row, phaseBudget) => clearOrder(row, phaseBudget), '__clear_order_cursor'],
        ['uploads', { kind: 'pdfUpload' }, clearUpload, '__clear_upload_cursor'],
        ['assets', { kind: 'privateImage' }, clearAsset, '__clear_asset_cursor'],
        ['jobs', { kind: 'fileGarbage', status: 'pending' }, clearGarbage, '__clear_garbage_cursor'],
        ['jobs', { kind: 'fileReservation' }, clearReservation, '__clear_reservation_cursor'],
        ['versions', { kind: 'materialVersion' }, clearAbandonedVersion, '__clear_abandoned_version_cursor'],
      ];
      const schedule = await repo.get('jobs', '__maintenance_phase'), start = schedule && schedule.next || 0;
      for (let offset = 0; offset < phases.length; offset += 1) {
        const index = (start + offset) % phases.length, [type, where, work, checkpoint] = phases[index];
        const remaining = budget - Date.now(); if (remaining <= 0) break;
        const phaseBudget = Math.min(budget, Date.now() + Math.max(1000, Math.floor(remaining / (phases.length - offset))));
        await scan(type, where, safe(row => work(row, phaseBudget)), phaseBudget, { checkpoint });
      }
      await repo.transaction(tx => tx.set('jobs', '__maintenance_phase', { _id: '__maintenance_phase', kind: 'maintenanceSchedule', next: (start + 1) % phases.length, createdAt: now(), updatedAt: now() }));
      if (counts.maintenanceFailed) throw error('TRADE_MAINTENANCE_INCOMPLETE');
      logger.info('trade_maintenance_complete', { version: VERSION, ...counts });
      return { ok: true, version: VERSION, ...counts };
    } finally {
      await repo.transaction(async tx => { const lock = await tx.get('jobs', lockId); if (lock && lock.token === token) await tx.set('jobs', lockId, { ...lock, leaseUntil: 0 }); });
    }
  };
}
module.exports = { createWorker, VERSION, TRIGGER_NAME, DAY, HOUR };
