const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, input, event } = require('./runtime');

function composer(r) {
  const p = r.page('wall-publish/index');
  p.setData({ allowed: true, title: '真实测试标题', content: '完整的正文内容' });
  return p;
}

function approvedList(r) {
  const p = r.list({ filters: true });
  p.setData({ access: 'approved', member: { role: 'member' }, loading: false });
  return p;
}

const ids = page => Array.from(page.data.items, row => row._id);

test('重复发布只发送一次请求；超时后保留输入和去重键，成功后清草稿', async () => {
  const r = runtime();
  const p = composer(r);
  const first = p.submit();
  const duplicate = p.submit();
  assert.equal(r.requests.length, 1);
  const failed = r.requests.shift();
  const requestId = failed.data.requestId;
  failed.reject(new Error('timeout'));
  await Promise.all([first, duplicate]);
  assert.equal(p.data.title, '真实测试标题');
  assert.equal(p.data.content, '完整的正文内容');
  assert.equal(p.data.submitting, false);
  assert.equal(r.storage.get('campusEchoDraftV1').requestId, requestId);
  assert.match(p.data.error, /连接/);

  const retry = p.submit();
  const next = r.requests.shift();
  assert.equal(next.data.requestId, requestId);
  next.resolve({ postId: 'p', status: 'pending', revision: 1 });
  await retry;
  assert.equal(r.storage.has('campusEchoDraftV1'), false);
  assert.equal(p.data.result.status, 'pending');
  assert.equal(p.data.submitting, false);
});

test('超时后改动内容会使用新的发布去重键', async () => {
  const r = runtime();
  const p = composer(r);
  let pending = p.submit();
  const first = r.requests.shift();
  first.reject(new Error('offline'));
  await pending;
  p.input(input('content', '修改后的完整正文'));
  pending = p.submit();
  const second = r.requests.shift();
  assert.notEqual(first.data.requestId, second.data.requestId);
  second.resolve({ postId: 'p', status: 'pending', revision: 1 });
  await pending;
});

test('草稿存储失败时保存离开仍留在原页，恢复存储后才导航', async () => {
  const r = runtime();
  const p = composer(r);
  r.state.storageFails = true;
  let leaving = p.cancel();
  r.modals.shift().success({ confirm: true });
  await leaving;
  assert.equal(r.navigation.length, 0);
  assert.equal(r.state.alertsDisabled, 0);
  assert.equal(p.data.content, '完整的正文内容');
  assert.match(r.alerts.at(-1), /尚未保存/);
  assert.match(p.data.error, /未能保存/);

  r.state.storageFails = false;
  leaving = p.cancel();
  r.modals.shift().success({ confirm: true });
  await leaving;
  assert.equal(r.navigation.length, 1);
  assert.equal(r.storage.get('campusEchoDraftV1').content, '完整的正文内容');
  assert.equal(r.state.alertsDisabled, 1);
});

test('草稿恢复保留分区、正文及既有请求键', () => {
  const r = runtime();
  r.storage.set('campusEchoDraftV1', {
    title: '保存的标题', content: '正文😀', category: '学习互助', requestId: 'saved-request', fingerprint: 'saved-fingerprint',
  });
  const p = r.page('wall-publish/index');
  p.onLoad();
  assert.equal(p.data.title, '保存的标题');
  assert.equal(p.data.contentCount, 3);
  assert.equal(p._request, 'saved-request');
  assert.equal(p._fingerprint, 'saved-fingerprint');
  assert.equal(p._draftSaved, true);
  assert.match(r.alerts.at(-1), /已保存/);
});

test('发布字段错误保留输入并聚焦首个错误，超过Unicode字数不请求云端', async () => {
  const r = runtime();
  const p = composer(r);
  p.setData({ title: '😀'.repeat(61) });
  await p.submit();
  assert.equal(r.requests.length, 0);
  assert.equal(p.data.focusTitle, true);
  assert.match(p.data.titleError, /60/);
  assert.equal(p.data.content, '完整的正文内容');
});

test('新分区先返回时，旧分区晚返回不能覆盖当前列表', async () => {
  const r = runtime();
  const p = approvedList(r);
  p.changeFilter(event({ value: '学习互助' }));
  const older = r.requests.shift();
  p.changeFilter(event({ value: '失物招领' }));
  const newer = r.requests.shift();
  newer.resolve({ posts: [{ _id: 'newer' }], hasMore: false, nextCursor: null });
  await tick();
  older.resolve({ posts: [{ _id: 'older' }], hasMore: true, nextCursor: 'old' });
  await tick();
  assert.deepEqual(ids(p), ['newer']);
  assert.equal(p.data.filter, '失物招领');
  assert.equal(p.data.nextCursor, null);
});

test('分页失败保留已读内容和游标，重试去重并追加下一页', async () => {
  const r = runtime();
  const p = approvedList(r);
  p.setData({ items: [{ _id: 'first' }], hasMore: true, nextCursor: 'page-2' });
  let pending = p.load(false);
  r.requests.shift().reject(new Error('offline'));
  await pending;
  assert.deepEqual(ids(p), ['first']);
  assert.equal(p.data.nextCursor, 'page-2');
  assert.equal(p.data.loadingMore, false);
  assert.match(p.data.pageError, /连接/);

  pending = p.load(false);
  const next = r.requests.shift();
  assert.equal(next.data.cursor, 'page-2');
  next.resolve({ posts: [{ _id: 'first' }, { _id: 'second' }], hasMore: false, nextCursor: null });
  await pending;
  assert.deepEqual(ids(p), ['first', 'second']);
  assert.equal(p.data.pageError, '');
  assert.equal(p.data.hasMore, false);
});

test('重复加载下一页只发一次云请求', async () => {
  const r = runtime();
  const p = approvedList(r);
  p.setData({ hasMore: true, nextCursor: 'next' });
  const first = p.load(false);
  const duplicate = p.load(false);
  assert.equal(r.requests.length, 1);
  r.requests.shift().resolve({ posts: [], hasMore: false, nextCursor: null });
  await Promise.all([first, duplicate]);
  assert.equal(p.data.loadingMore, false);
});

test('资格撤销后清除缓存，撤销前在途列表晚到也不能重新显示', async () => {
  const r = runtime();
  const p = approvedList(r);
  p.setData({ items: [{ _id: 'private-cache' }] });
  const oldRun = p.load(true);
  const old = r.requests.shift();
  const refresh = p.refreshSession();
  r.requests.shift().resolve({ access: 'revoked', member: { role: 'member' } });
  await refresh;
  old.resolve({ posts: [{ _id: 'stale' }], hasMore: false, nextCursor: null });
  await oldRun;
  assert.deepEqual(ids(p), []);
  assert.equal(p.data.access, 'revoked');
  assert.equal(p.data.loading, false);
});

test('读帖被拒绝时清除可见缓存并立即转资格撤销状态', async () => {
  const r = runtime();
  const p = approvedList(r);
  p.setData({ items: [{ _id: 'cached' }] });
  const pending = p.load(true);
  r.requests.shift().resolve({ ok: false, code: 'ACCESS_DENIED', message: '资格已撤销' });
  await pending;
  assert.deepEqual(ids(p), []);
  assert.equal(p.data.access, 'revoked');
});

test('普通网络刷新失败保留现有帖子并提供错误信息', async () => {
  const r = runtime();
  const p = approvedList(r);
  p.setData({ items: [{ _id: 'cached' }] });
  const pending = p.load(true);
  r.requests.shift().reject(new Error('offline'));
  await pending;
  assert.deepEqual(ids(p), ['cached']);
  assert.match(p.data.error, /连接/);
  assert.equal(p.data.loading, false);
});

test('申请未提交时提醒离开，失败保留输入；提交成功后清除提醒', async () => {
  const r = runtime();
  const p = r.page('access/index');
  p.setData({ access: 'none' });
  p.input(input('nickname', '申请同学'));
  p.input(input('reason', '希望参与校园墙内测'));
  p.setData({ terms: true });
  assert.match(r.alerts.at(-1), /尚未提交/);
  let pending = p.submit();
  r.requests.shift().reject(new Error('offline'));
  await pending;
  assert.equal(p.data.nickname, '申请同学');
  assert.equal(p.data.reason, '希望参与校园墙内测');
  assert.equal(p.data.submitting, false);
  pending = p.submit();
  r.requests.shift().resolve({ member: { status: 'pending' }, access: 'pending' });
  await pending;
  assert.equal(p.data.access, 'pending');
  assert.equal(r.state.alertsDisabled, 1);
});

test('重复删除点击只弹出一个确认，取消不会发送删除请求', async () => {
  const r = runtime();
  const p = r.page('wall-detail/index');
  p.setData({ post: { _id: 'p', revision: 1, isOwner: true } });
  const first = p.remove();
  const duplicate = p.remove();
  assert.equal(r.modals.length, 1);
  r.modals.shift().success({ confirm: false });
  await Promise.all([first, duplicate]);
  assert.equal(r.requests.length, 0);
  assert.equal(p._confirming, false);
});

test('两个辅助设置独立保存并在重新进入时恢复', () => {
  const r = runtime();
  const p = r.page('setting/index');
  p.onShow();
  p.transparency({ detail: { value: true } });
  assert.equal(p.data.reducedMotion, false);
  assert.equal(p.data.reducedTransparency, true);
  p.motion({ detail: { value: true } });
  p.transparency({ detail: { value: false } });
  assert.equal(r.storage.get('campusReducedMotion'), true);
  assert.equal(r.storage.get('campusReducedTransparency'), false);
  p.setData({ reducedMotion: false, reducedTransparency: true });
  p.onShow();
  assert.equal(p.data.reducedMotion, true);
  assert.equal(p.data.reducedTransparency, false);
});

test('设置存储失败恢复原值并报错，重试成功不影响另一设置', () => {
  const r = runtime();
  const p = r.page('setting/index');
  p.motion({ detail: { value: true } });
  p.transparency({ detail: { value: true } });
  r.state.storageFails = true;
  p.motion({ detail: { value: false } });
  assert.equal(p.data.reducedMotion, true);
  assert.equal(p.data.reducedTransparency, true);
  assert.match(p.data.settingsError, /未能保存/);
  r.state.storageFails = false;
  p.motion({ detail: { value: false } });
  assert.equal(p.data.reducedMotion, false);
  assert.equal(p.data.reducedTransparency, true);
  assert.equal(p.data.settingsError, '');
});

test('快速连续导航不重复跳转，完成后解锁并同步两个辅助设置', () => {
  const r = runtime();
  r.storage.set('campusReducedTransparency', true);
  const p = r.tab();
  p.switchTab(event({ path: 'pages/materials/index' }));
  p.switchTab(event({ path: 'pages/partners/index' }));
  assert.equal(r.switches.length, 1);
  r.switches[0].success();
  r.switches[0].complete();
  assert.equal(p.data.active, 'pages/materials/index');
  assert.equal(p.data.reducedTransparency, true);
  assert.equal(p.data.reducedMotion, false);
  p.switchTab(event({ path: 'pages/partners/index' }));
  assert.equal(r.switches.length, 2);
  r.switches[1].complete();
  assert.equal(p._switching, false);
});

test('审核违规终态响应后重新读取状态并解除处理中状态', async () => {
  const r = runtime();
  const p = r.page('admin-review/detail');
  p.postId = 'p';
  p.setData({ post: { _id: 'p', status: 'pending', revision: 1 } });
  const pending = p.decide(event({ decision: 'approve' }));
  r.modals.shift().success({ confirm: true });
  await tick();
  const decision = r.requests.shift();
  assert.equal(decision.data.action, 'reviewPost');
  decision.resolve({ ok: false, code: 'CONTENT_REJECTED', message: '微信复核判定违规，已驳回。' });
  await tick();
  const session = r.requests.shift();
  assert.equal(session.data.action, 'session');
  session.resolve({ access: 'approved', member: { role: 'admin' } });
  await tick();
  const post = r.requests.shift();
  assert.equal(post.data.action, 'getPost');
  post.resolve({ post: { _id: 'p', status: 'rejected', revision: 2 } });
  await pending;
  assert.equal(p.data.post.status, 'rejected');
  assert.equal(p.data.post.revision, 2);
  assert.equal(p.data.processing, false);
  assert.match(p.data.error, /已驳回/);
});

test('审核及成员处理原因缺失时聚焦错误且不提交', async () => {
  const r = runtime();
  const review = r.page('admin-review/detail');
  review.setData({ post: { status: 'pending', revision: 1 } });
  await review.decide(event({ decision: 'reject' }));
  assert.equal(review.data.focusReason, true);
  assert.match(review.data.reasonError, /200/);
  const members = r.page('admin-members/index');
  members.setData({ reasonFor: 'member', decision: 'reject', reason: '' });
  members.submitReason();
  assert.equal(members.data.focusReason, true);
  assert.match(members.data.formError, /200/);
  assert.equal(r.modals.length, 0);
  assert.equal(r.requests.length, 0);
});


test('分页中刷新资格失败会解锁；旧响应丢弃且保留游标可重试', async () => {
  const r = runtime();
  const p = approvedList(r);
  p.setData({ items: [{ _id: 'first' }], hasMore: true, nextCursor: 'page-2' });
  const oldRun = p.load(false);
  const old = r.requests.shift();
  assert.equal(p.data.loadingMore, true);
  const refresh = p.refreshSession();
  r.requests.shift().reject(new Error('offline'));
  await refresh;
  assert.equal(p.data.loadingMore, false);
  assert.equal(p.data.loading, false);
  assert.deepEqual(ids(p), ['first']);
  assert.equal(p.data.nextCursor, 'page-2');
  old.resolve({ posts: [{ _id: 'stale' }], hasMore: false, nextCursor: null });
  await oldRun;
  assert.deepEqual(ids(p), ['first']);
  const retry = p.load(false);
  const request = r.requests.shift();
  assert.equal(request.data.cursor, 'page-2');
  request.resolve({ posts: [{ _id: 'second' }], hasMore: false, nextCursor: null });
  await retry;
  assert.deepEqual(ids(p), ['first', 'second']);
  assert.equal(p.data.loadingMore, false);
});

test('资格撤销会清空分页游标并释放旧分页状态', async () => {
  const r = runtime();
  const p = approvedList(r);
  p.setData({ items: [{ _id: 'private' }], hasMore: true, nextCursor: 'secret', loadingMore: true });
  const refresh = p.refreshSession();
  r.requests.shift().resolve({ access: 'revoked', member: { role: 'member' } });
  await refresh;
  assert.deepEqual(ids(p), []);
  assert.equal(p.data.hasMore, false);
  assert.equal(p.data.nextCursor, null);
  assert.equal(p.data.loadingMore, false);
  await p.load(false);
  assert.equal(r.requests.length, 0);
});
