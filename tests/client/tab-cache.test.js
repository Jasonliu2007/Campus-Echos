const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, event } = require('./runtime');
const route = 'pages/campus-wall/index';
const member = { id: 'same-member', role: 'member' };
const approved = { member, access: 'approved', canManageAdmins: false };
const ids = page => Array.from(page.data.items, item => item._id);

async function loaded(r, options = {}) {
  const p = r.list({ route, filters: true, ...options });
  const shown = p.onShow();
  assert.equal(r.requests[0].data.action, 'session');
  r.requests.shift().resolve(approved); await tick();
  const list = r.requests.shift(); assert.equal(list.data.action, options.action || 'list');
  list.resolve({ posts: [{ _id: 'first', content: '第一条' }], hasMore: true, nextCursor: 'page-2' });
  await shown; return p;
}

test('校园墙返回保留已加载分页、筛选和错误状态，不再查询列表或显示刷新态', async () => {
  const r = runtime(), p = await loaded(r);
  p.setData({ filter: '学习互助' });
  const next = p.load(false);
  assert.equal(r.requests[0].data.cursor, 'page-2');
  r.requests.shift().resolve({ posts: [{ _id: 'second' }], hasMore: true, nextCursor: 'page-3' }); await next;
  p.setData({ pageError: '上次翻页失败信息' });
  const returned = p.onShow();
  assert.deepEqual(ids(p), ['first', 'second']); assert.equal(p.data.loading, false);
  assert.equal(p.data.filter, '学习互助'); assert.equal(p.data.nextCursor, 'page-3');
  assert.equal(r.requests.length, 1); assert.equal(r.requests[0].data.action, 'session');
  r.requests.shift().resolve(approved); await returned;
  assert.deepEqual(ids(p), ['first', 'second']); assert.equal(p.data.nextCursor, 'page-3');
  assert.equal(p.data.pageError, '上次翻页失败信息'); assert.equal(r.requests.length, 0);
});
test('空列表同样缓存，只有新运行实例或显式下拉才重新查询首屏', async () => {
  const r = runtime(), p = r.list({ route });
  let shown = p.onShow(); r.requests.shift().resolve(approved); await tick();
  r.requests.shift().resolve({ posts: [], hasMore: false, nextCursor: null }); await shown;
  shown = p.onShow(); r.requests.shift().resolve(approved); await shown;
  assert.equal(r.requests.length, 0); assert.deepEqual(ids(p), []);
  const manual = p.onPullDownRefresh(); r.requests.shift().resolve(approved); await tick();
  assert.equal(r.requests[0].data.action, 'list');
  r.requests.shift().resolve({ posts: [], hasMore: false, nextCursor: null }); await manual;
  const restarted = runtime(), fresh = restarted.list({ route });
  shown = fresh.onShow(); restarted.requests.shift().resolve(approved); await tick();
  assert.equal(restarted.requests[0].data.action, 'list');
  restarted.requests.shift().resolve({ posts: [], hasMore: false, nextCursor: null }); await shown;
});
test('返回时权限核对网络失败仅提示，保留帖子和分页；恢复后清掉提示', async () => {
  const r = runtime(), p = await loaded(r);
  let shown = p.onShow(); r.requests.shift().reject(Error('offline')); await shown;
  assert.deepEqual(ids(p), ['first']); assert.equal(p.data.nextCursor, 'page-2');
  assert.equal(p.data.access, 'approved'); assert.equal(p.data.loading, false);
  assert.equal(p.data.error, ''); assert.match(p.data.sessionNotice, /保留/);
  shown = p.onShow(); r.requests.shift().resolve(approved); await shown;
  assert.equal(p.data.sessionNotice, ''); assert.equal(r.requests.length, 0);
});
test('明确资格撤销清缓存和游标，旧分页晚到不能重新显示', async () => {
  const r = runtime(), p = await loaded(r);
  const next = p.load(false), oldPage = r.requests.shift();
  const shown = p.onShow(); r.requests.shift().resolve({ member, access: 'revoked' }); await shown;
  assert.deepEqual(ids(p), []); assert.equal(p.data.nextCursor, null);
  assert.equal(p.data.hasMore, false); assert.equal(p.data.loadingMore, false);
  oldPage.resolve({ posts: [{ _id: 'late-private' }], hasMore: true, nextCursor: 'stale' }); await next;
  assert.deepEqual(ids(p), []); assert.equal(p.data.access, 'revoked');
});
test('静默会话较旧响应不能覆盖新撤销结论，ACCESS_DENIED也会清缓存', async () => {
  const r = runtime(), p = await loaded(r);
  const first = p.onShow(), old = r.requests.shift();
  const second = p.onShow(), current = r.requests.shift();
  current.resolve({ ok: false, code: 'ACCESS_DENIED', message: '资格撤销' }); await second;
  old.resolve(approved); await first;
  assert.deepEqual(ids(p), []); assert.equal(p.data.access, 'revoked');
  assert.equal(p.data.canManageAdmins, false); assert.equal(r.requests.length, 0);
});
test('列表拒绝后晚到的正面会话也不能重开资格', async () => {
  const r = runtime(), p = await loaded(r);
  const next = p.load(false), pageRequest = r.requests.shift();
  const shown = p.onShow(), sessionRequest = r.requests.shift();
  pageRequest.resolve({ ok: false, code: 'ACCESS_DENIED', message: '已撤销' }); await next;
  sessionRequest.resolve(approved); await shown;
  assert.equal(p.data.access, 'revoked'); assert.deepEqual(ids(p), []);
});
test('正面静默核对不取消在途分页，并同步最新管理授权', async () => {
  const r = runtime(), p = await loaded(r);
  const next = p.load(false), pendingPage = r.requests.shift();
  const shown = p.onShow();
  r.requests.shift().resolve({ ...approved, canManageAdmins: true }); await shown;
  assert.equal(p.data.loadingMore, true); assert.equal(p.data.canManageAdmins, true);
  pendingPage.resolve({ posts: [{ _id: 'second' }], hasMore: false, nextCursor: null }); await next;
  assert.deepEqual(ids(p), ['first', 'second']); assert.equal(p.data.loadingMore, false);
});
test('我的帖子等业务子页维持刷新，校园墙明确改分区仍读取新列表', async () => {
  const r = runtime(), p = await loaded(r, { route: '', action: 'listMine' });
  const shown = p.onShow(); r.requests.shift().resolve(approved); await tick();
  assert.equal(r.requests[0].data.action, 'listMine');
  r.requests.shift().resolve({ posts: [], hasMore: false, nextCursor: null }); await shown;
  const wall = await loaded(r); wall.changeFilter(event({ value: '失物招领' }));
  assert.equal(r.requests[0].data.action, 'list'); assert.equal(r.requests[0].data.category, '失物招领');
  r.requests.shift().resolve({ posts: [], hasMore: false, nextCursor: null }); await tick();
});

test('首载未完成时快速返回只共用一轮请求', async () => {
  const r = runtime(), p = r.list({ route });
  const first = p.onShow(), second = p.onShow();
  assert.equal(r.requests.length, 1);
  r.requests.shift().resolve(approved); await tick();
  assert.equal(r.requests.length, 1); assert.equal(r.requests[0].data.action, 'list');
  r.requests.shift().resolve({ posts: [], hasMore: false, nextCursor: null });
  await Promise.all([first, second]); assert.equal(r.requests.length, 0);
});
test('账号身份改变不复用旧账号内容，同时保留新会话的真实管理能力', async () => {
  const r = runtime(), p = await loaded(r);
  const shown = p.onShow();
  r.requests.shift().resolve({ access: 'approved', member: { id: 'other', role: 'admin' }, canManageAdmins: true }); await tick();
  assert.deepEqual(ids(p), []); assert.equal(p.data.nextCursor, null);
  assert.equal(r.requests[0].data.action, 'list');
  r.requests.shift().resolve({ posts: [{ _id: 'other-account-post' }], hasMore: false, nextCursor: null }); await shown;
  assert.deepEqual(ids(p), ['other-account-post']); assert.equal(p.data.canManageAdmins, true);
});

test('UNAUTHENTICATED明确拒绝会清受保护缓存和提示，晚到分页不能恢复', async () => {
  for (const source of ['session', 'list']) {
    const r = runtime(), p = await loaded(r);
    p.setData({ wallNotice: '先前状态', sessionNotice: '先前离线保留提示' });
    const next = p.load(false), oldPage = r.requests.shift();
    if (source === 'session') {
      const shown = p.onShow();
      r.requests.shift().resolve({ ok: false, code: 'UNAUTHENTICATED', message: '登录已失效' }); await shown;
      oldPage.resolve({ posts: [{ _id: 'late' }], hasMore: true, nextCursor: 'late' });
    } else oldPage.resolve({ ok: false, code: 'UNAUTHENTICATED', message: '登录已失效' });
    await next;
    assert.deepEqual(ids(p), [], source); assert.equal(p.data.nextCursor, null);
    assert.equal(p.data.hasMore, false); assert.equal(p.data.canManageAdmins, false);
    assert.equal(p.data.wallNotice, ''); assert.equal(p.data.sessionNotice, '');
    assert.equal(p.data.loading, false); assert.equal(p.data.loadingMore, false);
  }
});
test('列表重读成功清掉旧帖子状态提示，保留现有分区和正常分页能力', async () => {
  const r = runtime(), p = await loaded(r);
  p.setData({ wallNotice: '刚刚发布的提示', filter: '学习互助' });
  const next = p.load(false);
  r.requests.shift().resolve({ posts: [{ _id: 'second' }], hasMore: true, nextCursor: 'page-3' }); await next;
  assert.equal(p.data.wallNotice, ''); assert.equal(p.data.filter, '学习互助');
  assert.deepEqual(ids(p), ['first', 'second']); assert.equal(p.data.nextCursor, 'page-3');
});
