'use strict';
const { readPresets, checkImageCount } = require('./post-presets');
const search = require('./search-core');
const { discover, startOfToday, topicPattern } = require('./search-discovery');
const { replacePostMediaReferences } = require('./media-lifecycle');
const EDIT_WINDOW = 30 * 60 * 1000;
const MUTE_WINDOW = 7 * 24 * 60 * 60 * 1000;
function createForumService(deps) {
  const { repo, moderation, now, hash, id, text, revision, approved, admin, verifyRevision, fail, encodeCursor, decodeCursor, publicPost, appendAudit } = deps;
  const community = value => { if (value !== undefined && !['forum', 'experience'].includes(value)) fail('INVALID_INPUT', '请选择有效的社区。'); return value || 'forum'; };
  function active(member, write = false) {
    approved(member);
    if (member.banned) fail('ACCOUNT_BANNED', '账号已被限制新社区活动，已有订单及售后请从交易记录进入。');
    if (write && member.mutedUntil > now()) fail('ACCOUNT_MUTED', '账号暂时不能发帖、编辑或评论，可继续阅读和举报。');
    return member;
  }
  function request(value) { if (typeof value !== 'string' || !/^[a-z0-9-]{10,64}$/.test(value)) fail('INVALID_INPUT', '请求标识无效，请重试。'); return value; }
  async function scan(type, where) {
    const rows = []; let cursor = null; const start = Date.now();
    do {
      const batch = await repo.query(type, { where, cursor, limit: 100 });
      rows.push(...batch);
      if (batch.length < 100) return rows;
      const last = batch[batch.length - 1];
      if (cursor && last._id === cursor._id && last.createdAt === cursor.createdAt) fail('SEARCH_UNAVAILABLE', '检索服务暂不可用，请稍后重试。');
      cursor = { createdAt: last.createdAt, _id: last._id };
      if (Date.now() - start > 12000) fail('SEARCH_UNAVAILABLE', '完整检索用时较长，请稍后重试；未返回截断结果。');
    } while (true);
  }
  async function searchPosts(event, member) {
    active(member); const space = community(event.community);
    if (event.category && !search.CATEGORIES.includes(event.category)) fail('INVALID_INPUT', '请选择有效的论坛分类。');
    const range = event.timeRange || 'all';
    if (!['all', '7d', '30d', 'today'].includes(range)) fail('INVALID_INPUT', '时间范围无效。');
    const query = search.normalize(text(event.query === undefined ? event.keyword : event.query, 60, '关键词'));
    let words;
    try { words = search.tokenize(query); } catch (_) { fail('SEARCH_UNAVAILABLE', '当前云环境暂不支持中文检索，请稍后重试。'); }
    if (!words.length) fail('INVALID_INPUT', '请输入中文词语、字母或数字。');
    let anchor = now();
    const scope = hash(JSON.stringify([query, event.category || '', range, space, search.TOKENIZER_VERSION]));
    let cursor = null;
    if (event.cursor) {
      try {
        if (typeof event.cursor !== 'string' || event.cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(event.cursor)) throw Error();
        cursor = JSON.parse(Buffer.from(event.cursor, 'base64url').toString());
        if (cursor.scope !== scope || !Number.isSafeInteger(cursor.t) || !Number.isSafeInteger(cursor.score) || !Number.isSafeInteger(cursor.anchor) || cursor.anchor > now() || !/^[a-f0-9]{32}$/.test(cursor.i)) throw Error();
      } catch (_) { fail('INVALID_CURSOR', '搜索位置无效，请重新搜索。'); }
      anchor = cursor.anchor;
    }
    const where = { kind: 'post', status: 'published' };
    // Legacy and unknown categories are normalized to the campus life wall.
    if (event.category && event.category !== search.category(undefined)) where.category = event.category;
    const candidates = await scan('posts', where);
    const all = [];
    for (const post of candidates) {
      if ((post.community || 'forum') === space &&
          (!event.category || search.category(post.category) === event.category) &&
          await deps.isPublicSafe(post)) all.push(post);
    }
    const rev = search.fingerprint(all);
    if (cursor && cursor.rev !== rev) fail('CURSOR_EXPIRED', '公开内容已更新，请保留当前结果并点击刷新。');
    const cutoff = range === 'today' ? startOfToday(anchor) : range === 'all' ? 0 : anchor - (range === '7d' ? 7 : 30) * 86400000;
    const trendPattern = range === 'today' ? topicPattern(query) : undefined;
    const rows = all.filter(p => p.createdAt >= cutoff && (!trendPattern || trendPattern.test(search.normalize(p.title || ''))))
      .map(p => ({ post: p, score: search.score(p, query, words) || (trendPattern ? 1 : 0) })).filter(p => p.score > 0)
      .sort((a, b) => b.score - a.score || b.post.createdAt - a.post.createdAt || b.post._id.localeCompare(a.post._id))
      .filter(p => !cursor || p.score < cursor.score || (p.score === cursor.score && (p.post.createdAt < cursor.t || (p.post.createdAt === cursor.t && p.post._id < cursor.i))));
    const page = rows.slice(0, 20); const hasMore = rows.length > 20; const last = page[page.length - 1];
    return { posts: page.map(({ post, score }) => ({ ...publicPost(post, member), score, summary: search.excerpt(post.content, query), highlights: words })), hasMore,
      nextCursor: hasMore ? Buffer.from(JSON.stringify({ scope, rev, anchor, score: last.score, t: last.post.createdAt, i: last.post._id })).toString('base64url') : null,
      tokenizerVersion: search.TOKENIZER_VERSION, query, revision: rev };
  }
  async function list(event, member) {
    active(member); const space = community(event.community);
    if (event.category && !search.CATEGORIES.includes(event.category)) fail('INVALID_INPUT', '请选择有效的论坛分类。');
    if (event.recommendedOnly !== undefined && typeof event.recommendedOnly !== 'boolean') fail('INVALID_INPUT', '推荐筛选无效。');
    const recommendedOnly = event.recommendedOnly === true;
    if (recommendedOnly && space !== 'experience') fail('INVALID_INPUT', '管理员推荐仅用于经验社区。');
    const scope = `list:${space}:${event.category || ''}${recommendedOnly ? ':recommended' : ''}`;
    let cursor = decodeCursor(event.cursor, scope); const rows = [];
    // Scan until a complete page is found. Legacy rows are filtered after reading,
    // so a category with few rows cannot disappear behind another category's page.
    while (rows.length < 21) {
      const batch = await repo.query('posts', { where: { kind: 'post', status: 'published' }, cursor, limit: 100 });
      for (const p of batch) {
        cursor = { createdAt: p.createdAt, _id: p._id };
        if ((p.community || 'forum') === space && (!event.category || search.category(p.category) === event.category) && (!recommendedOnly || (p.recommended === true && p.moderation === 'pass')) && await deps.isPublicSafe(p)) rows.push(p);
        if (rows.length === 21) break;
      }
      if (rows.length === 21 || batch.length < 100) break;
    }
    const hasMore = rows.length > 20, page = rows.slice(0, 20);
    const posts = await Promise.all(page.map(async post => ({
      ...publicPost(post, member),
      ...(post.quotePostId && deps.attachQuote ? { quote: await deps.attachQuote(post) } : {})
    })));
    if (event.includeLikeState === true) {
      await Promise.all(posts.map(async post => {
        post.liked = !!(await repo.get('likes', hash(`${member._id}:like:${post._id}`)))?.liked;
      }));
    }
    return { posts, hasMore, nextCursor: hasMore ? encodeCursor(page[page.length - 1], scope) : null };
  }
  async function editPost(event, openid, ownId) {
    const postId = id(event.postId), expected = revision(event.revision), requestId = request(event.requestId);
    const category = event.category;
    if (!search.CATEGORIES.includes(category)) fail('INVALID_INPUT', '请选择有效的论坛分类。');
    const title = text(event.title, 60, '标题'), content = text(event.content, 2000, '正文');
    const mediaIds = await deps.validateMedia(event.mediaIds, ownId);
    const presets = readPresets(event, fail);
    const payloadHash = hash(JSON.stringify([postId, category, title, content, mediaIds, ...(Object.keys(presets).length ? [presets] : [])]));
    const operationId = hash(`${ownId}:edit:${postId}:${requestId}`);
    const existing = await repo.get('mutations', operationId);
    if (existing) { if (existing.payloadHash !== payloadHash) fail('REQUEST_CONFLICT', '同一请求内容已改变，请重新提交。'); return existing.result; }
    const before = await repo.get('posts', postId);
    if (!before || before.authorId !== ownId) fail('FORBIDDEN', '只能编辑自己的帖子。');
    checkImageCount(presets.coverId ?? before.coverId, mediaIds, fail);
    if (before.status === 'deleted' || before.status === 'hidden') fail('POST_UNAVAILABLE', '当前帖子不能编辑。');
    if (now() >= before.createdAt + EDIT_WINDOW) fail('EDIT_WINDOW_EXPIRED', '首次提交已满30分钟，不能再编辑。');
    if (event.isAnonymous !== undefined && event.isAnonymous !== !!before.isAnonymous) fail('ANONYMOUS_LOCKED', '首次提交后不能更改匿名模式。');
    verifyRevision(before, expected);
    active(await repo.get('members', ownId), true);
    const checked = await moderation(openid, [title, content, presets.location ?? before.location, ...(presets.poll === undefined ? before.poll || [] : presets.poll || [])].filter(Boolean).join('\n'));
    const at = now();
    return repo.transaction(async tx => {
      active(await tx.get('members', ownId), true);
      const prior = await tx.get('mutations', operationId);
      if (prior) { if (prior.payloadHash !== payloadHash) fail('REQUEST_CONFLICT', '请求内容发生变化。'); return prior.result; }
      const post = await tx.get('posts', postId);
      if (!post || post.authorId !== ownId || ['deleted', 'hidden'].includes(post.status)) fail('POST_UNAVAILABLE', '当前帖子不能编辑。');
      verifyRevision(post, expected);
      if (at >= post.createdAt + EDIT_WINDOW) fail('EDIT_WINDOW_EXPIRED', '首次提交已满30分钟，不能再编辑。');
      await deps.validateMedia(mediaIds, ownId, tx);
      if (presets.poll !== undefined && JSON.stringify(presets.poll) !== JSON.stringify(post.poll || null) && post.pollCounts?.some(Boolean)) {
        fail('CONFLICT', '已有投票的选项不能修改。');
      }
      const businessReview = deps.businessTerms.some(word => [title, content, presets.location ?? post.location, ...(presets.poll === undefined ? post.poll || [] : presets.poll || [])].some(value => value?.includes(word)));
      const status = post.isAnonymous || checked.suggestion !== 'pass' || businessReview ? 'pending' : 'published';
      const updated = { ...post, ...presets, ...(post.isAnonymous ? { avatarId: '' } : {}), title, content, category, mediaIds, status, recommended: false, recommendedAt: null, moderation: checked.suggestion, moderationTraceId: checked.traceId, businessReview, reviewReason: '', updatedAt: at, revision: post.revision + 1, searchVersion: search.TOKENIZER_VERSION, searchFields: search.fields({ title, content }) };
      await replacePostMediaReferences(tx, { postId, before: post.mediaIds || [], after: mediaIds, at });
      await tx.set('posts', postId, updated);
      const result = { postId, status, revision: updated.revision };
      await tx.set('mutations', operationId, { kind: 'mutation', actorId: ownId, payloadHash, result, createdAt: at });
      await appendAudit(tx, { actor: ownId, target: postId, action: 'editPost', from: post.status, to: status, at, revision: updated.revision });
      return result;
    });
  }
  function commentProjection(comment, post, viewer, names) {
    const anonymous = post.isAnonymous && comment.authorId === post.authorId;
    return { _id: comment._id, canReview: !!(comment.authorReview && comment.status === 'pending' && post.authorId === viewer._id), postId: post._id, content: comment.status === 'deleted' ? '' : comment.content, status: comment.status,
      authorName: comment.status === 'deleted' ? '已删除' : anonymous ? '匿名楼主' : comment.authorName,
      ...(comment.status === 'deleted' ? {} : {
        avatarId: anonymous ? 'anonymous' : viewer.officialAuthorId === comment.authorId ? 'official'
          : comment.avatarId || (comment.authorId === post.authorId ? post.avatarId : '') || 'avatar-1'
      }),
      replyTo: comment.replyTo || '', replyToName: comment.replyTo ? names.get(comment.replyTo) || '已删除' : '',
      isOwner: comment.authorId === viewer._id, isPostAuthor: comment.authorId === post.authorId, createdAt: comment.createdAt, updatedAt: comment.updatedAt, revision: comment.revision,
      ...((comment.authorId === viewer._id || viewer.role === 'admin') && comment.reviewReason ? { reviewReason: comment.reviewReason } : {}) };
  }
  async function listComments(event, member) {
    active(member); const post = await repo.get('posts', id(event.postId));
    if (!post || (post.status !== 'published' && post.status !== 'deleted' && post.authorId !== member._id && member.role !== 'admin')) fail('NOT_FOUND', '帖子不存在或已不可查看。');
    if (post.status === 'published' && !(await deps.isPublicSafe(post))) fail('POST_UNAVAILABLE', '图片审核结果变化，帖子暂停展示。');
    const scope = `comments:${post._id}:${member._id}`;
    let cursor = decodeCursor(event.cursor, scope); const rows = [];
    while (rows.length < 21) {
      const batch = await repo.query('comments', { where: { kind: 'comment', postId: post._id }, cursor, limit: 100 });
      for (const c of batch) {
        cursor = { createdAt: c.createdAt, _id: c._id };
        if ((c.authorReview && member._id === post.authorId && c.status === 'pending') || c.status === 'published' || (c.status === 'deleted' && c.wasPublic !== false) || c.authorId === member._id || member.role === 'admin') rows.push(c);
        if (rows.length === 21) break;
      }
      if (rows.length === 21 || batch.length < 100) break;
    }
    const page = rows.slice(0, 20); const names = new Map();
    for (const c of page) if (c.replyTo) {
      const parent = await repo.get('comments', c.replyTo);
      if (parent && parent.postId === post._id && (['published','deleted'].includes(parent.status) || parent.authorId === member._id || member.role === 'admin')) names.set(c.replyTo, parent.status === 'deleted' ? '已删除' : post.isAnonymous && parent.authorId === post.authorId ? '匿名楼主' : parent.authorName);
    }
    return { comments: page.map(c => commentProjection(c, post, member, names)), hasMore: rows.length > 20, nextCursor: rows.length > 20 ? encodeCursor(page[page.length - 1], scope) : null };
  }
  async function publishComment(event, openid, ownId) {
    const postId = id(event.postId), content = text(event.content, 500, '评论'), req = request(event.requestId);
    const replyTo = event.replyTo ? id(event.replyTo, '评论') : '';
    const { avatarId } = readPresets({ avatarId: event.avatarId }, fail);
    const commentId = hash(`${ownId}:comment:${req}`), payloadHash = hash(JSON.stringify([postId, content, replyTo, ...(avatarId ? [avatarId] : [])]));
    function repeat(c) { if (c.payloadHash !== payloadHash) fail('REQUEST_CONFLICT', '同一请求的评论内容发生变化。'); return { commentId, status: c.status, revision: c.revision }; }
    const exists = await repo.get('comments', commentId); if (exists) return repeat(exists);
    const before = await repo.get('posts', postId); if (!before || before.status !== 'published') fail('POST_UNAVAILABLE', '帖子当前不能评论。');
    if (before.replyScope === 'author' && before.authorId !== ownId) fail('REPLIES_RESTRICTED', '此帖仅作者可以回复。');
    active(await repo.get('members', ownId), true);
    const checked = await moderation(openid, content), at = now();
    return repo.transaction(async tx => {
      const actor = active(await tx.get('members', ownId), true);
      const old = await tx.get('comments', commentId); if (old) return repeat(old);
      const post = await tx.get('posts', postId); if (!post || post.status !== 'published') fail('POST_UNAVAILABLE', '帖子当前不能评论。');
      if (post.replyScope === 'author' && post.authorId !== ownId) fail('REPLIES_RESTRICTED', '此帖仅作者可以回复。');
      if (replyTo) { const parent = await tx.get('comments', replyTo); if (!parent || parent.postId !== postId || parent.status !== 'published') fail('COMMENT_UNAVAILABLE', '被回复的评论已不可回复。'); }
      const authorReview = post.reviewReplies === true && post.authorId !== ownId && checked.suggestion === 'pass' && !deps.businessTerms.some(word => content.includes(word));
      const status = !authorReview && checked.suggestion === 'pass' && !deps.businessTerms.some(word => content.includes(word)) ? 'published' : 'pending';
      await tx.set('comments', commentId, { kind: 'comment', postId, authorId: ownId, authorName: actor.nickname, ...(avatarId && !(post.isAnonymous && post.authorId === ownId) ? { avatarId } : {}), content, replyTo, status, ...(authorReview ? { authorReview: true } : {}), payloadHash, moderation: checked.suggestion, moderationTraceId: checked.traceId, revision: 1, createdAt: at, updatedAt: at });
      await tx.set('posts', postId, { ...post, hasCommentHistory: post.hasCommentHistory || status === 'published', commentCount: (post.commentCount || 0) + (status === 'published' ? 1 : 0) });
      await appendAudit(tx, { actor: ownId, target: commentId, action: 'publishComment', from: 'none', to: status, at, revision: 1 });
      return { commentId, status, revision: 1 };
    });
  }
  async function mutateComment(event, openid, ownId, action) {
    const commentId = id(event.commentId, '评论'), expected = revision(event.revision);
    const reason = action === 'reviewComment' ? text(event.reason, 200, '处理说明', 2) : '';
    if (action === 'reviewComment' && !['approve', 'reject', 'hide'].includes(event.decision)) fail('INVALID_INPUT', '请选择有效处理。');
    const before = await repo.get('comments', commentId);
    if (!before) fail('NOT_FOUND', '评论不存在。');
    let checked;
    if (action === 'reviewComment') {
      const member = approved(await repo.get('members', ownId));
      if (member.role !== 'admin') {
        active(member, true);
        const post = await repo.get('posts', before.postId);
        if (!before.authorReview || before.status !== 'pending' || post?.authorId !== ownId || event.decision === 'hide') fail('FORBIDDEN', '无权处理此回复。');
      }
      const reasonCheck = await moderation(openid, reason); if (reasonCheck.suggestion !== 'pass') fail('MODERATION_UNAVAILABLE', '处理说明需通过审核。');
      if (event.decision === 'approve') { const author = await repo.get('members', before.authorId); if (!author || !author.openid) fail('AUTHOR_UNAVAILABLE', '作者身份暂不可核对。'); checked = await moderation(author.openid, before.content, { captureRisky: true }); if (checked.suggestion === 'review') fail('POST_REVIEW_REQUIRED', '微信仍要求复核，暂不能公开。'); }
    }
    const result = await repo.transaction(async tx => {
      const actor = approved(await tx.get('members', ownId));
      const c = await tx.get('comments', commentId); if (!c) fail('NOT_FOUND', '评论不存在。');
      if (action === 'deleteComment' && c.authorId !== ownId) fail('FORBIDDEN', '只能删除自己的评论。');
      if (action === 'deleteComment' && c.status === 'deleted') return { commentId, status: c.status, revision: c.revision };
      verifyRevision(c, expected);
      const post = await tx.get('posts', c.postId); if (!post) fail('POST_UNAVAILABLE', '帖子已不可查看。');
      if (action === 'reviewComment' && actor.role !== 'admin') {
        active(actor, true);
        if (!c.authorReview || c.status !== 'pending' || post.authorId !== ownId || event.decision === 'hide') fail('FORBIDDEN', '无权处理此回复。');
      }
      if (action === 'reviewComment' && (event.decision === 'hide' ? c.status !== 'published' : c.status !== 'pending')) fail('CONFLICT', '评论已被处理。');
      if (event.decision === 'approve' && post.status !== 'published') fail('POST_UNAVAILABLE', '帖子已不可公开，评论不能恢复。');
      const status = action === 'deleteComment' ? 'deleted' : event.decision === 'hide' ? 'hidden' : event.decision === 'reject' || checked?.suggestion === 'risky' ? 'rejected' : 'published';
      const at = now(); const updated = { ...c, ...(status === 'deleted' ? { wasPublic: c.status === 'published' || c.wasPublic === true } : {}), content: status === 'deleted' ? '' : c.content, status, reviewReason: reason, revision: c.revision + 1, updatedAt: at, ...(checked ? { moderation: checked.suggestion, moderationTraceId: checked.traceId } : {}) };
      await tx.set('comments', commentId, updated);
      const delta = (status === 'published' ? 1 : 0) - (c.status === 'published' ? 1 : 0);
      if (delta) await tx.set('posts', post._id, { ...post, hasCommentHistory: post.hasCommentHistory || c.status === 'published' || status === 'published', commentCount: Math.max(0, (post.commentCount || 0) + delta) });
      await appendAudit(tx, { actor: ownId, target: commentId, action, from: c.status, to: status, at, revision: updated.revision });
      return { commentId, status, revision: updated.revision };
    });
    if (checked?.suggestion === 'risky') fail('CONTENT_REJECTED', '微信拒绝内容不能恢复公开。');
    return result;
  }
  async function reviewComments(event, member) {
    admin(member); const status = event.status || 'pending';
    if (!['pending', 'published'].includes(status)) fail('INVALID_INPUT', '评论状态无效。');
    const scope = `reviewComments:${status}`;
    const rows = await repo.query('comments', { where: { kind: 'comment', status }, cursor: decodeCursor(event.cursor, scope), limit: 21 });
    const comments = [];
    for (const c of rows.slice(0,20)) { const p = await repo.get('posts', c.postId); if (p) comments.push(commentProjection(c, p, member, new Map())); }
    return { comments, hasMore: rows.length > 20, nextCursor: rows.length > 20 ? encodeCursor(rows[19], scope) : null };
  }
  async function votePost(event, ownId) {
    const postId = id(event.postId), choice = event.choice;
    const key = hash(`${ownId}:poll:${postId}`);
    return repo.transaction(async tx => {
      active(await tx.get('members', ownId), true);
      const post = await tx.get('posts', postId);
      if (!post || post.status !== 'published' || !post.poll?.length || !(await deps.isPublicSafe(post, tx))) {
        fail('POST_UNAVAILABLE', '投票已关闭。');
      }
      if (!Number.isInteger(choice) || choice < 0 || choice >= post.poll.length || event.option !== post.poll[choice]) fail('INVALID_INPUT', '投票选项已更新。');
      const existing = await tx.get('likes', key);
      if (existing) return { options: post.poll, counts: post.pollCounts, choice: existing.choice };
      const counts = post.pollCounts ? [...post.pollCounts] : post.poll.map(() => 0);
      counts[choice] += 1;
      await tx.set('likes', key, { kind: 'pollVote', postId, choice, createdAt: now() });
      await tx.set('posts', postId, { ...post, pollCounts: counts });
      return { options: post.poll, counts, choice };
    });
  }
  async function setLiked(event, ownId) {
    const postId = id(event.postId); if (typeof event.liked !== 'boolean') fail('INVALID_INPUT', '点赞状态无效。');
    const key = hash(`${ownId}:like:${postId}`);
    return repo.transaction(async tx => {
      active(await tx.get('members', ownId));
      const post = await tx.get('posts', postId); if (!post || post.status !== 'published') fail('POST_UNAVAILABLE', '帖子当前不能互动。');
      const current = await tx.get('likes', key); const liked = !!current?.liked;
      const count = Math.max(0, (post.likeCount || 0) + (event.liked ? 1 : 0) - (liked ? 1 : 0));
      if (event.liked !== liked) { await tx.set('likes', key, { kind: 'like', postId, actorId: ownId, liked: event.liked, createdAt: current?.createdAt || now(), updatedAt: now() }); await tx.set('posts', postId, { ...post, likeCount: count }); }
      return { postId, liked: event.liked, likeCount: count };
    });
  }
  async function getLikeState(event, ownId) {
    const post = await repo.get('posts', id(event.postId)); if (!post || post.status !== 'published') fail('POST_UNAVAILABLE', '帖子当前不可互动。');
    return { liked: !!(await repo.get('likes', hash(`${ownId}:like:${post._id}`)))?.liked, likeCount: post.likeCount || 0 };
  }
  async function setMemberSanction(event, openid, ownId) {
    const targetId = id(event.memberId, '成员'), expected = revision(event.revision), reason = text(event.reason, 200, '处理原因', 2);
    const decision = event.decision || event.sanction;
    if (!['mute', 'ban', 'clear'].includes(decision)) fail('INVALID_INPUT', '请选择禁言、封禁或解除。');
    if (event.confirmed !== true) fail('CONFIRM_REQUIRED', '请核对对象与原因后再次确认。');
    const checked = await moderation(openid, reason); if (checked.suggestion !== 'pass') fail('MODERATION_UNAVAILABLE', '处理原因需通过审核。');
    return repo.transaction(async tx => {
      admin(await tx.get('members', ownId));
      const target = await tx.get('members', targetId), lock = await tx.get('members', '__bootstrap_admin_v1');
      if (!target || target.kind !== 'member') fail('NOT_FOUND', '成员不存在。');
      if (target.role === 'admin' || lock?.memberId === targetId) fail('FORBIDDEN', '管理员账号需先由初始管理员处理角色，初始管理员不能被处罚。');
      verifyRevision(target, expected); const at = now();
      const updated = { ...target, banned: decision === 'ban', mutedUntil: decision === 'mute' ? at + MUTE_WINDOW : 0, sanctionReason: reason, revision: target.revision + 1, updatedAt: at };
      await tx.set('members', targetId, updated);
      await appendAudit(tx, { actor: ownId, target: targetId, action: 'setMemberSanction', from: target.banned ? 'ban' : target.mutedUntil > at ? 'mute' : 'none', to: decision, at, revision: updated.revision });
      return { member: { id: targetId, banned: updated.banned, mutedUntil: updated.mutedUntil, revision: updated.revision, sanctionReason: reason } };
    });
  }
  async function setExperienceRecommendation(event, ownId) {
    const postId = id(event.postId), expected = revision(event.revision);
    if (typeof event.recommended !== 'boolean') fail('INVALID_INPUT', '请选择明确的推荐状态。');
    if (event.confirmed !== true) fail('CONFIRM_REQUIRED', '请核对当前经验文章及版本后确认。');
    return repo.transaction(async tx => {
      admin(await tx.get('members', ownId));
      const post = await tx.get('posts', postId);
      if (!post || post.kind !== 'post' || post.community !== 'experience') fail('NOT_FOUND', '经验文章不存在。');
      if (!!post.recommended === event.recommended && post.recommendationBaseRevision === expected && post.revision === expected + 1) return { post: publicPost(post, { _id: ownId, role: 'admin' }), unchanged: true };
      verifyRevision(post, expected);
      if (event.recommended && (post.status !== 'published' || post.moderation !== 'pass')) fail('POST_UNAVAILABLE', '仅能推荐已公开且微信审核通过的经验文章。');
      if (event.recommended) await deps.validateMedia(post.mediaIds, post.authorId, tx);
      if (!!post.recommended === event.recommended) return { post: publicPost(post, { _id: ownId, role: 'admin' }), unchanged: true };
      const at = now();
      const updated = { ...post, recommended: event.recommended, recommendedAt: event.recommended ? at : null, recommendationBaseRevision: expected, updatedAt: at, revision: post.revision + 1 };
      await tx.set('posts', postId, updated);
      await appendAudit(tx, { actor: ownId, target: postId, action: 'setExperienceRecommendation', from: post.recommended ? 'recommended' : 'normal', to: updated.recommended ? 'recommended' : 'normal', at, revision: updated.revision });
      return { post: publicPost(updated, { _id: ownId, role: 'admin' }) };
    });
  }
  async function getPostAuthor(event, ownId) {
    const postId = id(event.postId), reason = text(event.reason, 200, '核查原因', 2);
    const actor = admin(await repo.get('members', ownId));
    if (!actor.openid) fail('AUTHOR_UNAVAILABLE', '身份暂不可核对。');
    const checked = await moderation(actor.openid, reason); if (checked.suggestion !== 'pass') fail('MODERATION_UNAVAILABLE', '核查原因需通过审核。');
    return repo.transaction(async tx => {
      admin(await tx.get('members', ownId)); const post = await tx.get('posts', postId); if (!post) fail('NOT_FOUND', '帖子不存在。');
      const author = await tx.get('members', post.authorId); if (!author) fail('AUTHOR_UNAVAILABLE', '作者信息暂不可核对。');
      const at = now(); await tx.set('audit', hash(`${ownId}:author:${postId}:${at}:${Math.random()}`), { kind: 'audit', actorId: ownId, targetId: postId, action: 'inspectPostAuthor', reasonCategory: 'manual-check', createdAt: at });
      return { author: { memberId: post.authorId, nickname: author.nickname, status: author.status, role: author.role } };
    });
  }
  return { votePost, active, community, searchPosts, discover: (event, member) => discover(event, member, { ...deps, active, community }), list, editPost, listComments, publishComment, deleteComment: (e,o,i) => mutateComment(e,o,i,'deleteComment'), reviewComment: (e,o,i) => mutateComment(e,o,i,'reviewComment'), reviewComments, setLiked, getLikeState, setMemberSanction, getPostAuthor, setExperienceRecommendation };
}
module.exports = { createForumService, EDIT_WINDOW, MUTE_WINDOW };
