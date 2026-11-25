const test = require('node:test');
const assert = require('node:assert/strict');
const { createEntry } = require('../../cloudfunctions/xiaopinWall/entry');
const quiet = { warn() {}, error() {} };
const event = { Event: 'wxa_media_check', trace_id: 'trace', result: { suggest: 'pass' } };
function build(identity, configured = []) {
  let calls = 0;
  const service = async () => ({ ok: true, regular: true });
  service.handleMediaCallback = async (_, trusted) => { assert.equal(trusted, true); calls += 1; return { status: 'approved' }; };
  return { main: createEntry({ service, context: () => identity, appid: 'app', environment: 'env', callbackSources: configured, logger: quiet }), calls: () => calls };
}
test('media callback entry stays closed without a verified server source configuration', async () => {
  const r = build({ APPID: 'app', ENV: 'env', SOURCE: 'wx_unknown' });
  assert.equal((await r.main(event)).code, 'FORBIDDEN'); assert.equal(r.calls(), 0);
});
test('client cannot forge callback source, identity or trust flags in event', async () => {
  for (const identity of [{ APPID: 'app', ENV: 'env', SOURCE: 'wx_client', OPENID: 'user' }, { APPID: 'app', ENV: 'env', SOURCE: 'wx_client,scf' }]) {
    const r = build(identity, ['wx_unknown', 'wx_client', 'wx_client,scf']);
    assert.equal((await r.main({ ...event, trusted: true, SOURCE: 'wx_unknown', OPENID: '' })).code, 'FORBIDDEN');
    assert.equal(r.calls(), 0);
  }
});
test('only configured runtime source in the right environment reaches callback handler', async () => {
  const r = build({ APPID: 'app', ENV: 'env', SOURCE: 'platform-event' }, ['platform-event']);
  assert.equal((await r.main(event)).status, 'approved'); assert.equal(r.calls(), 1);
  assert.equal((await r.main({ ...event, action: 'publish' })).code, 'FORBIDDEN');
  for (const identity of [{ APPID: 'other', ENV: 'env', SOURCE: 'platform-event' }, { APPID: 'app', ENV: 'other', SOURCE: 'platform-event' }, { APPID: 'app', ENV: 'env', SOURCE: 'platform-event', FROM_OPENID: 'user' }]) {
    const blocked = build(identity, ['platform-event']); assert.equal((await blocked.main(event)).code, 'FORBIDDEN'); assert.equal(blocked.calls(), 0);
  }
});
test('regular client actions retain their existing identity validation path', async () => {
  const r = build({ OPENID: 'user' }); assert.equal((await r.main({ action: 'session' })).regular, true);
});

test('WeChat push can carry user identity, but source and deployment identity still come from runtime', async () => {
  const runtime = { APPID: 'app', ENV: 'env', SOURCE: 'wx_callback', OPENID: 'subject' };
  assert.equal((await build(runtime).main(event)).status, 'approved');
  for (const override of [{ APPID: 'other' }, { ENV: 'other' }, { SOURCE: 'wx_client' }, { SOURCE: 'wx_callback,wx_client' }]) {
    const r = build({ ...runtime, ...override });
    assert.equal((await r.main({ ...event, SOURCE: 'wx_callback' })).code, 'FORBIDDEN');
    assert.equal(r.calls(), 0);
  }
});
