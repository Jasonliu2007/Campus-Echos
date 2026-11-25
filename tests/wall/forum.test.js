'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWallService, APPID, memberId, hash, CATEGORIES } = require('../../cloudfunctions/xiaopinWall/service');
const search = require('../../cloudfunctions/xiaopinWall/search-core');
const { Repo, fixture } = require('./forum-fixture');
const payload = (n=1,patch={})=>({category:'校园生活墙',title:'校园生活记录',content:'今天参加校园活动。',requestId:`post-request-${n}`,...patch});
test('new forum categories are exact and legacy posts map on read without rewriting evidence',async()=>{
 const f=fixture();assert.deepEqual(CATEGORIES,['校园生活墙','表白墙','AI论坛墙','申研实习墙']);
 for(const category of ['学习互助','闲置转让','学长学姐经验分享墙'])assert.equal((await f.call('publish',payload(1,{category}))).code,'INVALID_INPUT');
 const p=f.post(1,{category:'学习互助'});assert.equal((await f.call('list',{category:'校园生活墙'})).posts[0].category,'校园生活墙');assert.equal((await f.repo.get('posts',p._id)).category,'学习互助');
});
test('search scans all candidates and ranks title phrase ahead of body matches',async()=>{
 const f=fixture();for(let i=0;i<130;i++)f.post(i,{title:i===0?'人工智能研究':'校园话题',content:'人工智能研究的讨论',createdAt:f.time()-i});
 const result=await f.call('searchPosts',{query:'人工智能研究'});assert.equal(result.ok,true);assert.equal(result.posts.length,20);assert.equal(result.posts[0].title,'人工智能研究');assert.ok(result.posts[0].score>result.posts[1].score);assert.ok(result.nextCursor);assert.ok(result.posts.every(p=>Array.from(p.summary).length<=60));
 let cursor=result.nextCursor,ids=result.posts.map(p=>p._id);while(cursor){const page=await f.call('searchPosts',{query:'人工智能研究',cursor});assert.equal(page.ok,true);ids.push(...page.posts.map(p=>p._id));cursor=page.nextCursor;}assert.equal(ids.length,130);assert.equal(new Set(ids).size,130);
});
test('search score follows fixed 16/4/4/1 rule and Chinese normalization',()=>{
 assert.equal(search.score({title:'校园生活',content:'校园生活'},'校园生活',['校园','生活']),30);
 assert.equal(search.normalize('ＡＩ  论坛'),'ai 论坛');assert.ok(search.tokenize('申研实习的经验').length>1);
});
test('search filters category, time and community; private content never leaks',async()=>{
 const f=fixture();f.post(1);f.post(2,{status:'pending'});f.post(3,{category:'表白墙'});f.post(4,{community:'experience'});f.post(5,{createdAt:f.time()-8*86400000});
 const r=await f.call('searchPosts',{query:'学习',category:'校园生活墙',timeRange:'7d'});assert.equal(r.posts.length,1);assert.equal(JSON.stringify(r).includes('authorId'),false);
 assert.equal((await f.call('searchPosts',{query:'学习',community:'experience'})).posts.length,1);
});
test('search cursor is bound to query, categories and content revisions without mutation by likes',async()=>{
 const f=fixture();for(let i=0;i<25;i++)f.post(i);const first=await f.call('searchPosts',{query:'学习'});
 assert.equal((await f.call('searchPosts',{query:'经验',cursor:first.nextCursor})).code,'INVALID_CURSOR');
 await f.call('setLiked',{postId:first.posts[0]._id,liked:true},'other');assert.equal((await f.call('searchPosts',{query:'学习',cursor:first.nextCursor})).ok,true);
 f.repo.tables.posts.get(first.posts[0]._id).revision++;assert.equal((await f.call('searchPosts',{query:'学习',cursor:first.nextCursor})).code,'CURSOR_EXPIRED');
});
test('empty, punctuation and oversized search inputs are rejected',async()=>{
 const f=fixture();for(const query of ['','...','好'.repeat(61)])assert.equal((await f.call('searchPosts',{query})).code,'INVALID_INPUT');
});
test('anonymous posts require human approval and public projections redact true identity',async()=>{
 const f=fixture();const pub=await f.call('publish',payload(1,{isAnonymous:true}));assert.equal(pub.status,'pending');assert.equal((await f.call('list')).posts.length,0);
 const allowed=await f.call('reviewPost',{postId:pub.postId,revision:1,decision:'approve'},'admin');assert.equal(allowed.status,'published');
 const view=await f.call('getPost',{postId:pub.postId},'other');assert.equal(view.post.authorName,'匿名同学');assert.equal(JSON.stringify(view).includes('真实昵称-author'),false);assert.equal(JSON.stringify(view).includes(memberId('author')),false);
 assert.equal((await f.call('getPostAuthor',{postId:pub.postId,reason:'核对举报对象'},'other')).code,'FORBIDDEN');
 const inspect=await f.call('getPostAuthor',{postId:pub.postId,reason:'核对举报对象'},'admin');assert.equal(inspect.author.memberId,memberId('author'));assert.ok([...f.repo.tables.audit.values()].some(x=>x.action==='inspectPostAuthor'));
});
test('editing preserves creation time and anonymous lock, is idempotent and deadline exact',async()=>{
 const f=fixture();const p=f.post();const edit={postId:p._id,revision:1,requestId:'edit-request-1',category:'AI论坛墙',title:'新标题',content:'新的正文'};
 f.advance(29*60000);const r=await f.call('editPost',edit);assert.equal(r.ok,true);assert.equal((await f.repo.get('posts',p._id)).createdAt,p.createdAt);assert.equal((await f.call('editPost',edit)).revision,2);
 assert.equal((await f.call('editPost',{...edit,content:'修改重试'})).code,'REQUEST_CONFLICT');assert.equal((await f.call('editPost',{...edit,requestId:'edit-request-2',revision:2,isAnonymous:true})).code,'ANONYMOUS_LOCKED');f.advance(60000);assert.equal((await f.call('editPost',{...edit,revision:2,requestId:'edit-request-3'})).code,'EDIT_WINDOW_EXPIRED');
});
test('editing rejects stale revision and failed moderation retains original',async()=>{
 const f=fixture(),p=f.post();const edit={postId:p._id,revision:2,requestId:'edit-request-1',category:'校园生活墙',title:'新的标题',content:'新的正文'};assert.equal((await f.call('editPost',edit)).code,'CONFLICT');f.error(true);assert.equal((await f.call('editPost',{...edit,revision:1})).code,'MODERATION_UNAVAILABLE');assert.equal((await f.repo.get('posts',p._id)).title,p.title);
});
test('anonymous author comments and reply target names remain anonymous',async()=>{
 const f=fixture(),p=f.post(1,{isAnonymous:true});const a=await f.call('publishComment',{postId:p._id,content:'楼主补充',requestId:'comment-request-1'});assert.equal(a.ok,true);
 const b=await f.call('publishComment',{postId:p._id,content:'谢谢楼主',replyTo:a.commentId,requestId:'comment-request-2'},'other');assert.equal(b.ok,true);
 const list=await f.call('listComments',{postId:p._id},'other');assert.equal(list.comments.find(c=>c._id===a.commentId).authorName,'匿名楼主');assert.equal(list.comments.find(c=>c._id===b.commentId).replyToName,'匿名楼主');assert.equal(JSON.stringify(list).includes('真实昵称-author'),false);
});
test('comments reject identity spoofing, enforce Unicode500 and idempotent requests',async()=>{
 const f=fixture(),p=f.post();const data={postId:p._id,content:'🙂'.repeat(500),requestId:'comment-request-1',authorId:memberId('admin')};
 const responses=await Promise.all(Array.from({length:6},()=>f.call('publishComment',data)));assert.ok(responses.every(x=>x.ok));assert.equal(f.repo.tables.comments.size,1);assert.equal((await f.repo.get('posts',p._id)).commentCount,1);assert.equal([...f.repo.tables.comments.values()][0].authorId,memberId('author'));
 assert.equal((await f.call('publishComment',{...data,content:'🙂'.repeat(501)})).code,'INVALID_INPUT');assert.equal((await f.call('publishComment',{...data,content:'不同内容'})).code,'REQUEST_CONFLICT');
});
test('pending comments are private, human approval cannot bypass risky verdict',async()=>{
 const f=fixture(),p=f.post();f.suggest('review');const c=await f.call('publishComment',{postId:p._id,content:'待审内容',requestId:'comment-request-1'});assert.equal(c.status,'pending');assert.equal((await f.call('listComments',{postId:p._id},'other')).comments.length,0);assert.equal((await f.call('listComments',{postId:p._id})).comments.length,1);f.suggest('risky');assert.equal((await f.call('reviewComment',{commentId:c.commentId,revision:1,decision:'approve',reason:'内容核实无误'},'admin')).code,'CONTENT_REJECTED');
 f.suggest('pass');assert.equal((await f.call('reviewComment',{commentId:c.commentId,revision:1,decision:'approve',reason:'内容核实无误'},'admin')).status,'published');
});
test('deleted comment remains an empty placeholder while replies remain',async()=>{
 const f=fixture(),p=f.post();const one=await f.call('publishComment',{postId:p._id,content:'原始评论',requestId:'comment-request-1'});await f.call('publishComment',{postId:p._id,content:'后续回复',replyTo:one.commentId,requestId:'comment-request-2'},'other');
 assert.equal((await f.call('deleteComment',{commentId:one.commentId,revision:1},'other')).code,'FORBIDDEN');assert.equal((await f.call('deleteComment',{commentId:one.commentId,revision:1})).status,'deleted');const list=await f.call('listComments',{postId:p._id},'other');assert.equal(list.comments.length,2);assert.equal(list.comments.find(c=>c._id===one.commentId).content,'');assert.equal(list.comments.find(c=>c.replyTo).replyToName,'已删除');
});
test('deleted post with comments exposes only a tombstone and refuses interaction',async()=>{
 const f=fixture(),p=f.post();await f.call('publishComment',{postId:p._id,content:'保留评论',requestId:'comment-request-1'});await f.call('deletePost',{postId:p._id,revision:1});const view=await f.call('getPost',{postId:p._id},'other');assert.equal(view.post.title,'');assert.equal(view.post.content,'');assert.deepEqual(view.post.mediaIds,[]);assert.equal((await f.call('setLiked',{postId:p._id,liked:true},'other')).code,'POST_UNAVAILABLE');assert.equal((await f.call('publishComment',{postId:p._id,content:'新评论',requestId:'comment-request-2'},'other')).code,'POST_UNAVAILABLE');
});
test('explicit concurrent like state counts once and cancellation never goes negative',async()=>{
 const f=fixture(),p=f.post();const results=await Promise.all(Array.from({length:20},()=>f.call('setLiked',{postId:p._id,liked:true},'other')));assert.ok(results.every(x=>x.likeCount===1));assert.equal((await f.call('setLiked',{postId:p._id,liked:true})).likeCount,2);await Promise.all(Array.from({length:20},()=>f.call('setLiked',{postId:p._id,liked:false},'other')));assert.equal((await f.call('getLikeState',{postId:p._id},'other')).likeCount,1);assert.equal((await f.call('setLiked',{postId:p._id,liked:false})).likeCount,0);assert.equal((await f.call('setLiked',{postId:p._id,liked:false})).likeCount,0);
});
test('sanctions require administrator, confirmation and current member version',async()=>{
 const f=fixture();const data={memberId:memberId('author'),revision:1,decision:'mute',reason:'社区规则核实',confirmed:true};assert.equal((await f.call('setMemberSanction',data)).code,'FORBIDDEN');assert.equal((await f.call('setMemberSanction',{...data,confirmed:false},'admin')).code,'CONFIRM_REQUIRED');assert.equal((await f.call('setMemberSanction',data,'admin')).member.mutedUntil,f.time()+7*86400000);assert.equal((await f.call('publish',payload())).code,'ACCOUNT_MUTED');assert.equal((await f.call('list')).ok,true);assert.equal((await f.call('setMemberSanction',data,'admin')).code,'CONFLICT');f.advance(7*86400000);assert.equal((await f.call('publish',payload())).ok,true);
 assert.equal((await f.call('setMemberSanction',{...data,memberId:memberId('admin')},'admin')).code,'FORBIDDEN');
});
test('revocation during moderation and audit failures roll back new comment and edits',async()=>{
 const f=fixture(),p=f.post();f.hook(()=>{f.repo.tables.members.get(memberId('author')).status='revoked';});assert.equal((await f.call('publishComment',{postId:p._id,content:'测试评论',requestId:'comment-request-1'})).code,'ACCESS_DENIED');assert.equal(f.repo.tables.comments.size,0);f.repo.tables.members.get(memberId('author')).status='approved';f.repo.failType='audit';assert.equal((await f.call('setMemberSanction',{memberId:memberId('author'),revision:1,decision:'ban',reason:'核实处理原因',confirmed:true},'admin')).code,'SERVICE_UNAVAILABLE');assert.equal(f.repo.tables.members.get(memberId('author')).banned,undefined);
});



test('deleting a previously private comment does not make its existence public',async()=>{
 const f=fixture(),p=f.post();f.suggest('review');const c=await f.call('publishComment',{postId:p._id,content:'私有审核评论',requestId:'comment-private-delete'});assert.equal(c.status,'pending');await f.call('deleteComment',{commentId:c.commentId,revision:1});assert.equal((await f.call('listComments',{postId:p._id},'other')).comments.length,0);assert.equal((await f.call('listComments',{postId:p._id})).comments.length,1);
});

test('a risky original comment recheck commits terminal rejection even after a safe reason check',async()=>{
 const f=fixture(),p=f.post();f.suggest('review');const c=await f.call('publishComment',{postId:p._id,content:'待核对评论',requestId:'comment-recheck-risky'});f.sequence(['pass','risky']);assert.equal((await f.call('reviewComment',{commentId:c.commentId,revision:1,decision:'approve',reason:'已核对评论内容'},'admin')).code,'CONTENT_REJECTED');assert.equal((await f.repo.get('comments',c.commentId)).status,'rejected');f.suggest('pass');assert.equal((await f.call('reviewComment',{commentId:c.commentId,revision:2,decision:'approve',reason:'尝试恢复评论'},'admin')).code,'CONFLICT');assert.equal((await f.call('listComments',{postId:p._id},'other')).comments.length,0);
});
test('search covers ten thousand isolated records with stable pages',async()=>{
 const f=fixture();for(let i=0;i<10000;i++)f.post(i,{title:i===9999?'独立中文检索验证':'普通校园记录',content:'只用于隔离测试',createdAt:f.time()-i});const r=await f.call('searchPosts',{query:'独立中文检索验证'});assert.equal(r.ok,true);assert.equal(r.posts.length,1);assert.equal(r.posts[0]._id,hash('post-9999'));
});
test('community ban prevents new interaction while member session remains available',async()=>{
 const f=fixture(),p=f.post();const sanction=await f.call('setMemberSanction',{memberId:memberId('author'),revision:1,decision:'ban',reason:'人工核实违规情况',confirmed:true},'admin');assert.equal(sanction.member.banned,true);assert.equal((await f.call('session')).member.banned,true);assert.equal((await f.call('publish',payload())).code,'ACCOUNT_BANNED');assert.equal((await f.call('publishComment',{postId:p._id,content:'新的评论',requestId:'comment-banned-new'})).code,'ACCOUNT_BANNED');assert.equal((await f.call('setLiked',{postId:p._id,liked:true})).code,'ACCOUNT_BANNED');assert.equal((await f.call('setMemberSanction',{memberId:memberId('author'),revision:2,decision:'clear',reason:'复核后解除限制',confirmed:true},'admin')).member.banned,false);
});

test('delete post tombstone remains accessible after its last public comment is deleted', async () => {
  const f=fixture(), p=f.post();const c=await f.call('publishComment',{postId:p._id,content:'此前公开的评论',requestId:'tombstone-history-comment'});
  await f.call('deleteComment',{commentId:c.commentId,revision:1});assert.equal((await f.repo.get('posts',p._id)).commentCount,0);
  await f.call('deletePost',{postId:p._id,revision:1});const r=await f.call('getPost',{postId:p._id},'other');
  assert.equal(r.ok,true);assert.equal(r.post.title,'');assert.equal(r.post.content,'');
});

test('moderation transport error cannot masquerade as a safe text result', async () => {
  const f=fixture({moderate:async()=>({errcode:87014,result:{suggest:'pass'}})});
  assert.equal((await f.call('publish',payload())).code,'MODERATION_UNAVAILABLE');assert.equal(f.repo.tables.posts.size,0);
});

test('post presets survive publication and editing without exposing anonymous identity', async () => {
  const f = fixture();
  const original = payload(90, { avatarId: 'avatar-2', coverId: 'cover-3' });
  const created = await f.call('publish', original);
  assert.equal(created.status, 'published');
  assert.equal((await f.call('publish', original)).postId, created.postId);
  assert.equal((await f.call('publish', { ...original, coverId: 'cover-4' })).code, 'REQUEST_CONFLICT');
  const visible = (await f.call('getPost', { postId: created.postId }, 'other')).post;
  assert.equal(visible.avatarId, 'avatar-2');
  assert.equal(visible.coverId, 'cover-3');
  const edited = await f.call('editPost', {
    ...payload(91), postId: created.postId, revision: 1, coverId: ''
  });
  assert.equal(edited.ok, true);
  const next = (await f.call('getPost', { postId: created.postId })).post;
  assert.equal(next.avatarId, 'avatar-2');
  assert.equal(next.coverId, undefined);

  const anonymous = await f.call('publish', payload(92, { avatarId: 'avatar-5', isAnonymous: true }));
  const anonymousView = (await f.call('getPost', { postId: anonymous.postId })).post;
  assert.equal(anonymousView.avatarId, 'anonymous');
  assert.equal((await f.repo.get('posts', anonymous.postId)).avatarId, undefined);
  assert.equal((await f.call('publish', payload(93, { avatarId: 'official' }))).code, 'INVALID_INPUT');
  assert.equal((await f.call('publish', payload(94, { coverId: '/remote.jpg' }))).code, 'INVALID_INPUT');

  const legacyOfficial = f.post(95, { authorId: memberId('admin') });
  const officialView = (await f.call('getPost', { postId: legacyOfficial._id }, 'other')).post;
  assert.equal(officialView.avatarId, 'official');
});

test('forum quote resolves only readable source content and never exposes an anonymous author', async () => {
  const f = fixture();
  const source = f.post(95, { isAnonymous: true });
  const result = await f.call('publish', payload(96, { quotePostId: source._id }), 'other');
  assert.equal(result.status, 'published');
  const before = (await f.call('getPost', { postId: result.postId })).post.quote;
  assert.equal(before.title, source.title);
  assert.equal(before.authorName, '匿名同学');
  f.repo.tables.posts.get(source._id).status = 'hidden';
  assert.deepEqual((await f.call('getPost', { postId: result.postId })).post.quote, { unavailable: true });
  assert.equal((await f.call('publish', payload(97, { quotePostId: source._id }), 'other')).code, 'POST_UNAVAILABLE');
});

test('comment avatars preserve selected presets and redact anonymous authors', async () => {
  const f = fixture();
  const source = f.post(98, { isAnonymous: true, avatarId: 'avatar-4' });
  const add = (who, avatarId) => f.call('publishComment', {
    postId: source._id, content: '谢谢分享。', requestId: 'comment-avatar-' + who, avatarId
  }, who);
  assert.equal((await add('author', 'avatar-4')).ok, true);
  assert.equal((await add('other', 'avatar-7')).ok, true);
  assert.equal((await add('admin', 'avatar-2')).ok, true);
  const { comments } = await f.call('listComments', { postId: source._id });
  assert.equal(comments.find(row => row.isPostAuthor).avatarId, 'anonymous');
  assert.equal(comments.find(row => row.authorName === '真实昵称-other').avatarId, 'avatar-7');
  assert.equal(comments.find(row => row.authorName === '真实昵称-admin').avatarId, 'official');
});

test('discovery uses Shanghai calendar days and excludes unavailable and cross-community posts', async () => {
  const f = fixture();
  const midnight = Date.parse('2026-11-14T00:00:00+08:00');
  f.advance(midnight + 1000 - f.time());
  f.post(81, { title: '图书馆自习', createdAt: midnight - 1, likeCount: 100 });
  f.post(82, { title: '今天来图书馆', createdAt: midnight + 1 });
  f.post(83, { title: '准备备考', createdAt: midnight + 2, commentCount: 4 });
  f.post(84, { title: '校内实习', createdAt: midnight + 3, status: 'pending' });
  f.post(85, { title: '申研', createdAt: midnight + 4, community: 'experience' });

  const discovery = await f.call('searchDiscovery');
  assert.equal(discovery.ok, true);
  assert.deepEqual(discovery.trends, [{ query: '期末复习', count: 1 }, { query: '图书馆', count: 1 }]);
  assert.equal(discovery.recommendations.length, 3);
  assert.equal(discovery.recommendations.some(post => post.authorId || post.content), false);
  const trendSearch = await f.call('searchPosts', { query: '期末复习', timeRange: 'today' });
  assert.deepEqual(trendSearch.posts.map(post => post.title), ['准备备考']);
});

test('发帖工具保存贴纸和投票，回复与引用范围由服务端检查', async () => {
  const { call } = fixture();
  const draft = { title: '下周见面', content: '选个地点', category: '校园生活墙', requestId: 'composer-poll-001',
    stickerId: 30, poll: ['图书馆', '教学楼'], location: '校内', replyScope: 'author' };
  const published = await call('publish', draft);
  assert.equal(published.ok, true);
  const postId = published.postId;
  const { post } = await call('getPost', { postId }, 'other');
  assert.equal(post.stickerId, 30);
  assert.equal(post.location, '校内');
  assert.equal(post.canReply, false);
  assert.deepEqual((await call('votePost', { postId, choice: 1, option: '教学楼' }, 'other')).counts, [0, 1]);
  assert.deepEqual((await call('votePost', { postId, choice: 0, option: '图书馆' }, 'other')).counts, [0, 1]);
  assert.equal((await call('getPost', { postId }, 'other')).post.poll.choice, 1);
  assert.equal((await call('publishComment', { postId, content: '收到', requestId: 'composer-reply-001' }, 'other')).code, 'REPLIES_RESTRICTED');
  assert.equal((await call('publish', { ...draft, quotePostId: postId, requestId: 'composer-quote-001' }, 'other')).code, 'POST_UNAVAILABLE');
});

test('发帖者仅能审批已通过安全审核且标记为作者审批的回复', async () => {
  const { call } = fixture();
  const p = await call('publish', { title: '话题', content: '交流', category: '校园生活墙', requestId: 'composer-review-001', reviewReplies: true });
  const c = await call('publishComment', { postId: p.postId, content: '你好', requestId: 'composer-comment-001' }, 'other');
  assert.equal(c.status, 'pending');
  const rows = await call('listComments', { postId: p.postId });
  assert.equal(rows.comments[0].canReview, true);
  const review = { commentId: c.commentId, revision: 1, decision: 'approve', reason: '作者通过' };
  assert.equal((await call('reviewComment', review, 'other')).code, 'FORBIDDEN');
  assert.equal((await call('reviewComment', review)).status, 'published');
});
