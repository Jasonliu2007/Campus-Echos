const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, input, event } = require('./runtime');
const row = { _id: 'order-id', revision: 2, viewerRole: 'buyer', status: 'deliverable', deliveryStatus: 'ready', priceCents: 0, title: '原创样本' };

test('real material list never falls back to demos on a failed cloud call', async () => {
  const r = runtime(), page = r.page('materials/index');
  const load = page.load(true);
  assert.equal(r.requests[0].data.action, 'listMaterials');
  r.requests[0].reject(Error('offline')); await load;
  assert.equal(page.data.materials.length, 0); assert.equal(page.data.demo, false); assert.match(page.data.error, /连接/);
});

test('returning to material tab rechecks access without reloading list; revocation clears protected data', async () => {
  const r = runtime(), page = r.page('materials/index');
  const load = page.load(true); r.requests[0].resolve({ items: [{ _id: 'm', title: '真实资料', priceCents: 0 }], hasMore: false }); await load;
  page.onShow(); await tick(); assert.equal(r.requests[1].data.action, 'session');
  assert.equal(page.data.materials.length, 1);
  r.requests[1].resolve({ access: 'revoked' }); await tick();
  assert.equal(page.data.materials.length, 0); assert.equal(page.data.hasMore, false);
});

test('paid material action stays closed before any order request', async () => {
  const r = runtime(), page = r.page('material-detail/index');
  page.setData({ material: { _id: 'm', priceCents: 100, status: 'published', isOwner: false }, paidEnabled: false });
  await page.acquire(); assert.equal(r.requests.length, 0); assert.match(page.data.error, /付费尚未启用/);
});

test('leaving material detail ignores a late protected response', async () => {
  const r = runtime(), page = r.page('material-detail/index'); page.onLoad({ id: 'm' });
  const load = page.load(); page.onUnload(); r.requests[0].resolve({ material: { _id: 'm', title: 'late' } }); await load;
  assert.equal(page.data.material, null);
});

test('order claim confirms once, never starts a second request, and reports native reader failure', async () => {
  const r = runtime(), page = r.page('trade-order/index'); page.orderId = row._id; page.setData({ order: row });
  r.wx.downloadFile = options => options.success({ statusCode: 200, tempFilePath: '/tmp/reader.pdf' });
  r.wx.openDocument = options => options.fail({ errMsg: 'reader error' });
  const first = page.claim(), duplicate = page.claim(); assert.equal(r.modals.length, 1);
  r.modals[0].success({ confirm: true }); await tick();
  assert.equal(r.requests.length, 1); assert.equal(r.requests[0].data.termsAccepted, true);
  r.requests[0].resolve({ order: { ...row, firstClaimAt: 1 }, url: 'https://example.test/private' }); await Promise.all([first, duplicate]);
  assert.match(page.data.error, /技术报修/); assert.equal(page.data.busy, ''); assert.equal(page.data.order.firstClaimAt, 1);
});

test('failed order message preserves text and request identity for retry', async () => {
  const r = runtime(), page = r.page('trade-order/index'); page.orderId = row._id;
  page.input({ detail: { value: '请核对目录缺页' } });
  let pending = page.send(); const firstId = r.requests[0].data.requestId;
  r.requests[0].reject(Error('timeout')); await pending;
  assert.equal(page.data.message, '请核对目录缺页');
  pending = page.send(); assert.equal(r.requests[1].data.requestId, firstId);
  r.requests[1].reject(Error('offline')); await pending; assert.equal(page.data.messageCount, 7);
});

test('order access revocation clears cached messages and all protected data', async () => {
  const r = runtime(), page = r.page('trade-order/index'); page.orderId = row._id;
  page.setData({ order: row, messages: [{ content: 'private' }], sales: [{ description: 'private' }] });
  const load = page.load(); r.requests[0].resolve({ ok: false, code: 'NOT_FOUND', message: '无权查看' }); await load;
  assert.equal(page.data.order, null); assert.equal(page.data.messages.length, 0); assert.equal(page.data.sales.length, 0);
});

test('failed after-sale submission keeps facts and idempotency key', async () => {
  const r = runtime(), page = r.page('trade-support/index'); page.onLoad({ orderId: row._id });
  page.input(input('description', '文件打开失败，请协助核对。'));
  let pending = page.submit(); const id = r.requests[0].data.requestId;
  r.requests[0].reject(Error('network')); await pending;
  assert.equal(page.data.description, '文件打开失败，请协助核对。');
  pending = page.submit(); assert.equal(r.requests[1].data.requestId, id); r.requests[1].reject(Error('timeout')); await pending;
  assert.equal(page.data.busy, false);
});

test('administrator role cannot expose seller confirmation and paid setup remains disabled', async () => {
  const r = runtime(), page = r.page('trade-payment/index'); page.setData({ order: { ...row, viewerRole: 'admin', status: 'awaitingSeller' } });
  await page.receipt(); assert.equal(r.modals.length, 0); assert.equal(r.requests.length, 0);
  page.setData({ setup: true, paidEnabled: false }); await page.choose(); await page.submit();
  assert.equal(r.requests.length, 0); assert.match(page.data.error, /未启用/);
});

test('complaint close asks before discarding an unsubmitted explanation', async () => {
  const r = runtime(), page = r.page('admin-trade/index'); page.setData({ selected: { _id: 'c' }, reason: '核对中的说明' });
  const pending = page.close(); assert.equal(r.modals.length, 1); r.modals[0].success({ confirm: false }); await pending;
  assert.equal(page.data.reason, '核对中的说明'); assert.ok(page.data.selected);
});

test('payment permission denial clears all server private material but preserves own unsubmitted input', async () => {
  const r = runtime(), page = r.page('trade-payment/index');
  page.onLoad({ id: row._id });
  page.setData({ order: row, qrUrl: 'https://private/qr', proofUrl: 'https://private/proof', proofReference: 'server transfer', proofNote: 'server note', transferReference: 'my draft', note: 'my facts' });
  const pending = page.load();
  r.requests[0].resolve({ ok: false, code: 'NOT_FOUND', message: '无权查看' }); await pending;
  assert.equal(page.data.order, null); assert.equal(page.data.qrUrl, ''); assert.equal(page.data.proofUrl, '');
  assert.equal(page.data.proofReference, ''); assert.equal(page.data.proofNote, '');
  assert.equal(page.data.transferReference, 'my draft'); assert.equal(page.data.note, 'my facts');
});

test('late payment proof cannot restore access after a newer denial', async () => {
  const r = runtime(), page = r.page('trade-payment/index'); page.orderId = row._id;
  page.setData({ order: row }); const proof = page.proof(); const check = page.load();
  r.requests[1].resolve({ ok: false, code: 'NOT_FOUND', message: '已失效' }); await check;
  r.requests[0].resolve({ url: 'https://private/late', transferReference: 'secret', note: 'private' }); await proof;
  assert.equal(page.data.order, null); assert.equal(page.data.proofUrl, ''); assert.equal(page.data.proofReference, '');
});

test('returning payment page drops prior response and revalidates the exact order', async () => {
  const r = runtime(), page = r.page('trade-payment/index'); page.orderId = row._id;
  page.setData({ order: row }); const first = page.load(); page.onHide(); page.onShow();
  assert.equal(r.requests.length, 2); assert.equal(r.requests[1].data.action, 'getOrder');
  r.requests[1].resolve({ ok: false, code: 'NOT_FOUND', message: '资格已变更' }); await tick();
  r.requests[0].resolve({ order: { ...row, title: 'late secret' } }); await first;
  assert.equal(page.data.order, null); assert.equal(page.data.loading, false);
});

test('after-sale page does not refill private case after leaving', async () => {
  const r = runtime(), page = r.page('trade-support/index'); page.onLoad({ caseId: 'case' });
  const pending = page.load(); page.onHide();
  r.requests[0].resolve({ afterSale: { _id: 'case', orderId: row._id, description: 'private facts' } }); await pending;
  assert.equal(page.data.case, null); assert.equal(r.requests.length, 1);
});

test('an old order message page cannot refill after the order access check is denied', async () => {
  const r = runtime(), page = r.page('trade-order/index'); page.orderId = row._id;
  page.setData({ order: row, message: 'my draft' }); const messages = page.loadMessages(true); const check = page.load();
  r.requests[1].resolve({ ok: false, code: 'NOT_FOUND', message: '无权查看' }); await check;
  r.requests[0].resolve({ items: [{ content: 'private late message' }], hasMore: false }); await messages;
  assert.equal(page.data.messages.length, 0); assert.equal(page.data.order, null); assert.equal(page.data.message, 'my draft');
});

test('reopened order ignores the old reply even when it returns after a new read', async () => {
  const r = runtime(), page = r.page('trade-order/index'); page.orderId = row._id;
  const oldRead = page.load(); page.onHide(); page.onShow();
  r.requests[0].resolve({ order: { ...row, title: 'stale' } }); await oldRead;
  assert.equal(page.data.order, null);
  r.requests[1].resolve({ order: { ...row, title: 'current' } }); await tick();
  r.requests[2].resolve({ items: [], hasMore: false }); r.requests[3].resolve({ items: [], hasMore: false }); await tick();
  assert.equal(page.data.order.title, 'current');
});

test('new text typed while sending an earlier message is retained after the earlier send succeeds', async () => {
  const r = runtime(), page = r.page('trade-order/index'); page.orderId = row._id;
  page.input({ detail: { value: 'first facts' } }); const pending = page.send();
  page.input({ detail: { value: 'new unsent facts' } }); r.requests[0].resolve({}); await tick();
  r.requests[1].resolve({ items: [], hasMore: false }); await pending;
  assert.equal(page.data.message, 'new unsent facts');
  assert.equal(r.storage.get('trade-message-' + row._id).content, 'new unsent facts');
});

test('existing order after-sale access remains available when community session is revoked', async () => {
  const r = runtime(), page = r.page('trade-support/index'); page.onLoad({ orderId: row._id });
  const pending = page.load(); r.requests[0].resolve({ order: row }); await tick();
  r.requests[1].resolve({ access: 'revoked', member: { role: 'admin' } }); await pending;
  assert.equal(page.data.order._id, row._id); assert.equal(page.data.canAdmin, false);
});

test('admin trade tab change retains an unsubmitted reason when leaving is cancelled', async () => {
  const r = runtime(), page = r.page('admin-trade/index');
  page.setData({ tab: 'complaints', reason: '正在核对' });
  const pending = page.tab(event({ tab: 'afterSales' })); r.modals[0].success({ confirm: false }); await pending;
  assert.equal(page.data.tab, 'complaints'); assert.equal(page.data.reason, '正在核对'); assert.equal(r.requests.length, 0);
});

test('after-sale administrator revocation clears private case and keeps own coordination draft', async () => {
  const r = runtime(), page = r.page('trade-support/index'); page.onLoad({ caseId: 'case' });
  page.setData({ case: { _id: 'case', description: 'private' }, canAdmin: true, coordination: 'my draft' });
  const pending = page.load(); r.requests[0].resolve({ ok: false, code: 'FORBIDDEN', message: '管理权限已撤销' }); await pending;
  assert.equal(page.data.case, null); assert.equal(page.data.canAdmin, false); assert.equal(page.data.coordination, 'my draft');
});

test('a delayed material page cannot refill the list after a returned session revocation', async () => {
  const r = runtime(), page = r.page('materials/index');
  page._loaded = true; page.setData({ materials: [{ _id: 'old' }], hasMore: true, nextCursor: 'cursor' });
  const more = page.load(false), session = page.checkSession();
  r.requests[1].resolve({ access: 'revoked' }); await session;
  r.requests[0].resolve({ items: [{ _id: 'late', title: 'private' }], hasMore: true, nextCursor: 'more' }); await more;
  assert.equal(page.data.materials.length, 0); assert.equal(page.data.hasMore, false); assert.equal(page.data.loadingMore, false);
});

test('material preview permission denial clears detail and never opens an unauthorized document', async () => {
  const r = runtime(), page = r.page('material-detail/index'); page.materialId = 'm';
  page.setData({ material: { _id: 'm' }, matching: { summary: 'old' } }); let opened = false;
  r.wx.downloadFile = () => { opened = true; };
  const pending = page.preview(); r.requests[0].resolve({ ok: false, code: 'ACCESS_DENIED', message: '资格失效' }); await pending;
  assert.equal(page.data.material, null); assert.equal(page.data.matching, null); assert.equal(opened, false);
});

test('the latest learning mode is queried after changing the picker during a slow detail load', async () => {
  const r = runtime(), page = r.page('material-detail/index'); page.materialId = 'm';
  const pending = page.load(); page.mode({ detail: { value: 1 } });
  r.requests[0].resolve({ material: { _id: 'm', title: '资料' }, matching: { summary: 'old' } }); await pending;
  assert.equal(r.requests[1].data.learningMode, '系统复习');
  r.requests[1].resolve({ material: { _id: 'm', title: '资料' }, matching: { summary: '规则匹配' } }); await tick();
  assert.equal(page.data.matching.summary, '规则匹配');
});

test('a native image picker hide/show preserves and uploads a legitimate private proof selection', async () => {
  const r = runtime(), page = r.page('trade-payment/index'); page.orderId = row._id;
  let picker; r.wx.chooseMedia = options => { picker = options; };
  r.wx.getFileSystemManager = () => ({ readFile(options) { options.success({ data: 'Yg==' }); } });
  const pending = page.choose(); assert.ok(picker);
  page.onHide(); page.onShow();
  assert.equal(r.requests.length, 0);
  picker.success({ tempFiles: [{ tempFilePath: '/tmp/proof', size: 1 }] }); await tick();
  assert.equal(r.requests[0].data.action, 'uploadPrivateImage'); assert.equal(r.requests[0].data.orderId, row._id);
  r.requests[0].resolve({ assetId: 'private-proof' }); await pending;
  assert.equal(page.data.assetId, 'private-proof'); assert.equal(page.data.busy, ''); assert.equal(page._choosingPrivateImage, false);
});

test('a successful complaint submission preserves later text and its local draft', async () => {
  const r = runtime(), page = r.page('trade-support/index'); page.onLoad({ mode: 'complaint', materialId: 'material' });
  page.input(input('description', '第一份投诉事实')); const pending = page.submit();
  const request = r.requests[0].data; assert.equal(request.reason, '第一份投诉事实');
  page.input(input('description', '提交期间补写的新事实')); const alertsBefore = r.state.alertsDisabled;
  r.requests[0].resolve({ duplicate: false }); await pending;
  assert.equal(page.data.description, '提交期间补写的新事实');
  assert.equal(page.data.localDraftRetained, true);
  assert.equal(r.storage.get('trade-support-material').description, '提交期间补写的新事实');
  assert.equal(r.state.alertsDisabled, alertsBefore); assert.match(page.data.notice, /后续输入仅保留在本机/);
});

test('successful after-sale creation keeps the subsequent facts while loading the new case', async () => {
  const r = runtime(), page = r.page('trade-support/index'); page.onLoad({ orderId: row._id });
  page.input(input('description', '文件无法打开')); const pending = page.submit();
  page.input(input('description', '新的技术补充仍未提交'));
  r.requests[0].resolve({ caseId: 'case-created' }); await tick();
  r.requests[1].resolve({ afterSale: { _id: 'case-created', orderId: row._id, description: '文件无法打开' } }); await tick();
  r.requests[2].resolve({ order: row }); await tick(); r.requests[3].resolve({ access: 'approved', member: { role: 'member' } }); await pending;
  assert.equal(page.caseId, 'case-created'); assert.equal(page.data.description, '新的技术补充仍未提交');
  assert.equal(r.storage.get('trade-support-case-created').description, '新的技术补充仍未提交');
  assert.equal(page.data.localDraftRetained, true); assert.equal(page.data.case.description, '文件无法打开');
  const reopened = r.page('trade-support/index'); reopened.onLoad({ caseId: 'case-created', orderId: row._id });
  assert.equal(reopened.data.description, '新的技术补充仍未提交'); assert.equal(reopened.data.localDraftRetained, true);
});

test('coordination submitted before a new draft does not erase the new administrator explanation', async () => {
  const r = runtime(), page = r.page('trade-support/index'); page.onLoad({ caseId: 'case' });
  page.setData({ case: { _id: 'case', orderId: row._id, revision: 2 }, canAdmin: true });
  page.input(input('coordination', '已核查原文件')); const pending = page.resolve();
  r.modals[0].success({ confirm: true }); await tick();
  page.input(input('coordination', '新写的补充核查说明'));
  r.requests[0].resolve({}); await tick();
  r.requests[1].resolve({ afterSale: { _id: 'case', orderId: row._id, status: 'closed', revision: 3 } }); await tick();
  r.requests[2].resolve({ order: row }); await tick(); r.requests[3].resolve({ access: 'approved', member: { role: 'admin' } }); await pending;
  assert.equal(page.data.coordination, '新写的补充核查说明');
  assert.equal(r.storage.get('trade-support-case').coordination, '新写的补充核查说明');
  assert.equal(page.data.localDraftRetained, true); assert.equal(page.data.case.status, 'closed');
});

test('unchanged support draft is cleared only after the successful request', async () => {
  const r = runtime(), page = r.page('trade-support/index'); page.onLoad({ mode: 'complaint', materialId: 'm' });
  page.input(input('description', '已确认的事实')); const pending = page.submit();
  r.requests[0].resolve({}); await pending;
  assert.equal(page.data.description, ''); assert.equal(page.data.localDraftRetained, false);
  assert.equal(r.storage.has('trade-support-m'), false); assert.equal(page._request, '');
});

test('payment proof success preserves edits made after the request instead of deleting their saved draft', async () => {
  const r = runtime(), page = r.page('trade-payment/index'); page.onLoad({ id: row._id });
  page.setData({ order: { ...row, status: 'awaitingPayment' }, assetId: 'proof-original' });
  page.input(input('transferReference', 'transfer-original')); page.input(input('note', '第一份说明'));
  const pending = page.submit(); assert.equal(r.requests[0].data.note, '第一份说明');
  page.input(input('note', '尚未提交的新说明')); const alertsBefore = r.state.alertsDisabled;
  r.requests[0].resolve({ order: { ...row, status: 'awaitingSeller' } }); await pending;
  assert.equal(page.data.note, '尚未提交的新说明'); assert.equal(page.data.assetId, 'proof-original');
  assert.equal(r.storage.get('trade-proof-' + row._id).note, '尚未提交的新说明');
  assert.equal(r.state.alertsDisabled, alertsBefore); assert.match(page.data.notice, /后续输入仅保留在本机/);
});

test('switching complaints requires an explicit discard and cancellation keeps the original draft', async () => {
  const r = runtime(), page = r.page('admin-trade/index');
  const first = { _id: 'first' }, second = { _id: 'second' };
  page.setData({ tab: 'complaints', items: [first, second], selected: first, reason: '原投诉核查中' }); page._reasonId = 'first';
  let pending = page.open(event({ id: 'second' })); assert.equal(r.modals.length, 1);
  r.modals[0].success({ confirm: false }); await pending;
  assert.equal(page.data.selected._id, 'first'); assert.equal(page.data.reason, '原投诉核查中');
  pending = page.open(event({ id: 'second' })); r.modals[1].success({ confirm: true }); await pending;
  assert.equal(page.data.selected._id, 'second'); assert.equal(page.data.reason, ''); assert.equal(page._reasonId, 'second');
});

test('confirmed admin tab switch clears the old complaint reason before loading the next list', async () => {
  const r = runtime(), page = r.page('admin-trade/index'); page._reasonId = 'first';
  page.setData({ tab: 'complaints', reason: '尚未提交' }); const pending = page.tab(event({ tab: 'afterSales' }));
  r.modals[0].success({ confirm: true }); await pending;
  assert.equal(page.data.reason, ''); assert.equal(page._reasonId, ''); assert.equal(page.data.tab, 'afterSales');
  assert.equal(r.requests[0].data.action, 'listAfterSales'); r.requests[0].resolve({ items: [], hasMore: false }); await tick();
});

test('old complaint switch confirmation cannot change the reopened page', async () => {
  const r = runtime(), page = r.page('admin-trade/index'); const first = { _id: 'first' }, second = { _id: 'second' };
  page._reasonId = 'first'; page.setData({ tab: 'complaints', items: [first, second], selected: first, reason: '保留说明' });
  const pending = page.open(event({ id: 'second' })); page.onHide(); page.onShow();
  r.modals[0].success({ confirm: true }); await pending;
  assert.equal(page.data.reason, '保留说明'); assert.equal(page.data.selected, null); assert.equal(page._reasonId, 'first');
  assert.equal(r.requests.length, 1); r.requests[0].resolve({ items: [], hasMore: false }); await tick();
});

test('old close or tab confirmation cannot discard a draft after the page is hidden', async () => {
  for (const method of ['close', 'tab']) {
    const r = runtime(), page = r.page('admin-trade/index'); page._reasonId = 'first';
    page.setData({ tab: 'complaints', selected: { _id: 'first' }, reason: '保留说明' });
    const pending = method === 'close' ? page.close() : page.tab(event({ tab: 'afterSales' }));
    page.onHide(); r.modals[0].success({ confirm: true }); await pending;
    assert.equal(page.data.reason, '保留说明'); assert.equal(page.data.tab, 'complaints'); assert.equal(r.requests.length, 0);
  }
});


test('later administrator input survives successful complaint resolution and remains bound to its original complaint', async () => {
  const r = runtime(), page = r.page('admin-trade/index'); const complaint = { _id: 'first', revision: 2 };
  page._reasonId = 'first'; page.setData({ tab: 'complaints', selected: complaint, items: [complaint] });
  page.input({ detail: { value: '已核查原文件' } }); const pending = page.resolve(event({ decision: 'restrict' }));
  r.modals[0].success({ confirm: true }); await tick(); page.input({ detail: { value: '后来补写的核查说明' } });
  r.requests[0].resolve({}); await tick(); r.requests[1].resolve({ items: [], hasMore: false }); await pending;
  assert.equal(page.data.reason, '后来补写的核查说明'); assert.equal(page._reasonId, 'first'); assert.equal(page.data.selected, null);
});

test('material search and type filters continue into unloaded cloud pages', async () => {
  const r = runtime(), page = r.page('materials/index');
  const first = page.load(true);
  r.requests[0].resolve({
    items: [{ _id: 'guide', title: '复习流程', type: '学习指南', priceCents: 0 }],
    hasMore: true, nextCursor: 'page-2'
  });
  await first;
  page.inputQuery({ detail: { value: '微积分' } });
  const searching = page.search();
  assert.equal(r.requests[1].data.cursor, 'page-2');
  r.requests[1].resolve({
    items: [{ _id: 'notes', title: '函数课堂笔记', course: '微积分', type: '课程笔记', priceCents: 0 }],
    hasMore: false
  });
  await searching;
  assert.deepEqual(Array.from(page.data.leftCards, item => item._id), ['notes']);
  page.selectType(event({ type: '学习指南' }));
  assert.equal(page.data.leftCards.length, 0);
  page.clearSearch();
  assert.deepEqual(Array.from(page.data.leftCards, item => item._id), ['guide']);
  page.resetFilters();
  assert.deepEqual(Array.from(page.data.rightCards, item => item._id), ['notes']);
});
