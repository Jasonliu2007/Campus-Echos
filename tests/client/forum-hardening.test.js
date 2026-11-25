const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, input, event } = require('./runtime');
const post = { _id: 'p', title: '标题', content: '正文', status: 'published', category: '校园生活墙', revision: 2, mediaIds: [], isOwner: true, editDeadline: Date.now() + 1800000 };

test('搜索词或筛选修改后不混用旧游标，旧请求晚回仍保留已读结果', async () => {
  const r = runtime(), p = r.page('wall-search/index'); p.onLoad(); p.onShow(); p.input(input('', '校园'));
  let pending = p.search(); r.requests.shift().resolve({ posts: [post], hasMore: true, nextCursor: 'old-page' }); await pending;
  pending = p.loadMore(); const old = r.requests.shift(); p.input(input('', 'AI')); old.resolve({ posts: [{ ...post, _id: 'stale' }], hasMore: false }); await pending;
  assert.equal(p.data.items[0]._id, 'p'); assert.equal(p.data.needsSearch, true); assert.equal(p.data.loadingMore, false);
  await p.loadMore(); assert.equal(r.requests.length, 0); assert.match(p.data.pageError, /条件已修改/);
  pending = p.search(); const request = r.requests.shift(); assert.equal(request.data.query, 'AI'); assert.equal('cursor' in request.data, false);
  request.resolve({ posts: [{ ...post, _id: 'new' }], hasMore: false }); await pending; assert.equal(p.data.items[0]._id, 'new'); assert.equal(p.data.needsSearch, false);
});

test('编辑草稿重进发现新版本时保持旧revision与输入，不能自动覆盖', async () => {
  const r = runtime(); r.storage.set('campusEchoDraftV1:edit:p', { title: '本机标题', content: '本机正文', revision: 1, anonymousLocked: true, isAnonymous: true });
  const p = r.page('wall-publish/index'); p.onLoad({ id: 'p' }); const pending = p.onShow(); r.requests.shift().resolve({ access: 'approved', member: {} }); await tick();
  r.requests.shift().resolve({ post: { ...post, isAnonymous: true } }); await pending;
  assert.equal(p._revision, 1); assert.equal(p.data.content, '本机正文'); assert.equal(p.data.conflict, true); assert.equal(p.data.anonymousLocked, true);
  await p.submit(); assert.equal(r.requests.length, 0);
});

test('核对新编辑版本后生成新的去重请求，30分钟到期自动锁定', async () => {
  const r = runtime(), p = r.page('wall-publish/index'); p.onLoad({ id: 'p' }); p._visible = true; p._revision = 1; p._request = 'old'; p._fingerprint = 'old';
  p.setData({ title: '标题', content: '正文', allowed: true, conflict: true }); const pending = p.rebaseEdit();
  r.requests.shift().resolve({ post: { ...post, editDeadline: r.now() + 1000 } }); await tick(); r.modals.shift().success({ confirm: true }); await pending;
  assert.equal(p._revision, 2); assert.equal(p._request, ''); assert.equal(r.storage.get('campusEchoDraftV1:edit:p').revision, 2);
  r.advance(1000); assert.equal(p.data.editExpired, true); assert.equal(p.data.allowed, false); assert.equal(p.data.content, '正文');
});

test('发布超时后关闭重进仍锁定首次匿名模式且保留去重键', async () => {
  const r = runtime(), p = r.page('wall-publish/index'); p.onLoad(); p.setData({ title: '标题', content: '正文', allowed: true, isAnonymous: true });
  const pending = p.submit(), request = r.requests.shift(); request.reject(Error('timeout')); await pending;
  const next = r.page('wall-publish/index'); next.onLoad(); assert.equal(next.data.anonymousLocked, true); assert.equal(next._request, request.data.requestId);
  await next.toggleAnonymous(); assert.equal(r.modals.length, 0); assert.equal(next.data.isAnonymous, true);
});

test('评论超时后重进仍用原请求键，提交中无法换回复对象', async () => {
  const r = runtime(), p = r.page('wall-detail/index'); p.onLoad({ id: 'p' }); p.setData({ post, comment: '保留评论', replyTo: 'c', replyToName: '匿名楼主', comments: [{ _id: 'd', status: 'published', authorName: '同学' }] });
  let pending = p.sendComment(), first = r.requests.shift(); p.reply(event({ id: 'd' })); p.cancelReply(); p.inputComment(input('', '被改动'));
  assert.equal(p.data.comment, '保留评论'); assert.equal(p.data.replyTo, 'c'); first.reject(Error('timeout')); await pending;
  const next = r.page('wall-detail/index'); next.onLoad({ id: 'p' }); next.setData({ post }); pending = next.sendComment(); const retry = r.requests.shift();
  assert.equal(retry.data.requestId, first.data.requestId); assert.equal(retry.data.replyTo, 'c'); retry.reject(Error('offline')); await pending;
});

test('证据图片请求跨到期返回时不能重新显示私有图片，预览同样拒绝', async () => {
  const r = runtime(), p = r.page('admin-reports/detail'); p.onLoad({ id: 'r' }); const pending = p.onShow();
  r.requests.shift().resolve({ access: 'approved', member: { role: 'admin' } }); await tick();
  r.requests.shift().resolve({ report: { _id: 'r', postId: 'p', status: 'hidden', evidenceExpiresAt: r.now() + 100, snapshot: { mediaIds: ['m'], content: '证据' } } }); await tick();
  const image = r.requests.shift(); assert.equal(image.data.reportId, 'r'); r.advance(100); image.resolve({ mediaId: 'm', status: 'approved', url: 'https://private.example/evidence' }); await pending;
  assert.equal(p.data.report.evidenceExpired, true); assert.equal(p.data.evidenceImages.length, 0); assert.equal(p.data.report.snapshot, null);
  p.setData({ evidenceImages: [{ mediaId: 'm', url: 'https://private.example/evidence' }] }); p.previewEvidence(event({ id: 'm' })); assert.equal(p.data.evidenceImages.length, 0);
});

test('单张图片压缩失败保留其他选择，选图取消不显示错误', async () => {
  const r = runtime(), media = r.load('utils/forum-media.js');
  r.wx.chooseMedia = o => o.success({ tempFiles: [{ tempFilePath: '/a', size: 1 }, { tempFilePath: '/b', size: 700000 }] }); r.wx.compressImage = o => o.fail({ errMsg: 'compress failed' });
  const rows = await media.choose(9); assert.equal(rows.length, 2); assert.equal(rows[0].status, 'local'); assert.equal(rows[1].status, 'failed'); assert.match(rows[1].error, /压缩失败/);
  r.wx.chooseMedia = o => o.fail({ errMsg: 'chooseMedia:fail cancel' }); assert.equal((await media.choose(9)).length, 0);
});

test('评论审核更换对象先确认，冲突后保留原因并禁止再次提交', async () => {
  const r = runtime(), p = r.page('admin-comments/index'); p._visible = true; p.setData({ allowed: true, loading: false, reasonFor: 'a', reason: '核实原因', items: [{ _id: 'a', revision: 1 }, { _id: 'b', revision: 1 }] });
  let pending = p.choose(event({ id: 'b' })); r.modals.shift().success({ confirm: false }); await pending; assert.equal(p.data.reasonFor, 'a'); assert.equal(p.data.reason, '核实原因');
  pending = p.decide(event({ decision: 'approve' })); r.modals.shift().success({ confirm: true }); await tick(); r.requests.shift().resolve({ ok: false, code: 'CONFLICT', message: '已更新' }); await pending;
  assert.equal(p.data.conflict, true); assert.equal(p.data.reason, '核实原因'); await p.decide(event({ decision: 'approve' })); assert.equal(r.modals.length, 0);
});

test('帖子审核和成员处罚的确认跨后台失效，不再发送写入', async () => {
  const r = runtime(), review = r.page('admin-review/detail'); review._visible = true; review.postId = 'p'; review.setData({ post, reason: '核实原因', admin: true });
  let pending = review.decide(event({ decision: 'hide' })); review.onHide(); r.modals.shift().success({ confirm: true }); await pending; assert.equal(r.requests.length, 0);
  const members = r.page('admin-members/index'); members.setData({ sanctionFor: 'u', sanctionReason: '核实原因', items: [{ id: 'u', nickname: '同学', revision: 1 }] });
  pending = members.submitSanction(); members.onHide(); r.modals.shift().success({ confirm: true }); await pending; assert.equal(r.requests.length, 0);
});


test('经验投稿必须确认真实经历，失败保留稿件且不请求云端', async () => {
  const r = runtime(), p = r.page('wall-publish/index'); p.onLoad({ community: 'experience' }); p.setData({ title: '经历', content: '真实过程', allowed: true });
  await p.submit(); assert.equal(r.requests.length, 0); assert.match(p.data.error, /本人真实经历/); assert.equal(p.data.content, '真实过程');
  p.experienceDeclaration({ detail: { value: ['confirmed'] } }); assert.equal(r.storage.get('campusEchoDraftV1:experience').experienceDeclared, true);
  const pending = p.submit(); const request = r.requests.shift(); assert.equal(request.data.experienceDeclared, true); request.reject(Error('offline')); await pending;
});

test('互动请求收到资格撤销时清除详情图片评论缓存，仍保留未提交正文', async () => {
  const r = runtime(), p = r.page('wall-detail/index'); p.postId = 'p'; p.setData({ post, comment: '未提交评论', images: [{ url: 'private' }], comments: [{ content: '缓存' }] });
  const pending = p.like(); r.requests.shift().resolve({ ok: false, code: 'ACCESS_DENIED', message: '资格撤销' }); await pending;
  assert.equal(p.data.post, null); assert.equal(p.data.images.length, 0); assert.equal(p.data.comments.length, 0); assert.equal(p.data.comment, '未提交评论'); assert.equal(p.data.likeBusy, false);
});
