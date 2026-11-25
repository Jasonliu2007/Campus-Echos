const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, event, tick, input } = require('./runtime');
const normalized = value => JSON.parse(JSON.stringify(value));
const owner = { id: 'owner', role: 'admin', status: 'approved' };
const target = { id: 'target', nickname: '测试成员', role: 'member', status: 'approved', revision: 2 };
const session = { access: 'approved', authenticated: true, member: owner, canManageAdmins: true };

function loginPage(r) {
  const calls = [];
  r.wx.login = options => calls.push(options);
  return { page: r.page('wechat-login/index'), calls };
}
function members(r) {
  const p = r.page('admin-members/index');
  p.setData({ access: 'approved', member: owner, canManageAdmins: true, loading: false,
    filter: 'approved', items: [{ ...target }] });
  return p;
}
function composer(r, content = '已有正文') {
  const p = r.page('wall-publish/index');
  p.setData({ allowed: true, loading: false, title: '保留标题', content, contentCount: Array.from(content).length });
  return p;
}

test('微信登录连点只发一次原生登录，成功后仅用可信云session确认管理员', async () => {
  const r = runtime(), { page: p, calls } = loginPage(r);
  const first = p.login(), duplicate = p.login();
  assert.equal(calls.length, 1); assert.equal(calls[0].timeout, 10000);
  assert.equal(r.requests.length, 0); assert.equal(p.data.submitting, true);
  calls.shift().success({ code: 'one-time-code' }); await tick();
  assert.deepEqual(normalized(r.requests[0].data), { action: 'session' });
  r.requests.shift().resolve(session); await Promise.all([first, duplicate]);
  assert.equal(p.data.result.admin, true); assert.equal(p.data.submitting, false);
  assert.equal(r.requests.length, 0);
});
test('微信登录失败或返回空code不调用云端，可重试且没有假成功', async () => {
  const r = runtime(), { page: p, calls } = loginPage(r);
  let pending = p.login(); calls.shift().fail({ errMsg: 'timeout' }); await pending;
  assert.equal(p.data.result, null); assert.equal(p.data.submitting, false);
  assert.match(p.data.error, /重试/); assert.equal(r.requests.length, 0);
  pending = p.login(); calls.shift().success({}); await pending;
  assert.equal(p.data.result, null); assert.equal(p.data.submitting, false);
  assert.equal(r.requests.length, 0);
});
test('微信登录后的云端失败不假报登录完成，未获准的admin也不能进入管理态', async () => {
  const r = runtime(), { page: p, calls } = loginPage(r);
  let pending = p.login(); calls.shift().success({ code: 'code' }); await tick();
  r.requests.shift().reject(Error('offline')); await pending;
  assert.equal(p.data.result, null); assert.match(p.data.error, /连接/);
  pending = p.login(); calls.shift().success({ code: 'code2' }); await tick();
  r.requests.shift().resolve({ access: 'revoked', member: { role: 'admin' } }); await pending;
  assert.equal(p.data.result.admin, false); assert.equal(p.data.result.access, 'revoked');
});
test('登录时离开页面后原生晚回调不会再请求会话或显示成功', async () => {
  const r = runtime(), { page: p, calls } = loginPage(r);
  const pending = p.login(); p.onHide();
  calls.shift().success({ code: 'late-code' }); await tick();
  assert.equal(r.requests.length, 0);
  await pending; assert.equal(p.data.result, null);
});
test('我的页面返回静默核角色，保留内容；撤销权限不会保留管理入口', async () => {
  const r = runtime(), p = r.page('my/index');
  let pending = p.refresh(); r.requests.shift().resolve(session); await pending;
  assert.equal(p.data.canManageAdmins, true); assert.equal(p.data.loading, false);
  pending = p.refresh(true);
  assert.equal(p.data.loading, false); assert.equal(p.data.member.id, 'owner');
  r.requests.shift().reject(Error('offline')); await pending;
  assert.equal(p.data.member.id, 'owner'); assert.match(p.data.sessionNotice, /保留/);
  pending = p.refresh(true);
  r.requests.shift().resolve({ ok: false, code: 'FORBIDDEN', message: '权限已变更' }); await pending;
  assert.equal(p.data.member, null); assert.equal(p.data.authenticated, false);
  assert.equal(p.data.canManageAdmins, false);
});

test('管理员授权同一时刻连点只出现一份确认，成功后更新角色版本', async () => {
  const r = runtime(), p = members(r);
  const first = p.role(event({ id: 'target' })), duplicate = p.role(event({ id: 'target' }));
  await tick(); assert.equal(r.modals.length, 1);
  r.modals.shift().success({ confirm: true }); await tick();
  assert.equal(r.requests.length, 1);
  assert.deepEqual(normalized(r.requests[0].data), { action: 'setMemberRole', memberId: 'target', revision: 2, role: 'admin' });
  r.requests.shift().resolve({ member: { ...target, role: 'admin', revision: 3 } });
  await Promise.all([first, duplicate]);
  assert.equal(p.data.items[0].role, 'admin'); assert.equal(p.data.items[0].revision, 3);
  assert.equal(p.data.processing, ''); assert.equal(r.toasts.length, 1);
});
test('普通管理员、未获准目标和自己均不能打开角色授予确认，取消确认不写云', async () => {
  const r = runtime(), p = members(r);
  p.setData({ canManageAdmins: false }); await p.role(event({ id: 'target' }));
  p.setData({ canManageAdmins: true, items: [{ ...target, status: 'pending' }, owner] });
  await p.role(event({ id: 'target' })); await p.role(event({ id: 'owner' }));
  assert.equal(r.modals.length, 0); assert.equal(r.requests.length, 0);
  p.setData({ items: [{ ...target }] });
  const pending = p.role(event({ id: 'target' })); await tick();
  r.modals.shift().success({ confirm: false }); await pending;
  assert.equal(r.requests.length, 0); assert.equal(p.data.items[0].role, 'member');
});
test('取消管理员权限仍用同一会话和最新revision，不发第二种登录请求', async () => {
  const r = runtime(), p = members(r);
  p.setData({ items: [{ ...target, role: 'admin', revision: 5 }] });
  const pending = p.role(event({ id: 'target' })); await tick();
  assert.match(r.modals[0].content, /内测资格保留/);
  r.modals.shift().success({ confirm: true }); await tick();
  assert.equal(r.requests[0].data.role, 'member'); assert.equal(r.requests[0].data.revision, 5);
  r.requests.shift().resolve({ member: { ...target, role: 'member', revision: 6 } }); await pending;
  assert.equal(p.data.items[0].role, 'member'); assert.equal(r.requests.length, 0);
});
test('授权超时先重查真实权限和成员版本，不自动重复授权', async () => {
  const r = runtime(), p = members(r);
  const pending = p.role(event({ id: 'target' })); await tick();
  r.modals.shift().success({ confirm: true }); await tick();
  await p.role(event({ id: 'target' })); assert.equal(r.modals.length, 0);
  r.requests.shift().reject(Error('timeout')); await tick();
  assert.equal(r.requests[0].data.action, 'session');
  r.requests.shift().resolve(session); await tick();
  assert.equal(r.requests[0].data.action, 'listMembers');
  r.requests.shift().resolve({ members: [{ ...target, role: 'admin', revision: 3 }], hasMore: false, nextCursor: null });
  await pending;
  assert.equal(p.data.items[0].role, 'admin'); assert.equal(p.data.items[0].revision, 3);
  assert.match(p.data.pageError, /重新核对/); assert.equal(p.data.processing, '');
  assert.equal(r.requests.length, 0);
});
test('未提交处理原因取消放弃后仍保留，不继续弹角色授权', async () => {
  const r = runtime(), p = members(r);
  p.setData({ reasonFor: 'target', reason: '保留正在填写的原因', decision: 'revoke' });
  p.updateReasonLeaveAlert();
  const pending = p.role(event({ id: 'target' }));
  assert.match(r.modals[0].title, /放弃/);
  r.modals.shift().success({ confirm: false }); await pending;
  assert.equal(p.data.reason, '保留正在填写的原因');
  assert.equal(r.modals.length, 0); assert.equal(r.requests.length, 0);
  assert.equal(r.state.alertsDisabled, 0);
});
test('页面隐藏或卸载后旧角色授权确认失效，不继续写入', async () => {
  for (const leave of ['onHide', 'onUnload']) {
    const r = runtime(), p = members(r);
    const pending = p.role(event({ id: 'target' })); await tick();
    p[leave](); r.modals.shift().success({ confirm: true }); await pending;
    assert.equal(r.requests.length, 0, leave);
  }
});
test('放弃原因确认期间离开，不继续弹新的管理员授权确认', async () => {
  const r = runtime(), p = members(r);
  p.setData({ reasonFor: 'target', reason: '尚未提交原因', decision: 'revoke' });
  const pending = p.role(event({ id: 'target' })); p.onHide();
  r.modals.shift().success({ confirm: true }); await tick();
  assert.equal(r.modals.length, 0); assert.equal(r.requests.length, 0);
  await pending;
});

test('文字符号在原生UTF16光标处插入，不切开emoji且草稿与计数一致', () => {
  const r = runtime(), p = composer(r, '甲😀乙');
  p.rememberCursor({ detail: { cursor: 2 } });
  p.insert(event({ symbol: '✓' }));
  assert.equal(p.data.content, '甲😀✓ 乙'); assert.equal(p.data.cursor, 5);
  assert.equal(p.data.contentCount, 5); assert.equal(p.data.title, '保留标题');
  assert.equal(r.storage.get('campusEchoDraftV1').content, '甲😀✓ 乙');
  assert.match(r.alerts.at(-1), /草稿/); assert.equal(r.requests.length, 0);
});
test('四分区模板插在光标处，完整保留前后原文并保存草稿', () => {
  for (const category of ['校园生活墙', '表白墙', 'AI论坛墙', '申研实习墙']) {
    const r = runtime(), p = composer(r, '前文\n后文');
    p.setData({ category }); p.rememberCursor({ detail: { cursor: 3 } });
    p.insert(event({ kind: 'template' }));
    assert.equal(p.data.content.startsWith('前文\n【'), true);
    assert.equal(p.data.content.endsWith('后文'), true);
    assert.equal(p.data.content.includes('undefined'), false);
    assert.equal(p.data.contentCount, Array.from(p.data.content).length);
    assert.equal(r.storage.get('campusEchoDraftV1').category, category);
  }
});
test('插入符号或模板超2000字不截原文，恰好2000字可插入', () => {
  const r = runtime(), p = composer(r, '文'.repeat(1999));
  p.save(); const before = r.storage.get('campusEchoDraftV1').content;
  p.insert(event({ symbol: '•' }));
  assert.equal(p.data.content, before); assert.equal(p.data.contentCount, 1999);
  assert.match(p.data.error, /超过2000/); assert.equal(r.storage.get('campusEchoDraftV1').content, before);
  p.insert(event({ kind: 'template' })); assert.equal(p.data.content, before);
  p.setData({ content: '文'.repeat(1998), contentCount: 1998 }); p._cursor = 1998;
  p.insert(event({ symbol: '•' }));
  assert.equal(p.data.contentCount, 2000); assert.equal(Array.from(p.data.content).length, 2000);
});
test('排版预览只投影纯文字，不发帖、不改输入或去重草稿', () => {
  const content = '【小标题】\n<script>alert(1)</script>\n———\n\n正文';
  const r = runtime(), p = composer(r, content);
  p._request = 'existing-request'; p._fingerprint = 'same'; p.save();
  const draft = normalized(r.storage.get('campusEchoDraftV1'));
  p.preview();
  assert.equal(p.data.previewing, true);
  assert.deepEqual(Array.from(p.data.previewBlocks, block => block.kind), ['heading', 'paragraph', 'divider', 'space', 'paragraph']);
  assert.equal(p.data.previewBlocks[1].text, '<script>alert(1)</script>');
  assert.equal(p.data.content, content); assert.equal(p.data.title, '保留标题');
  assert.deepEqual(normalized(r.storage.get('campusEchoDraftV1')), draft);
  p.preview(); assert.equal(p.data.previewing, false); assert.equal(r.requests.length, 0);
});
test('排版后草稿存储失败明确提示，提交中所有排版操作不改内容', () => {
  const r = runtime(), p = composer(r);
  r.state.storageFails = true; p.insert(event({ symbol: '→' }));
  assert.match(p.data.error, /草稿未能保存/); assert.equal(p._draftSaved, false);
  const before = p.data.content;
  p.setData({ submitting: true });
  p.insert(event({ kind: 'template' })); p.preview(); p.toggleTool(event({ tool: 'symbols' }));
  assert.equal(p.data.content, before); assert.equal(p.data.previewing, false); assert.equal(p.data.tool, '');
});

test('四份资料目录与样章锚点一一对应，未知资料不回退成其他示例', () => {
  const ids = ['demo-calculus', 'demo-accounting', 'demo-english', 'demo-linear'];
  for (const id of ids) {
    const r = runtime(), p = r.page('material-demo/index');
    const scrolls = []; r.wx.pageScrollTo = options => scrolls.push(options);
    p.onLoad({ id }); p.onShow();
    assert.equal(p.data.material.id, id); assert.equal(p.data.chapters.length, 3);
    p.data.chapters.forEach((chapter, index) => {
      assert.equal(chapter.id, 'sample-' + index); assert.ok(chapter.title && chapter.paragraph);
      p.preview(event({ index: String(index) }));
      assert.equal(p.data.selected, index); assert.equal(scrolls.at(-1).selector, '#' + chapter.id);
    });
    assert.equal(r.requests.length, 0);
  }
  const r = runtime(), p = r.page('material-demo/index');
  p.onLoad({ id: 'unknown' }); assert.equal(p.data.material, null); assert.equal(p.data.chapters.length, 0);
});
test('资料目录非法定位无操作，减弱动态即时定位；定位失败有恢复说明', () => {
  const r = runtime(), p = r.page('material-demo/index'), scrolls = [];
  r.wx.pageScrollTo = options => scrolls.push(options);
  p.onLoad({ id: 'demo-calculus' });
  for (const index of [-1, 3, 0.5, 'not-an-index']) p.preview(event({ index }));
  assert.equal(scrolls.length, 0);
  r.storage.set('campusReducedMotion', true); p.onShow(); p.contents();
  assert.equal(scrolls.at(-1).selector, '#contents'); assert.equal(scrolls.at(-1).duration, 0);
  scrolls.at(-1).fail(); assert.match(p.data.error, /向下滑动/);
  p.preview(event({ index: 1 })); assert.equal(p.data.error, ''); assert.equal(p.data.selected, 1);
});
test('震动偏好默认开启，存储失败恢复原值，重试关闭后其他显示偏好不变', () => {
  const r = runtime(), p = r.page('setting/index');
  r.storage.set('campusReducedMotion', true); r.storage.set('campusReducedTransparency', true);
  p.onShow(); assert.equal(p.data.tabHaptics, true);
  r.state.storageFails = true; p.haptics({ detail: { value: false } });
  assert.equal(p.data.tabHaptics, true); assert.match(p.data.settingsError, /未能保存/);
  r.state.storageFails = false; p.haptics({ detail: { value: false } });
  assert.equal(p.data.tabHaptics, false); assert.equal(r.storage.get('campusTabHaptics'), false);
  assert.equal(p.data.reducedMotion, true); assert.equal(p.data.reducedTransparency, true);
  p.onShow(); assert.equal(p.data.tabHaptics, false); assert.equal(p.data.settingsError, '');
});

test('登录隐藏或卸载后云端成功与失败均不写页面，已卸载不能重试', async () => {
  for (const leave of ['onHide', 'onUnload']) for (const outcome of ['resolve', 'reject']) {
    const r = runtime(), { page: p, calls } = loginPage(r);
    const pending = p.login(); calls.shift().success({ code: 'before-leave' }); await tick();
    const request = r.requests.shift();
    p[leave]();
    const before = normalized(p.data);
    if (outcome === 'resolve') request.resolve(session); else request.reject(Error('late-offline'));
    await pending;
    assert.deepEqual(normalized(p.data), before, `${leave}/${outcome}`);
    assert.equal(p.data.result, null); assert.equal(r.requests.length, 0);
    if (leave === 'onUnload') { await p.login(); assert.equal(calls.length, 0); }
  }
});
test('登录返回后重新可提交，先前原生回调不能替新一轮请求会话', async () => {
  const r = runtime(), { page: p, calls } = loginPage(r);
  p.onShow(); const first = p.login(), oldNative = calls.shift();
  p.onHide(); p.onShow();
  assert.equal(p.data.submitting, false);
  const second = p.login(), currentNative = calls.shift();
  oldNative.success({ code: 'stale-code' }); await first;
  assert.equal(r.requests.length, 0); assert.equal(p.data.submitting, true);
  currentNative.success({ code: 'current-code' }); await tick();
  r.requests.shift().resolve(session); await second;
  assert.equal(p.data.result.admin, true); assert.equal(p.data.submitting, false);
});
test('登录返回后旧云管理员结果不能覆盖新会话的撤销结论', async () => {
  const r = runtime(), { page: p, calls } = loginPage(r);
  const first = p.login(); calls.shift().success({ code: 'old-code' }); await tick();
  const oldCloud = r.requests.shift();
  p.onHide(); p.onShow();
  const second = p.login(); calls.shift().success({ code: 'new-code' }); await tick();
  r.requests.shift().resolve({ access: 'revoked', member: { role: 'member' } }); await second;
  assert.equal(p.data.result.access, 'revoked'); assert.equal(p.data.result.admin, false);
  oldCloud.resolve(session); await first;
  assert.equal(p.data.result.access, 'revoked'); assert.equal(p.data.result.admin, false);
  assert.equal(p.data.submitting, false); assert.equal(r.requests.length, 0);
});
test('我的页面隐藏或卸载后旧云响应不写页面，返回只采纳新资格', async () => {
  for (const leave of ['onHide', 'onUnload']) {
    const r = runtime(), p = r.page('my/index');
    const old = p.refresh(), oldCloud = r.requests.shift();
    p[leave](); const before = normalized(p.data);
    oldCloud.resolve(session); await old;
    assert.deepEqual(normalized(p.data), before, leave);
    if (leave === 'onUnload') {
      await p.refresh(); assert.equal(r.requests.length, 0);
    } else {
      p.onShow(); assert.equal(r.requests.length, 1);
      r.requests.shift().resolve({ access: 'revoked', member: null, canManageAdmins: false }); await tick();
      assert.equal(p.data.access, 'revoked'); assert.equal(p.data.canManageAdmins, false);
      assert.equal(p.data.loading, false); assert.equal(p._loading, false);
    }
  }
});
test('我的页面离开后旧失败不能清除返回后已更新的管理员身份', async () => {
  const r = runtime(), p = r.page('my/index');
  const first = p.refresh(), old = r.requests.shift();
  p.onHide(); p.onShow();
  r.requests.shift().resolve(session); await tick();
  old.resolve({ ok: false, code: 'UNAUTHENTICATED', message: '旧请求失效' }); await first;
  assert.equal(p.data.member.id, 'owner'); assert.equal(p.data.canManageAdmins, true);
  assert.equal(p.data.authenticated, true); assert.equal(p.data.error, '');
  assert.equal(p.data.loading, false); assert.equal(p._loading, false);
});

async function blockedMemberReads(p) {
  p.onReachBottom(); p.loadMore();
  await p.load(true); await p.load(false); await p.refreshSession();
  await p.onShow(); await p.onPullDownRefresh(); await p.retry();
}
test('授权开始后旧成员首屏和分页响应失效，不覆盖已成功的新角色版本', async () => {
  for (const reset of [true, false]) {
    const r = runtime(), p = members(r);
    p.setData({ hasMore: true, nextCursor: 'old-page-2' });
    const oldRead = p.load(reset), old = r.requests.shift();
    assert.equal(reset ? p.data.loading : p.data.loadingMore, true);
    const change = p.role(event({ id: 'target' })); await tick();
    assert.equal(p.data.loading, false); assert.equal(p.data.loadingMore, false);
    r.modals.shift().success({ confirm: true }); await tick();
    r.requests.shift().resolve({ member: { ...target, role: 'admin', revision: 3 } }); await change;
    old.resolve({ members: [{ ...target }], hasMore: false, nextCursor: null }); await oldRead;
    assert.equal(p.data.items[0].role, 'admin'); assert.equal(p.data.items[0].revision, 3);
    assert.equal(p.data.nextCursor, 'old-page-2'); assert.equal(p.data.hasMore, true);
    assert.equal(r.requests.length, 0);
  }
});
test('授权确认前已有的通用会话晚返回不再触发列表，也不覆盖当前权限', async () => {
  const r = runtime(), p = members(r);
  const oldRead = p.refreshSession(), oldSession = r.requests.shift();
  const change = p.role(event({ id: 'target' })); await tick();
  oldSession.resolve({ access: 'revoked', member: null, canManageAdmins: false }); await oldRead;
  assert.equal(p.data.canManageAdmins, true); assert.equal(p.data.access, 'approved');
  assert.equal(p.data.member.id, 'owner'); assert.equal(r.requests.length, 0);
  r.modals.shift().success({ confirm: true }); await tick();
  r.requests.shift().resolve({ member: { ...target, role: 'admin', revision: 3 } }); await change;
  assert.equal(p.data.items[0].revision, 3); assert.equal(p.data.items[0].role, 'admin');
});
test('授权确认和提交期间通用刷新与触底均暂停，完成后可继续真实分页', async () => {
  const r = runtime(), p = members(r);
  p.setData({ hasMore: true, nextCursor: 'page-2' });
  const change = p.role(event({ id: 'target' })); await tick();
  await blockedMemberReads(p);
  assert.equal(r.modals.length, 1); assert.equal(r.requests.length, 0);
  r.modals.shift().success({ confirm: true }); await tick();
  const mutation = r.requests.shift();
  await blockedMemberReads(p); assert.equal(r.requests.length, 0);
  mutation.resolve({ member: { ...target, role: 'admin', revision: 3 } }); await change;
  const next = p.load(false); assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].data.action, 'listMembers'); assert.equal(r.requests[0].data.cursor, 'page-2');
  r.requests.shift().resolve({ members: [{ id: 'second', role: 'member', status: 'approved', revision: 1 }], hasMore: false, nextCursor: null }); await next;
  assert.equal(p.data.items[0].role, 'admin'); assert.equal(p.data.items.length, 2);
});
test('核对角色期间触底和onShow不启动通用会话或分页，核对结束才解锁', async () => {
  const r = runtime(), p = members(r);
  p.setData({ roleConflict: true, hasMore: true, nextCursor: 'stale-page' });
  const checking = p.verifyRoles(), sessionRequest = r.requests.shift();
  assert.equal(p.data.checkingRoles, true); assert.equal(sessionRequest.data.action, 'session');
  await blockedMemberReads(p); assert.equal(r.requests.length, 0);
  sessionRequest.resolve(session); await tick();
  const currentList = r.requests.shift(); assert.equal(currentList.data.action, 'listMembers');
  await blockedMemberReads(p); assert.equal(r.requests.length, 0);
  currentList.resolve({ members: [{ ...target, role: 'admin', revision: 3 }], hasMore: true, nextCursor: 'fresh-page' }); await checking;
  assert.equal(p.data.checkingRoles, false); assert.equal(p.data.roleConflict, false);
  assert.equal(p.data.items[0].revision, 3); assert.equal(p.data.nextCursor, 'fresh-page');
  const next = p.load(false); assert.equal(r.requests[0].data.cursor, 'fresh-page');
  r.requests.shift().resolve({ members: [], hasMore: false, nextCursor: null }); await next;
});

test('预览提交字段不合格时返回编辑并聚焦首错，标题正文原样保留', async () => {
  for (const invalid of ['title', 'content']) {
    const r = runtime(), p = composer(r, '  【保留排版】\n😀正文  ');
    const title = invalid === 'title' ? '😀'.repeat(61) : '  保留标题  ';
    const content = invalid === 'content' ? '  \n  ' : p.data.content;
    p.setData({ title, content }); p.preview();
    assert.equal(p.data.previewing, true);
    await p.submit();
    assert.equal(p.data.previewing, false); assert.equal(r.requests.length, 0);
    assert.equal(p.data.title, title); assert.equal(p.data.content, content);
    assert.equal(p.data.focusTitle, invalid === 'title');
    assert.equal(p.data.focusContent, invalid === 'content');
    assert.match(p.data.error, /输入会保留/); assert.equal(p.data.submitting, false);
  }
});
test('预览提交云端失败时返回编辑展示错误，原文与去重草稿均保留', async () => {
  const r = runtime(), p = composer(r, '  【保留排版】\n😀正文  ');
  p.setData({ title: '  保留标题  ' });
  const title = p.data.title, content = p.data.content;
  p.preview(); const pending = p.submit(), request = r.requests.shift();
  assert.equal(p.data.previewing, true); assert.equal(p.data.submitting, true);
  request.reject(Error('timeout')); await pending;
  assert.equal(p.data.previewing, false); assert.equal(p.data.submitting, false);
  assert.equal(p.data.title, title); assert.equal(p.data.content, content);
  assert.equal(p.data.result, null); assert.match(p.data.error, /连接/);
  assert.equal(r.storage.get('campusEchoDraftV1').title, title);
  assert.equal(r.storage.get('campusEchoDraftV1').content, content);
  assert.equal(r.storage.get('campusEchoDraftV1').requestId, request.data.requestId);
});
