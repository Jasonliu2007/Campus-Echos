'use strict';

const VERSION = 'report-cleanup-20261113-v2.1';
const TRIGGER_NAME = 'report-evidence-daily';
const { cleanupExpired } = require('./report-cleanup');
const { garbageCollectMedia } = require('./media-lifecycle');

// Authorization comes from the runtime context, never from a client-supplied role.
// Empty context, HTTP and client/scf chains cannot become timers by imitating the payload.
function createCleanupHandler({ repo, context, now = Date.now, logger = console, storage }) {
  return async function handle(event = {}) {
    const identity = context();
    if (!identity || identity.SOURCE !== 'wx_trigger' || identity.OPENID || identity.UNIONID || identity.FROM_OPENID) {
      return { ok: false, version: VERSION, code: 'FORBIDDEN' };
    }
    if (!event || !['Timer', 'timer'].includes(event.Type) || event.TriggerName !== TRIGGER_NAME) {
      return { ok: false, version: VERSION, code: 'INVALID_TRIGGER' };
    }
    try {
      const result = await cleanupExpired({ repo, now, logger, ...(storage ? { mediaGarbageCollect: ({ at }) => garbageCollectMedia({ repo, storage, at, logger }) } : {}) });
      if (result.failed || result.hasMore) {
        const error = new Error('Evidence cleanup incomplete; safe to retry');
        error.code = 'CLEANUP_INCOMPLETE'; throw error;
      }
      logger.info('report_evidence_cleanup_complete', { version: VERSION, ...result });
      return { ok: true, version: VERSION, ...result };
    } catch (error) {
      logger.error('report_evidence_cleanup_run_failed', { version: VERSION, code: error.code || error.errCode || 'unknown' });
      // Reject the invocation so the service reports failure and retries can safely resume.
      throw error;
    }
  };
}
module.exports = { createCleanupHandler, VERSION, TRIGGER_NAME };
