const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, event, tick } = require('./runtime');

function members(r) {
  const p = r.page('admin-members/index');
  p.setData({
    access: 'approved', member: { role: 'admin' }, loading: false,
    items: [{ id: 'a', revision: 1 }, { id: 'b', revision: 1 }],
    reasonFor: 'a', decision: 'reject'
  });
  return p;
}
const reasonInput = value => ({ detail: { value } });

test('成员筛选取消放弃时保留原因；确认才切换并解除离开提醒', async () => {
  const r = runtime();
  const p = members(r);
  p.input(reasonInput('请补充明确申请用途'));
  const before = p.data.items;
  const change = p.changeFilter(event({ value: 'approved' }));
  await p.changeFilter(event({ value: 'revoked' }));
  assert.equal(r.modals.length, 1);
  r.modals.shift().success({ confirm: false });
  await change;
  assert.equal(p.data.filter, 'pending');
  assert.equal(p.data.items, before);
  assert.equal(p.data.reason, '请补充明确申请用途');
  assert.equal(r.requests.length, 0);
  assert.equal(r.state.alertsDisabled, 0);

  const accepted = p.changeFilter(event({ value: 'approved' }));
  r.modals.shift().success({ confirm: true });
  await tick();
  assert.equal(p.data.reason, '');
  assert.equal(p.data.reasonFor, '');
  assert.equal(r.state.alertsDisabled, 1);
  const load = r.requests.shift();
  assert.equal(load.data.status, 'approved');
  load.resolve({ members: [], hasMore: false, nextCursor: null });
  await accepted;
});

test('重复选择同一成员处理不会清输入；另目标及取消可拒绝放弃', async () => {
  const r = runtime();
  const p = members(r);
  p.input(reasonInput('保留这段处理原因'));
  await p.choose(event({ id: 'a', decision: 'reject' }));
  assert.equal(p.data.reason, '保留这段处理原因');
  assert.equal(r.modals.length, 0);
  const another = p.choose(event({ id: 'b', decision: 'revoke' }));
  r.modals.shift().success({ confirm: false });
  await another;
  assert.equal(p.data.reasonFor, 'a');
  assert.equal(p.data.reason, '保留这段处理原因');
  const cancel = p.cancelReason();
  r.modals.shift().success({ confirm: false });
  await cancel;
  assert.equal(p.data.reason, '保留这段处理原因');
  const discard = p.cancelReason();
  r.modals.shift().success({ confirm: true });
  await discard;
  assert.equal(p.data.reason, '');
  assert.equal(r.state.alertsDisabled, 1);
});

test('成员处理失败保留说明，成功才清输入和离开提醒', async () => {
  const r = runtime();
  const p = members(r);
  p.input(reasonInput('暂不符合本批内测范围'));
  p.load = async () => {};
  let pending = p.process('a', 'reject', p.data.reason);
  r.modals.shift().success({ confirm: true });
  await tick();
  await p.cancelReason();
  await p.changeFilter(event({ value: 'approved' }));
  assert.equal(r.modals.length, 0);
  r.requests.shift().reject(new Error('offline'));
  await pending;
  assert.equal(p.data.reason, '暂不符合本批内测范围');
  assert.equal(r.state.alertsDisabled, 0);
  assert.equal(p.data.processing, '');
  pending = p.process('a', 'reject', p.data.reason);
  r.modals.shift().success({ confirm: true });
  await tick();
  r.requests.shift().resolve({ member: { status: 'rejected' } });
  await pending;
  assert.equal(p.data.reason, '');
  assert.equal(p.data.reasonFor, '');
  assert.equal(r.state.alertsDisabled, 1);
});

test('管理原因离开提醒仅由当前表单启用并在清空或卸载时解除', () => {
  for (const route of ['admin-members/index', 'admin-review/detail']) {
    const r = runtime();
    const p = r.page(route);
    p.updateReasonLeaveAlert();
    assert.equal(r.state.alertsDisabled, 0);
    p.input(reasonInput('尚未提交的管理说明'));
    assert.match(r.alerts.at(-1), /尚未提交/);
    p.input(reasonInput(''));
    assert.equal(r.state.alertsDisabled, 1);
    p.input(reasonInput('继续编辑说明'));
    p.onUnload();
    assert.equal(r.state.alertsDisabled, 2);
  }
});

test('帖子审核失败保留说明，成功才解除离开提醒', async () => {
  const r = runtime();
  const p = r.page('admin-review/detail');
  p.postId = 'post';
  p.setData({ post: { _id: 'post', revision: 1, status: 'pending' }, admin: true });
  p.input(reasonInput('请移除个人联系方式'));
  p.load = async () => {};
  let pending = p.decide(event({ decision: 'reject' }));
  r.modals.shift().success({ confirm: true });
  await tick();
  r.requests.shift().reject(new Error('offline'));
  await pending;
  assert.equal(p.data.reason, '请移除个人联系方式');
  assert.equal(r.state.alertsDisabled, 0);
  pending = p.decide(event({ decision: 'reject' }));
  r.modals.shift().success({ confirm: true });
  await tick();
  r.requests.shift().resolve({ status: 'rejected' });
  await pending;
  assert.equal(p.data.reason, '');
  assert.equal(r.state.alertsDisabled, 1);
  assert.equal(p.data.processing, false);
});


test('成员原因未提交时取消刷新保留，确认刷新才清除，断网保留已读列表', async () => {
  const r = runtime();
  const p = members(r);
  let refreshes = 0;
  let stopped = 0;
  r.wx.stopPullDownRefresh = () => { stopped += 1; };
  p.refreshSession = async () => { refreshes += 1; p.setData({error:'连接失败'}); };
  p.input({detail:{value:'未提交的说明'}});
  let pending = p.onPullDownRefresh();
  r.modals.shift().success({confirm:false});
  await pending;
  assert.equal(refreshes,0);
  assert.equal(stopped,1);
  assert.equal(p.data.reason,'未提交的说明');
  pending = p.retry();
  r.modals.shift().success({confirm:true});
  await pending;
  assert.equal(refreshes,1);
  assert.equal(p.data.reason,'');
  assert.equal(p.data.items.length,2);
  assert.equal(r.state.alertsDisabled,1);
});

test('成员正在处理或确认中不刷新，且结束下拉指示', async () => {
  const r = runtime();
  const p = members(r);
  let refreshes = 0;
  let stopped = 0;
  p.refreshSession = async () => { refreshes += 1; };
  r.wx.stopPullDownRefresh = () => { stopped += 1; };
  p.setData({processing:'a'});
  await p.onPullDownRefresh();
  p.setData({processing:''});
  p._confirming = true;
  await p.retry();
  assert.equal(refreshes,0);
  assert.equal(stopped,1);
});
