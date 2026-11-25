const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, event } = require('./runtime');
const wall = 'pages/campus-wall/index';
const my = 'pages/my/index';
const materials = 'pages/materials/index';
const tap = (p, path) => p.switchTab(event({ path }));

test('点回实际页面取消等待，视觉和路由一致', () => {
  const r = runtime(), p = r.tab(); tap(p, my); r.advance(60); tap(p, wall); r.advance(600);
  assert.equal(r.switches.length, 0); assert.equal(p.data.selected, wall); assert.equal(p.data.indicatorIndex, 0);
});
test('非法目标和重复当前项不会导航', () => {
  const r = runtime(), p = r.tab(); tap(p, 'bad'); tap(p, wall); r.advance(600);
  assert.equal(r.switches.length, 0); assert.equal(p.data.indicatorIndex, 0);
});
test('导航失败恢复真实选中且允许重试', () => {
  const r = runtime(), p = r.tab(); tap(p, my); r.advance(260);
  r.switches[0].fail(); r.switches[0].complete(); r.advance(0);
  assert.equal(p.data.active, wall); assert.equal(p.data.selected, wall); assert.equal(p.data.indicatorIndex, 0);
  assert.match(r.toasts[0].title, /重试/); tap(p, materials); r.advance(260); assert.equal(r.switches.length, 2);
});
test('原生导航进行中不会并发，完成后解锁', () => {
  const r = runtime(), p = r.tab(); tap(p, my); r.advance(260); tap(p, materials); r.advance(400);
  assert.equal(r.switches.length, 1); r.switches[0].success(); r.switches[0].complete(); tap(p, materials); r.advance(260);
  assert.equal(r.switches.length, 2);
});
test('离开和销毁清除待导航，销毁后不再setData', () => {
  const r = runtime(), p = r.tab(); tap(p, my); p.pageLifetimes.hide.call(p); r.advance(600);
  assert.equal(r.switches.length, 0); assert.equal(p.data.selected, my);
  p.syncRoute(wall); tap(p, my); p.lifetimes.detached.call(p); r.advance(600); assert.equal(r.switches.length, 0);
  tap(p, materials); assert.equal(p.data.selected, my);
});
test('缓存页面同步直接对齐，旧延迟不能覆盖路由', () => {
  const r = runtime(), p = r.tab(); tap(p, my); r.advance(80); p.syncRoute(materials);
  assert.equal(p.data.indicatorIndex, 2); assert.equal(p.data.motionReady, false); r.advance(0);
  assert.equal(p.data.motionReady, true); r.advance(600); assert.equal(r.switches.length, 0); assert.equal(p.data.active, materials);
});
test('减弱动态立即切换，减少透明度独立保留', () => {
  const r = runtime(), p = r.tab(); r.storage.set('campusReducedMotion', true); r.storage.set('campusReducedTransparency', true);
  tap(p, my); assert.equal(r.switches.length, 1); assert.equal(p.data.reducedTransparency, true); assert.equal(p.data.reducedMotion, true);
});
test('syncTab优先路由方法，兼容旧版组件与非Tab页面', () => {
  const r = runtime(), c = r.load('utils/campus.js'); let called;
  c.syncTab({ getTabBar: () => ({ syncRoute(route) { called = route; } }) }, my); assert.equal(called, my);
  let patch; c.syncTab({ getTabBar: () => ({ setData(data) { patch = data; } }) }, materials); assert.equal(patch.active, materials);
  c.syncTab({}, wall);
});


test('有效切换成功才轻振一次，重复回调不重复反馈', () => {
  const r = runtime(), p = r.tab(), vibrations = [];
  r.wx.vibrateShort = options => vibrations.push(options);
  tap(p, my); r.advance(260);
  assert.equal(vibrations.length, 0);
  r.switches[0].success(); r.switches[0].success(); r.switches[0].complete();
  assert.equal(vibrations.length, 1);
  assert.equal(vibrations[0].type, 'light');
  assert.equal(typeof vibrations[0].fail, 'function');
});
test('快速改点只对最终成功目标轻振，点回当前与导航失败保持安静', () => {
  const r = runtime(), p = r.tab(), vibrations = [];
  r.wx.vibrateShort = options => vibrations.push(options);
  tap(p, 'bad'); tap(p, my); r.advance(50); tap(p, wall); r.advance(500);
  assert.equal(vibrations.length, 0); assert.equal(r.switches.length, 0);
  tap(p, my); r.advance(50); tap(p, materials); r.advance(260);
  assert.equal(r.switches.length, 1);
  assert.equal(r.switches[0].url, '/' + materials);
  r.switches[0].fail(); r.switches[0].complete();
  assert.equal(vibrations.length, 0);
  tap(p, my); r.advance(260); r.switches[1].success(); r.switches[1].complete();
  assert.equal(vibrations.length, 1);
});
test('关闭切换震动保持安静，减弱动态不会关闭单独的震动偏好', () => {
  const r = runtime(), p = r.tab(), vibrations = [];
  r.wx.vibrateShort = options => vibrations.push(options);
  r.storage.set('campusTabHaptics', false);
  tap(p, my); r.advance(260); r.switches[0].success(); r.switches[0].complete();
  assert.equal(vibrations.length, 0);
  r.storage.set('campusTabHaptics', true); r.storage.set('campusReducedMotion', true);
  tap(p, materials); assert.equal(r.switches.length, 2);
  r.switches[1].success(); r.switches[1].complete();
  assert.equal(vibrations.length, 1);
});
test('设备不支持或拒绝震动时仍完成板块切换', () => {
  const r = runtime(), p = r.tab();
  r.wx.vibrateShort = options => options.fail({ errMsg: 'unsupported' });
  tap(p, my); r.advance(260); r.switches[0].success(); r.switches[0].complete();
  assert.equal(p.data.selected, my); assert.equal(p._switching, false);
  r.wx.vibrateShort = () => { throw Error('unavailable'); };
  tap(p, materials); r.advance(260); r.switches[1].success(); r.switches[1].complete();
  assert.equal(p.data.selected, materials); assert.equal(p._switching, false);
});

test('私信是第二个原生底栏入口，切过去保留独立收件箱路由', () => {
  const r = runtime(), p = r.tab();
  const inbox = 'pages/direct-inbox/index';
  const nativeTabs = require('../../app.json').tabBar.list.map(row => row.pagePath);
  assert.deepEqual(Array.from(p.data.items, row => row.path), nativeTabs);
  assert.equal(nativeTabs[1], inbox);
  tap(p, inbox); r.advance(260);
  assert.equal(r.switches[0].url, '/' + inbox);
  r.switches[0].success(); r.switches[0].complete();
  assert.equal(p.data.selected, inbox);
  assert.equal(p.data.indicatorIndex, 1);
});

test('原生切页隐藏旧栏时，滑块保持目标位置，不回弹', () => {
  const r = runtime(), origin = r.tab(), destination = r.tab();
  tap(origin, materials); r.advance(260);
  origin.pageLifetimes.hide.call(origin);
  assert.equal(origin.data.selected, materials);
  assert.equal(origin.data.indicatorIndex, 2);
  destination.syncRoute(materials);
  assert.equal(destination.data.indicatorIndex, origin.data.indicatorIndex);
  assert.equal(destination.data.motionReady, false);
  r.switches[0].success(); r.switches[0].complete();
  assert.equal(origin.data.selected, materials);
});

test('切回缓存板块前对齐目标实例，成功回执不改写旧实例路由', () => {
  const r = runtime(), source = r.tab(), target = r.tab();
  source.syncRoute(wall);
  target.syncRoute(materials);
  tap(target, my);
  target.pageLifetimes.hide.call(target);
  assert.equal(target.data.selected, my);
  tap(source, materials);
  r.advance(260);
  assert.equal(target.data.selected, materials);
  assert.equal(target.data.indicatorIndex, 2);
  r.switches[0].success(); r.switches[0].complete();
  assert.equal(source.data.active, wall);
  assert.equal(source.data.selected, materials);
});
