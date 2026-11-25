const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, input, event } = require('./runtime');
const normal = value => JSON.parse(JSON.stringify(value));
const material = { _id: 'a'.repeat(32), title: '课程整理', course: 'MATH1001', description: '认真整理的课程笔记。', type: '课程笔记', learningModes: ['系统复习'], priceCents: 0, status: 'draft', revision: 2, isOwner: true, catalog: [], pageCount: 3 };
function submitPage() {
  const r = runtime(), p = r.page('material-submit/index'); p.onLoad({});
  p.setData({ loading: false, access: 'approved', adultConfirmed: true, title: material.title, course: material.course, description: material.description, type: material.type, learningModes: material.learningModes, price: '0' });
  return { r, p, trade: r.load('utils/trade.js') };
}
function existingSubmit() {
  const f = submitPage(); f.p._materialId = material._id;
  f.p.setData({ material: { ...material }, materialId: material._id, expectedRevision: material.revision });
  return f;
}
function adminPage() {
  const r = runtime(), p = r.page('admin-material/index'); p.onLoad({ id: material._id });
  p.setData({ loading: false, allowed: true, material: { ...material, status: 'pending', pendingVersionId: 'b'.repeat(32) }, reason: '已核对资料说明', reasonCount: 7 });
  return { r, p, trade: r.load('utils/trade.js') };
}

test('资料信息非法时不请求云端并保留Unicode输入', async () => {
  const { r, p } = submitPage();
  p.setData({ title: '🙂'.repeat(61), price: '1.001' });
  await p.saveDraft();
  assert.equal(r.requests.length, 0); assert.equal(p.data.title, '🙂'.repeat(61));
  assert.match(p.data.fieldErrors.title, /60/); assert.match(p.data.fieldErrors.price, /两位/);
});

test('资料价格以整数分提交，保存连点只创建一个请求', async () => {
  const { r, p } = submitPage(); p.setData({ price: '0.01' });
  const pending = p.saveDraft(), duplicate = p.saveDraft(); await tick();
  assert.equal(r.requests.length, 1); assert.equal(r.requests[0].data.priceCents, 1);
  assert.equal(r.requests[0].data.action, 'saveMaterialDraft');
  r.requests[0].resolve({ material: { ...material, revision: 1, priceCents: 1 } });
  await Promise.all([pending, duplicate]);
  assert.equal(p.data.expectedRevision, 1); assert.equal(p.data.materialId, material._id);
});

test('年龄资格未确认时先解释，取消不保存云端草稿', async () => {
  const { r, p } = submitPage(); p.setData({ adultConfirmed: false });
  const pending = p.saveDraft(), duplicate = p.saveDraft(); await tick();
  assert.equal(r.modals.length, 1); assert.match(r.modals[0].content, /18岁/);
  assert.equal(r.requests.length, 0); r.modals[0].success({ confirm: false });
  await Promise.all([pending, duplicate]); assert.equal(r.requests.length, 0); assert.equal(p.data.busy, '');
});

test('草稿网络失败保留同一去重请求，重试不创建第二笔业务', async () => {
  const { r, p } = submitPage();
  let pending = p.saveDraft(); await tick(); const first = r.requests[0].data.requestId;
  r.requests[0].reject(new Error('network')); await pending;
  assert.equal(p.data.title, material.title); assert.match(p.data.error, /保留/);
  pending = p.saveDraft(); await tick();
  assert.equal(r.requests[1].data.requestId, first);
  r.requests[1].resolve({ material }); await pending;
  assert.equal(p.data.materialId, material._id);
});

test('读取云端版本冲突保留本机说明且不自动升级待提交revision', async () => {
  const { r, p } = existingSubmit(); p._dirty = true; p.setData({ description: '本机未提交的描述。' });
  const pending = p.load(); r.requests[0].resolve({ access: 'approved', adultConfirmed: true }); await tick();
  r.requests[1].resolve({ material: { ...material, revision: 3, description: '新的云端描述。' } }); await pending;
  assert.equal(p.data.description, '本机未提交的描述。'); assert.equal(p.data.expectedRevision, 2); assert.equal(p.data.conflict, true);
  await p.saveDraft(); assert.equal(r.requests.length, 2); assert.match(p.data.error, /冲突/);
});

test('资料文件处理未完成只显示排队，成功封存才允许目录提交', async () => {
  const { r, p } = existingSubmit(); p.setData({ uploadId: 'c'.repeat(32), uploadStatus: 'queued' });
  let pending = p.checkUpload(); r.requests[0].resolve({ status: 'processing', versionId: 'b'.repeat(32) }); await pending; await tick();
  assert.equal(p.data.canSubmit, false); assert.equal(p.data.material.status, 'draft');
  pending = p.refreshUpload(); r.requests[1].resolve({ status: 'ready', versionId: 'b'.repeat(32), pageCount: 3, sha256: 'hash', suggestedCatalog: [{ title: '第一章', page: 1 }] }); await pending;
  assert.equal(p.data.canSubmit, true); assert.equal(p.data.catalogInput, '第一章 | 1');
  assert.equal(p.data.material.status, 'draft');
});

test('分块失败保留上传会话和表单，续传复用会话', async () => {
  const { p, trade } = existingSubmit(); p._file = { name: 'notes.pdf', path: '/tmp/notes.pdf', size: 262145 }; p._uploadRequest = 'same-upload-request';
  const attempts = [];
  trade.uploadPdf = async options => { attempts.push(options); options.onProgress({ uploadId: 'c'.repeat(32), percent: 50 }); throw new Error('第2块上传失败'); };
  await p.retryUpload();
  assert.equal(p.data.uploadId, 'c'.repeat(32)); assert.equal(p.data.title, material.title); assert.equal(p.data.percent, 50);
  await p.retryUpload(); assert.equal(attempts[1].uploadId, 'c'.repeat(32)); assert.equal(attempts[1].requestId, 'same-upload-request');
});

test('原文件丢失要求重新选择，不用同名文件混入旧分块', async () => {
  const { p, trade } = existingSubmit(); p.setData({ uploadId: 'c'.repeat(32), fileName: 'notes.pdf' });
  let called = false; trade.uploadPdf = async () => { called = true; };
  await p.retryUpload(); assert.equal(called, false); assert.match(p.data.error, /重新选择/); assert.equal(p.data.title, material.title);
});

test('目录与试读越界不会提交或清空输入', async () => {
  const { r, p } = existingSubmit(); p.setData({ canSubmit: true, uploadStatus: 'ready', versionId: 'b'.repeat(32), pageCount: 3, catalogInput: '第一章 | 4', previewInput: '1,2', originalConfirmed: true });
  await p.submit(); assert.equal(r.requests.length, 0); assert.match(p.data.error, /目录/); assert.equal(p.data.catalogInput, '第一章 | 4');
  p.setData({ catalogInput: '第一章 | 1', previewInput: '1,1' }); await p.submit();
  assert.equal(r.requests.length, 0); assert.match(p.data.error, /重复/);
});

test('提交资料连点只调用一次，服务端processing不伪报上架', async () => {
  const { r, p } = existingSubmit(); p.setData({ canSubmit: true, uploadStatus: 'ready', versionId: 'b'.repeat(32), pageCount: 3, catalogInput: '第一章 | 1', previewInput: '1,2', originalConfirmed: true });
  const pending = p.submit(), duplicate = p.submit(); await tick();
  assert.equal(r.requests.length, 1); assert.equal(r.requests[0].data.action, 'submitMaterial');
  assert.deepEqual(normal(r.requests[0].data.previewPages), [1, 2]);
  r.requests[0].resolve({ status: 'processing', revision: 3 }); await Promise.all([pending, duplicate]);
  assert.equal(p.data.material.status, 'processing'); assert.equal(p.data.canEdit, false); assert.match(p.data.notice, /未公开/);
});

test('审核异常保留目录和原创确认，资格撤销立即锁提交', async () => {
  const { r, p } = existingSubmit(); p.setData({ canSubmit: true, uploadStatus: 'ready', versionId: 'b'.repeat(32), pageCount: 3, catalogInput: '第一章 | 1', previewInput: '1', originalConfirmed: true });
  let pending = p.submit(); await tick(); r.requests[0].resolve({ ok: false, code: 'MODERATION_UNAVAILABLE', message: '审核异常' }); await pending;
  assert.equal(p.data.catalogInput, '第一章 | 1'); assert.equal(p.data.originalConfirmed, true); assert.equal(p.data.canEdit, true);
  pending = p.submit(); await tick(); r.requests[1].resolve({ ok: false, code: 'ACCESS_DENIED', message: '资格已失效' }); await pending;
  assert.equal(p.data.canSubmit, false); assert.equal(p.data.canEdit, false); assert.equal(p.data.title, material.title);
});

test('资料离开确认取消不导航，草稿保存失败不离开', async () => {
  const { r, p } = submitPage();
  let pending = p.cancel(); r.modals[0].success({ confirm: false }); await pending; assert.equal(r.navigation.length, 0);
  r.state.storageFails = true; pending = p.cancel(); r.modals[1].success({ confirm: true }); await pending;
  assert.equal(r.navigation.length, 0); assert.match(p.data.error, /未保存/);
});

test('已发布资料不能直接保存替换，先下架必须确认且带revision', async () => {
  const { r, p } = existingSubmit(); p.setData({ material: { ...material, status: 'published' }, canEdit: false });
  await p.saveDraft(); assert.equal(r.requests.length, 0);
  const pending = p.availability(), duplicate = p.availability(); await tick(); assert.equal(r.modals.length, 1);
  r.modals[0].success({ confirm: true }); await tick(); assert.equal(r.requests[0].data.status, 'offline'); assert.equal(r.requests[0].data.revision, 2);
  r.requests[0].resolve({ status: 'offline', revision: 3 }); await Promise.all([pending, duplicate]); assert.equal(p.data.canEdit, true);
});

test('管理员入口只认真实会话角色，普通成员不能读取完整资料', async () => {
  const { r, p } = adminPage(); p.setData({ material: null });
  const pending = p.load(); r.requests[0].resolve({ access: 'approved', member: { role: 'member' } }); await pending;
  assert.equal(r.requests.length, 1); assert.equal(p.data.allowed, false); assert.equal(p.data.material, null);
});

test('管理员批准前必须实际打开文件并完成三项核查', async () => {
  const { r, p } = adminPage(); p.setData({ copyrightChecked: true, descriptionChecked: true, fullDocumentChecked: true, documentOpened: false });
  await p.review(event({ decision: 'approve' })); assert.equal(r.modals.length, 0); assert.equal(r.requests.length, 0); assert.match(p.data.error, /完整PDF/);
  p.setData({ documentOpened: true, fullDocumentChecked: false }); await p.review(event({ decision: 'approve' })); assert.equal(r.requests.length, 0);
});

test('完整PDF打开失败不标已核查，成功只标打开不勾选', async () => {
  const { r, p, trade } = adminPage(); trade.openDocument = async () => { throw new Error('打开失败'); };
  let pending = p.document(); r.requests[0].resolve({ url: 'https://example.test/source' }); await pending;
  assert.equal(p.data.documentOpened, false);
  trade.openDocument = async () => ({ opened: true }); pending = p.document(); r.requests[1].resolve({ url: 'https://example.test/source' }); await pending;
  assert.equal(p.data.documentOpened, true); assert.equal(p.data.fullDocumentChecked, false);
});

test('管理员处置连点一份确认，成功状态来自服务端', async () => {
  const { r, p } = adminPage(); p.setData({ copyrightChecked: true, descriptionChecked: true, fullDocumentChecked: true, documentOpened: true });
  const pending = p.review(event({ decision: 'approve' })), duplicate = p.review(event({ decision: 'approve' })); await tick();
  assert.equal(r.modals.length, 1); r.modals[0].success({ confirm: true }); await tick();
  assert.equal(r.requests.length, 1); assert.equal(r.requests[0].data.revision, 2); assert.equal(r.requests[0].data.fullDocumentChecked, true);
  r.requests[0].resolve({ status: 'published', revision: 3 }); await Promise.all([pending, duplicate]); assert.equal(p.data.material.status, 'published');
});

test('管理员审核冲突保留理由，刷新版本并清空旧核查勾选', async () => {
  const { r, p } = adminPage(); p.setData({ copyrightChecked: true, descriptionChecked: true, fullDocumentChecked: true, documentOpened: true });
  const pending = p.review(event({ decision: 'approve' })); r.modals[0].success({ confirm: true }); await tick();
  r.requests[0].resolve({ ok: false, code: 'CONFLICT', message: '已被处理' }); await tick();
  r.requests[1].resolve({ access: 'approved', member: { role: 'admin' } }); await tick();
  r.requests[2].resolve({ material: { ...material, status: 'rejected', revision: 3 } }); await pending;
  assert.equal(p.data.reason, '已核对资料说明'); assert.equal(p.data.copyrightChecked, false); assert.equal(p.data.documentOpened, false); assert.equal(p.data.material.revision, 3);
});

test('管理员离开页面后晚返回不展示审核成功', async () => {
  const { r, p } = adminPage();
  const pending = p.review(event({ decision: 'reject' })); r.modals[0].success({ confirm: true }); await tick();
  p.onUnload(); r.requests[0].resolve({ status: 'rejected', revision: 3 }); await pending;
  assert.equal(p.data.result, null); assert.equal(p.data.material.status, 'pending');
});

test('已提交且驳回的封存版本不能伪装为可再次提交，需新文件版本', async () => {
  const { r, p } = existingSubmit();
  p.setData({ material: { ...material, status: 'rejected', pendingVersionId: 'b'.repeat(32) }, uploadId: 'c'.repeat(32), versionId: 'b'.repeat(32), uploadStatus: 'ready' });
  const pending = p.refreshUpload(); r.requests[0].resolve({ status: 'ready', versionId: 'b'.repeat(32), pageCount: 3, sha256: 'hash', suggestedCatalog: [] }); await pending;
  assert.equal(p.data.canSubmit, false); assert.match(p.data.notice, /新文件版本/);
});

test('取消载入最新版本保留本机输入，不悄悄覆盖', async () => {
  const { r, p } = existingSubmit(); p._dirty = true; p.setData({ title: '本机尚未保存', conflict: true });
  const pending = p.reloadLatest(); r.modals[0].success({ confirm: false }); await pending;
  assert.equal(r.requests.length, 0); assert.equal(p.data.title, '本机尚未保存'); assert.equal(p.data.conflict, true);
});

test('资料保存请求晚于页面卸载返回时不显示成功或覆盖本机编辑', async () => {
  const { r, p } = submitPage();
  const pending = p.saveDraft(); await tick(); p.onUnload();
  r.requests[0].resolve({ material: { ...material, revision: 1 } }); await pending;
  assert.equal(p.data.material, null); assert.equal(p.data.materialId, ''); assert.equal(p.data.title, material.title);
});

test('管理员驳回仍需有效说明，取消确认不发处置', async () => {
  const { r, p } = adminPage(); p.setData({ reason: '🙂' });
  await p.review(event({ decision: 'reject' })); assert.equal(r.modals.length, 0); assert.equal(r.requests.length, 0);
  p.setData({ reason: '请补充来源说明' }); const pending = p.review(event({ decision: 'reject' }));
  r.modals[0].success({ confirm: false }); await pending; assert.equal(r.requests.length, 0);
});

test('资料提交后新建入口释放，已提交材料在本人编号草稿中保留', async () => {
  const { r, p } = existingSubmit(); p.setData({ canSubmit: true, uploadStatus: 'ready', versionId: 'b'.repeat(32), pageCount: 3, catalogInput: '第一章 | 1', previewInput: '1', originalConfirmed: true }); p.saveLocal();
  assert.equal(r.storage.has('campusMaterialDraftV24:new'), true);
  const pending = p.submit(); await tick(); r.requests[0].resolve({ status: 'processing', revision: 3 }); await pending;
  assert.equal(r.storage.has('campusMaterialDraftV24:new'), false);
  assert.equal(r.storage.has('campusMaterialDraftV24:' + material._id), true);
  p.onUnload(); assert.equal(r.storage.has('campusMaterialDraftV24:new'), false);
});

test('从我的资料重新打开时仍能找回本机分块上传会话', () => {
  const { r, p } = existingSubmit(); p._file = { name: 'notes.pdf', path: '/saved/notes.pdf', size: 100 }; p._uploadRequest = 'same-request';
  p.setData({ uploadId: 'c'.repeat(32), uploadStatus: 'uploading', fileName: 'notes.pdf', percent: 25 }); p.saveLocal();
  const same = r.page('material-submit/index'); same.onLoad({ id: material._id });
  assert.equal(same.data.uploadId, 'c'.repeat(32)); assert.equal(same.data.percent, 25); assert.equal(same._file.path, '/saved/notes.pdf');
});

test('返回上架页重新核资格，撤销后清私有资料但保留本机输入和上传进度', async () => {
  const { r, p } = existingSubmit(); p._initialized = true; p._dirty = true;
  p.setData({ title: '本机未提交标题', uploadId: 'upload-session', percent: 40, canSubmit: true });
  p.onHide(); const returning = p.onShow();
  assert.equal(r.requests[0].data.action, 'session'); assert.equal(p.data.canEdit, false); assert.equal(p.data.canSubmit, false);
  r.requests[0].resolve({ access: 'revoked', adultConfirmed: true }); await returning;
  assert.equal(p.data.material, null); assert.equal(p.data.access, 'revoked'); assert.equal(p.data.canEdit, false);
  assert.equal(p.data.title, '本机未提交标题'); assert.equal(p.data.uploadId, 'upload-session'); assert.equal(p.data.percent, 40);
  await p.saveDraft(); assert.equal(r.requests.length, 1);
});

test('返回资格已撤销后，之前保存响应不能恢复私有资料或成功提示', async () => {
  const { r, p } = existingSubmit(); p._initialized = true;
  const saving = p.saveDraft(); await tick(); p.onHide(); const returning = p.onShow();
  r.requests[1].resolve({ access: 'revoked' }); await returning;
  r.requests[0].resolve({ material: { ...material, revision: 3 } }); await saving;
  assert.equal(p.data.material, null); assert.equal(p.data.access, 'revoked'); assert.equal(p.data.notice, ''); assert.equal(p.data.canSubmit, false);
});

test('返回上架页不覆盖输入，云版本变化要求核对且保留旧revision', async () => {
  const { r, p } = existingSubmit(); p._initialized = true; p.setData({ title: '返回前标题' });
  p.onHide(); const returning = p.onShow(); r.requests[0].resolve({ access: 'approved', adultConfirmed: true }); await tick();
  r.requests[1].resolve({ material: { ...material, title: '另一个设备改动', revision: 3 } }); await returning;
  assert.equal(p.data.title, '返回前标题'); assert.equal(p.data.expectedRevision, 2); assert.equal(p.data.conflict, true);
});

test('选择PDF的原生隐藏返回保留文件，并重新核资格后才上传', async () => {
  const { r, p, trade } = existingSubmit(); p._initialized = true;
  let finishChoose; trade.choosePdf = () => new Promise(resolve => { finishChoose = resolve; });
  let uploaded = null; trade.uploadPdf = async options => { uploaded = options.file; return { uploadId: 'u', versionId: 'v', status: 'queued' }; };
  const selecting = p.choose(); await tick(); p.onHide(); await p.onShow();
  assert.equal(r.requests.length, 0); assert.equal(p._active, true);
  finishChoose({ name: '真实选择.pdf', path: '/tmp/selected.pdf', size: 100 }); await tick();
  assert.equal(r.requests[0].data.action, 'session'); assert.equal(uploaded, null);
  r.requests[0].resolve({ access: 'approved', adultConfirmed: true }); await tick();
  assert.equal(uploaded.path, '/tmp/selected.pdf');
  r.requests[1].resolve({ status: 'queued', versionId: 'v' }); await selecting;
  assert.equal(p._file.path, '/tmp/selected.pdf'); assert.equal(p.data.fileName, '真实选择.pdf'); assert.equal(p.data.busy, '');
});

test('选择PDF期间资格被撤销时保留选择但不开始上传', async () => {
  const { r, p, trade } = existingSubmit();
  trade.choosePdf = async () => ({ name: 'notes.pdf', path: '/tmp/selected.pdf', size: 100 });
  let uploaded = false; trade.uploadPdf = async () => { uploaded = true; };
  const selecting = p.choose(); await tick(); r.requests[0].resolve({ access: 'revoked' }); await selecting;
  assert.equal(uploaded, false); assert.equal(p._file.path, '/tmp/selected.pdf'); assert.equal(p.data.material, null); assert.equal(p.data.canEdit, false);
});

test('返回全量审核页重核管理员，撤权清文件与勾选但保留本人说明', async () => {
  const { r, p } = adminPage(); p.setData({ copyrightChecked: true, descriptionChecked: true, fullDocumentChecked: true, documentOpened: true });
  p.onHide(); const returning = p.onShow(); assert.equal(p.data.allowed, false);
  r.requests[0].resolve({ access: 'approved', member: { role: 'member' } }); await returning;
  assert.equal(p.data.material, null); assert.equal(p.data.documentOpened, false); assert.equal(p.data.copyrightChecked, false); assert.equal(p.data.reason, '已核对资料说明');
  await p.document(); assert.equal(r.requests.length, 1);
});

test('管理员返回确认撤权后较早完整文件请求不能打开文档', async () => {
  const { r, p, trade } = adminPage(); let opened = false; trade.openDocument = async () => { opened = true; };
  const read = p.document(); p.onHide(); const returning = p.onShow();
  r.requests[1].resolve({ access: 'revoked' }); await returning;
  r.requests[0].resolve({ url: 'https://private.test/late-source' }); await read;
  assert.equal(opened, false); assert.equal(p.data.material, null); assert.equal(p.data.allowed, false);
});

test('我的资料返回重新读取，迟到分页不能覆盖新拒绝并恢复私有列表', async () => {
  const r = runtime(), p = r.page('my-materials/index');
  p.setData({ items: [material], hasMore: true, nextCursor: 'cursor' });
  const old = p.load(false); p.onHide(); const returning = p.onShow();
  r.requests[1].resolve({ ok: false, code: 'ACCESS_DENIED', message: '资格撤销' }); await returning;
  r.requests[0].resolve({ items: [material], hasMore: true, nextCursor: 'another' }); await old;
  assert.equal(p.data.items.length, 0); assert.equal(p.data.hasMore, false); assert.equal(p.data.loading, false);
});

test('原生完整PDF阅读返回即使打开回调仍在等待，也重新核对管理员资格', async () => {
  const { r, p, trade } = adminPage(); let finishReader;
  trade.openDocument = () => new Promise(resolve => { finishReader = resolve; });
  const doc = p.document(); r.requests[0].resolve({ url: 'https://private.test/source' }); await tick();
  p.onHide(); const returning = p.onShow();
  assert.equal(r.requests[1].data.action, 'session'); assert.equal(p.data.allowed, false);
  r.requests[1].resolve({ access: 'revoked' }); await returning;
  finishReader({ opened: true }); await doc;
  assert.equal(p.data.allowed, false); assert.equal(p.data.material, null); assert.equal(p.data.documentOpened, false);
});
