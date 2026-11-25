'use strict';

// Runtime context is injected by WeChat. The request body never selects a
// trusted source. WeChat message push may include the subject identity.
function createEntry({ service, context, environment, appid, callbackSources = [], logger = console }) {
  const sources = new Set(callbackSources.filter(value => typeof value === 'string' && value &&
    !value.split(',').some(part => ['wx_client', 'wx_devtools', 'wx_localdebug', 'scf'].includes(part))));
  return async function main(event = {}) {
    const identity = context() || {};
    if (event.Event !== 'wxa_media_check') return service(event, identity);
    const hasClient = !!(identity.OPENID || identity.UNIONID || identity.FROM_OPENID || identity.FROM_UNIONID);
    const isWeChatPush = identity.SOURCE === 'wx_callback';
    const trusted = identity.APPID === appid && identity.ENV === environment &&
      !event.action && (isWeChatPush || (!hasClient && sources.has(identity.SOURCE)));
    if (!trusted) {
      logger.warn('media_callback_source_rejected', {
        hasClient, source: typeof identity.SOURCE === 'string' ? identity.SOURCE : 'missing',
        appMatches: identity.APPID === appid, envMatches: identity.ENV === environment,
      });
      return { ok: false, code: 'FORBIDDEN', message: '审核回调来源未通过核验。' };
    }
    try { return { ok: true, ...(await service.handleMediaCallback(event, true)) }; }
    catch (error) {
      logger.error('media_callback_failed', { code: error.code || 'unknown' });
      throw error;
    }
  };
}

module.exports = { createEntry };
