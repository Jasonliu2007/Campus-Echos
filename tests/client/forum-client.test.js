const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick, event, input } = require('./runtime');
const norm = value => JSON.parse(JSON.stringify(value));
const post = { _id: 'p', title: '原文', content: '正文', status: 'published', category: '校园生活墙', revision: 2, mediaIds: [], likeCount: 0, isOwner: false, editDeadline: Date.now() + 1800000 };

test('搜索关键词高亮只输出文本，HTML与正则字符不成为标记', () => {
  const r = runtime(), { segments } = r.load('utils/forum-search.js');
  const rows = segments('<img onerror=x>.*校园', ['.*', '校园']);
  assert.equal(rows.map(x => x.text).join(''), '<img onerror=x>.*校园');
  assert.deepEqual(norm(rows.filter(x => x.hit).map(x => x.text)), ['.*', '校园']);
  assert.equal(rows.some(x => 'html' in x), false);
});

test('搜索游标失效保留结果与游标，刷新由用户明确发起', async () => {
  const r = runtime(), p = r.page('wall-search/index'); p.onLoad(); p.onShow(); p.setData({ query: '校园' });
  let pending = p.search(); r.requests.shift().resolve({ posts: [post], hasMore: true, nextCursor: 'bound-cursor' }); await pending;
  pending = p.load(false); r.requests.shift().resolve({ ok: false, code: 'CURSOR_EXPIRED', message: '内容更新，请刷新' }); await pending;
  assert.equal(p.data.items[0]._id, 'p'); assert.equal(p.data.nextCursor, 'bound-cursor'); assert.match(p.data.pageError, /刷新/);
  assert.equal(r.requests.length, 0);
});

test('搜索隐藏后晚结果不能写回，资格失效清公开缓存', async () => {
  const r = runtime(), p = r.page('wall-search/index'); p.onLoad(); p.onShow(); p.setData({ query: '校园' });
  let pending = p.search(); const request = r.requests.shift(); p.onHide(); request.resolve({ posts: [post], hasMore: false }); await pending;
  assert.equal(p.data.items.length, 0);
  p.onShow(); p.setData({ items: [post] }); pending = p.search(); r.requests.shift().resolve({ ok: false, code: 'ACCOUNT_BANNED', message: '新活动被限制' }); await pending;
  assert.equal(p.data.items.length, 0);
});

test('未审核图片阻止发布，正文和图片顺序仍保留', async () => {
  const r = runtime(), p = r.page('wall-publish/index'); p.setData({ allowed: true, title: '标题', content: '正文', images: [{ key: 'a', mediaId: 'a', status: 'checking' }] });
  await p.submit(); assert.equal(r.requests.length, 0); assert.equal(p.data.content, '正文'); assert.equal(p.data.images[0].key, 'a'); assert.match(p.data.error, /审核通过/);
});

test('单张上传超时保留正文且重试沿用请求键，不通过客户端云存储', async () => {
  const r = runtime(), p = r.page('wall-publish/index');
  r.wx.getFileSystemManager = () => ({ readFile(o) { o.success({ data: 'YQ==' }); } });
  p.setData({ title: '标题', content: '正文', images: [{ key: 'a', requestId: 'original-request', path: '/tmp/a', bytes: 1, status: 'local' }] });
  let pending = p.uploadOne('a'); await tick(); const first = r.requests.shift(); assert.equal(first.data.action, 'uploadMedia'); first.reject(Error('offline')); await pending;
  assert.equal(p.data.images[0].status, 'failed'); assert.equal(p.data.content, '正文');
  pending = p.retryImage(event({ key: 'a' })); await tick(); const retry = r.requests.shift(); assert.equal(retry.data.requestId, 'original-request'); retry.resolve({ mediaId: 'm', status: 'checking' }); await pending;
  assert.equal(p.data.images[0].status, 'checking'); assert.equal(p.data.imageBusy, false);
});

test('编辑超时保留草稿和去重键，冲突需明确核对新版本', async () => {
  const r = runtime(), p = r.page('wall-publish/index'); p.onLoad({ id: 'p' }); p._revision = 2; p.setData({ allowed: true, title: '新标题', content: '新正文', isAnonymous: true });
  let pending = p.submit(); const first = r.requests.shift(); assert.equal(first.data.action, 'editPost'); assert.equal(first.data.revision, 2); first.reject(Error('timeout')); await pending;
  pending = p.submit(); const retry = r.requests.shift(); assert.equal(retry.data.requestId, first.data.requestId); retry.resolve({ ok: false, code: 'CONFLICT', message: '旧版本' }); await pending;
  assert.equal(p.data.conflict, true); assert.equal(p.data.content, '新正文'); await p.submit(); assert.equal(r.requests.length, 0);
  assert.equal(r.storage.get('campusEchoDraftV1:edit:p').content, '新正文');
});

test('匿名首次提交后锁定，经验模板不引入第五论坛分类', async () => {
  const r = runtime(), p = r.page('wall-publish/index'); p.onLoad({ community: 'experience' }); p.setData({ allowed: true, title: '经历', content: '已有文字', isAnonymous: true, experienceDeclared: true }); p.insert(event({ kind: 'template' }));
  assert.match(p.data.content, /准备过程/); assert.equal(p.data.categories.length, 4);
  const pending = p.submit(); const req = r.requests.shift(); assert.equal(req.data.community, 'experience'); req.reject(Error('offline')); await pending;
  assert.equal(p.data.anonymousLocked, true); await p.toggleAnonymous(); assert.equal(p.data.isAnonymous, true);
});

test('点赞连点只提交一次明确状态，失败不改计数', async () => {
  const r = runtime(), p = r.page('wall-detail/index'); p.postId = 'p'; p.setData({ post, liked: false });
  let pending = p.like(); p.like(); assert.equal(r.requests.length, 1); const request = r.requests.shift(); assert.equal(request.data.liked, true); request.reject(Error('offline')); await pending;
  assert.equal(p.data.liked, false); assert.equal(p.data.post.likeCount, 0);
  pending = p.like(); r.requests.shift().resolve({ liked: true, likeCount: 1 }); await pending; assert.equal(p.data.liked, true); assert.equal(p.data.post.likeCount, 1);
});

test('评论安全审核失败保留输入与回复人，重试不会重复提交', async () => {
  const r = runtime(), p = r.page('wall-detail/index'); p.postId = 'p'; p.setData({ post, comment: '保留的评论', replyTo: 'c', replyToName: '匿名楼主' });
  let pending = p.sendComment(); p.sendComment(); const first = r.requests.shift(); first.resolve({ ok: false, code: 'MODERATION_UNAVAILABLE', message: '审核暂不可用' }); await pending;
  assert.equal(p.data.comment, '保留的评论'); assert.equal(p.data.replyToName, '匿名楼主');
  pending = p.sendComment(); const retry = r.requests.shift(); assert.equal(retry.data.requestId, first.data.requestId); retry.resolve({ ok: false, code: 'CONTENT_REJECTED', message: '需修改' }); await pending;
  assert.equal(p.data.commentSubmitting, false); assert.equal(p.data.comment, '保留的评论');
});

test('本人评论和删除帖子关闭新互动，匿名回复目标不替换为真实名称', async () => {
  const r = runtime(), p = r.page('wall-detail/index'); p.postId = 'p'; p.setData({ post, comments: [{ _id: 'c', status: 'published', authorName: '匿名楼主', isOwner: false }] });
  p.reply(event({ id: 'c' })); assert.equal(p.data.replyToName, '匿名楼主'); p.setData({ post: { ...post, status: 'deleted' } }); await p.like(); await p.sendComment(); assert.equal(r.requests.length, 0);
});

test('分区返回复用内容、游标和滚动，不再请求列表', async () => {
  const r = runtime(), p = r.list({ route: 'pages/campus-wall/index', filters: true }); p.setData({ access: 'approved', loading: false, items: [post], hasMore: true, nextCursor: 'a' }); p._hasLoadedList = true; p._scrollTop = 180;
  p.changeFilter(event({ value: '表白墙' })); r.requests.shift().resolve({ posts: [{ ...post, _id: 'b' }], hasMore: false, nextCursor: null }); await tick();
  p.changeFilter(event({ value: '' })); assert.equal(r.requests.length, 0); assert.equal(p.data.items[0]._id, 'p'); assert.equal(p.data.nextCursor, 'a');
});

test('评论举报处理同时带帖子与评论版本，不影响原始举报兼容', async () => {
  const r = runtime(), p = r.load('utils/reports.js').makeDetail(true); const page = { ...p, data: structuredClone(p.data), setData(v) { Object.assign(this.data, v); } }; page._visible = true; page._epoch = 1; page.reportId = 'r';
  page.setData({ allowed: true, loading: false, reason: '核对说明', report: { _id: 'r', status: 'pending', targetType: 'comment', revision: 3, currentPost: { status: 'published', revision: 4 }, currentComment: { status: 'published', revision: 2 } } });
  const pending = page.decide(); r.modals.shift().success({ confirm: true }); await tick(); const req = r.requests.shift(); assert.equal(req.data.commentRevision, 2); assert.equal(req.data.postRevision, 4); req.resolve({ ok: false, code: 'CONFLICT', message: '已更新' }); await pending;
  assert.equal(page.data.reason, '核对说明'); assert.equal(page.data.conflict, true);
});

test('经验推荐筛选固定独立社区并保留两套列表缓存', async () => {
 const r=runtime(),p=r.page('experience/index');p.setData({access:'approved'});
 let pending=p.load(true);assert.equal(r.requests[0].data.community,'experience');assert.equal(r.requests[0].data.recommendedOnly,false);r.requests[0].resolve({posts:[{...post,_id:'all'}],hasMore:false});await pending;
 p.changeFilter(event({value:'recommended'}));assert.equal(r.requests[1].data.recommendedOnly,true);r.requests[1].resolve({posts:[{...post,_id:'featured',community:'experience',recommended:true}],hasMore:false});await tick();
 p.changeFilter(event({value:''}));assert.equal(p.data.items[0]._id,'all');assert.equal(r.requests.length,2);
});

test('经验推荐失败保留阅读内容并在确认中防重复提交', async () => {
 const r=runtime(),p=r.page('wall-detail/index');p._epoch=1;p.postId='p';p.setData({post:{...post,community:'experience',canRecommend:true,recommended:false}});
 const first=p.recommend(),repeat=p.recommend();assert.equal(r.modals.length,1);r.modals[0].success({confirm:true});await tick();assert.equal(r.requests.length,1);assert.equal(r.requests[0].data.action,'setExperienceRecommendation');r.requests[0].reject(Error('offline'));await Promise.all([first,repeat]);
 assert.equal(p.data.post.title,'原文');assert.equal(p.data.post.recommended,false);assert.equal(p.data.recommending,false);assert.match(p.data.error,/连接|网络|稍后/);
});

test('推荐旧版本冲突不自动覆盖或假报成功', async () => {
 const r=runtime(),p=r.page('wall-detail/index');p._epoch=1;p.postId='p';p.setData({post:{...post,community:'experience',canRecommend:true,recommended:false}});
 const pending=p.recommend();r.modals[0].success({confirm:true});await tick();r.requests[0].resolve({ok:false,code:'CONFLICT',message:'新版本'});await pending;
 assert.equal(p.data.post.recommended,false);assert.match(p.data.error,/重新加载/);assert.equal(r.requests.length,1);
});

test('普通成员没有推荐操作且离开确认不会继续发出请求', async () => {
 const r=runtime(),p=r.page('wall-detail/index');p._epoch=1;p.setData({post:{...post,community:'experience',canRecommend:false}});await p.recommend();assert.equal(r.modals.length,0);
 p.setData({post:{...post,community:'experience',canRecommend:true}});const pending=p.recommend();p.onHide();r.modals[0].success({confirm:true});await pending;assert.equal(r.requests.length,0);
});

test('引用入口接收真实的 32 位帖子编号并读取原帖', async () => {
  const r = runtime(), page = r.page('wall-publish/index');
  const sourceId = 'a'.repeat(32);
  page.onLoad({ quote: sourceId });
  const loading = page.onShow();
  r.requests.shift().resolve({ access: 'approved', supportsForumQuotes: true, member: { id: 'member' } });
  await tick();
  const source = r.requests.shift();
  assert.equal(source.data.action, 'getPost');
  assert.equal(source.data.postId, sourceId);
  source.resolve({ post: { ...post, _id: sourceId } });
  await loading;
  assert.equal(page.data.quote._id, sourceId);
});

test('successful searches persist recent queries and clear them on request', async () => {
  const r = runtime();
  const page = r.page('wall-search/index');
  page.onLoad();
  page.onShow();
  for (const query of ['AI', 'ａｉ', '校园']) {
    page.setData({ query });
    const pending = page.search();
    r.requests.shift().resolve({ posts: [], hasMore: false });
    await pending;
  }
  const reopened = r.page('wall-search/index');
  reopened.onLoad();
  assert.deepEqual(norm(reopened.data.history), ['校园', 'ａｉ']);
  reopened.clearHistory();
  const cleared = r.page('wall-search/index');
  cleared.onLoad();
  assert.equal(cleared.data.history.length, 0);
});

test('学长学姐位于全部左侧，列表、搜索和发帖使用独立社区', async () => {
  const r = runtime();
  const p = r.page('campus-wall/index');
  assert.deepEqual(Array.from(p.data.sections.slice(0, 2), tab => tab.label), ['学长学姐', '全部']);
  assert.equal(p.listParams().community, 'forum');
  p.setData({ access: 'approved' });
  p.changeFilter({ currentTarget: { dataset: { value: 'experience' } } });
  assert.equal(r.requests[0].data.community, 'experience');
  assert.equal(r.requests[0].data.category, undefined);
  p.search();
  p.publish();
  assert.deepEqual(r.navigation.map(row => row.options.url), [
    '/pages/wall-search/index?community=experience',
    '/pages/wall-publish/index?community=experience'
  ]);
  p.changeFilter({ currentTarget: { dataset: { value: '' } } });
  assert.equal(r.requests[1].data.community, 'forum');
  assert.equal(r.requests[1].data.category, undefined);
});

test('四个墙进入发帖时默认选中当前分区，同时保留已写的草稿', () => {
  const r = runtime();
  const wall = r.page('campus-wall/index');
  const categories = r.load('utils/campus.js').categories;
  wall.setData({ access: 'approved' });
  r.storage.set('campusEchoDraftV1', { title: '已有草稿', content: '草稿正文', category: categories[0] });
  categories.forEach((category, index) => {
    wall.setData({ filter: category });
    wall.publish();
    const url = r.navigation.at(-1).options.url;
    assert.equal(url, '/pages/wall-publish/index?categoryIndex=' + index);
    const form = r.page('wall-publish/index');
    form.onLoad(Object.fromEntries(new URLSearchParams(url.split('?')[1])));
    assert.equal(form.data.category, category);
    assert.equal(form.data.content, '草稿正文');
  });
  const form = r.page('wall-publish/index');
  form.onLoad({ categoryIndex: '9' });
  assert.equal(form.data.category, categories[0]);
});
