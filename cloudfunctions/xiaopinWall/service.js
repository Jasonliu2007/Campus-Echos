'use strict';

const { createHash, randomUUID } = require('crypto');
const { createReportService } = require('./reports');
const { readPresets, checkImageCount } = require('./post-presets');
const searchCore = require('./search-core');
const { createCampusEmail } = require('./campus-email');
const { createDirectMessages } = require('./direct');
const { createForumService } = require('./forum');
const { createMediaService } = require('./media');
const { replacePostMediaReferences } = require('./media-lifecycle');

const VERSION = 'wall-20261115-v1.12';
const APPID = 'wxa16f2146b48a2c2e';
const CATEGORIES = searchCore.CATEGORIES;
const PAGE_SIZE = 20;
const POST_STATES = ['published', 'pending', 'rejected', 'hidden', 'deleted'];
const MEMBER_STATES = ['pending', 'approved', 'rejected', 'revoked'];
const BUSINESS_TERMS = ['代写', '代考', '考试答案', '作业答案', '真题答案', '色情', '裸照', '刷单', '诈骗', '赌博', '政治谣言'];

class WallError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function fail(code, message) { throw new WallError(code, message); }
function hash(text) { return createHash('sha256').update(text).digest('hex').slice(0, 32); }
function memberId(openid) { return hash(`${APPID}:${openid}`); }
function text(value, max, label, min = 1) {
  const valueText = typeof value === 'string' ? value.trim() : '';
  const length = Array.from(valueText).length;
  if (length < min || length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(valueText)) {
    fail('INVALID_INPUT', `${label}请填写 ${min}-${max} 字。`);
  }
  return valueText;
}
function id(value, label = '内容') {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) fail('INVALID_INPUT', `${label}编号无效，请刷新后再试。`);
  return value;
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_INPUT', '内容版本无效，请刷新后再试。');
  return value;
}
function publicMember(member, admin = false) {
  if (!member) return null;
  const result = {
    id: member._id, nickname: member.nickname, role: member.role, status: member.status,
    revision: member.revision, createdAt: member.createdAt, updatedAt: member.updatedAt,
    banned: !!member.banned, mutedUntil: member.mutedUntil || 0, sanctionReason: member.sanctionReason || '',
  };
  if (member.reviewReason) result.reviewReason = member.reviewReason;
  if (admin) result.reason = member.reason || '';
  return result;
}
// Fictional bylines for the original closed-beta sample posts.
const sampleAuthors = {
  '8c675d07f6b1889906b0af4f05089538': { name: '陈小满', avatarId: 'avatar-1' },
  '048a117ea11023b782faa96250e76389': { name: '陈小满', avatarId: 'avatar-1' },
  '4832fae6dfba96c943e7f261860ae6cc': { name: '林予安', avatarId: 'avatar-2' },
  '001653c3c563694c77832229d59b4245': { name: '林予安', avatarId: 'avatar-2' },
  'e581955de30115e0f56d54fa72325684': { name: '柯晚晴', avatarId: 'avatar-3' },
  '9544eee521121e2965b7183d5c4a88bd': { name: '柯晚晴', avatarId: 'avatar-3' },
  'ec8ea8ec5c066f28a3149da0b7436266': { name: '周一航', avatarId: 'avatar-4' },
  'ae08a39b48bedd2cd37c72419071b02c': { name: '周一航', avatarId: 'avatar-4' },
  '946a335743b4604c795dfe12711bd7e3': { name: '沈知夏', avatarId: 'avatar-5' },
  '1efea65b0f1c607663ae2fc657885b13': { name: '沈知夏', avatarId: 'avatar-5' },
  '04437e94f46b43d487f1e0bea2fca9a8': { name: '许时雨', avatarId: 'avatar-6' },
  '0cc0fd74c3a298cb4bd8ee0d5a36b31f': { name: '许时雨', avatarId: 'avatar-6' },
  'd1186706c5b471ac69c25251bee123c1': { name: '江予宁', avatarId: 'avatar-7' },
  'b399dc240e03249026743696fb377931': { name: '江予宁', avatarId: 'avatar-7' },
  '14b54b8e8c7769f13f9a1878c9b26e6e': { name: '方小禾', avatarId: 'avatar-8' },
  '4993fcab9b9d1f98958fe6b076454d96': { name: '方小禾', avatarId: 'avatar-8' },
  '007824946c2bc3da711ea4ae23d40569': { name: '周一航', avatarId: 'avatar-4' },
  '148e21e2947fa8fe25730d6e67423c5a': { name: '周一航', avatarId: 'avatar-4' },
  '5a8450eb5ebbb55245e4a16811043059': { name: '沈知夏', avatarId: 'avatar-5' },
  '4faafc5443fcd4912ac3d3049626e477': { name: '沈知夏', avatarId: 'avatar-5' },
  'cd11bc8ee27ff2208c9809e5af7315f7': { name: '许时雨', avatarId: 'avatar-6' },
  'baf0ec752c29a2bdeb38e12231760771': { name: '许时雨', avatarId: 'avatar-6' },
  '106dcbe4236109db21334a72f20d49e9': { name: '江予宁', avatarId: 'avatar-7' },
  'c3af978b74b192738960e020a635da62': { name: '江予宁', avatarId: 'avatar-7' },
  '96f1db03abac8542226cb0f3311f7307': { name: '方小禾', avatarId: 'avatar-8' },
  '31e407d7d832824ea7fa5f4ca5cfb9c2': { name: '方小禾', avatarId: 'avatar-8' },
  '6eaf17c59f31ffdadac6339cc1144dc4': { name: '陈小满', avatarId: 'avatar-1' },
  '57c1a700e5921bf8f2fb5df0252aab77': { name: '陈小满', avatarId: 'avatar-1' },
  'c5eb8eef6563ee0ee16521401d1377da': { name: '林予安', avatarId: 'avatar-2' },
  '6cd53470ba71f25b658c280d776a6e87': { name: '林予安', avatarId: 'avatar-2' },
  '44b76f17b769b3bf05a7f10c345953cc': { name: '柯晚晴', avatarId: 'avatar-3' },
  '6b447eb4639333450a4f58dbe8e8865f': { name: '柯晚晴', avatarId: 'avatar-3' }
};

function displayAuthorName(post) {
  return post.isAnonymous ? '匿名同学' : (sampleAuthors[post._id]?.name || post.authorName);
}

function publicPost(post, viewer) {
  const owner = post.authorId === viewer._id;
  const result = {
    _id: post._id, title: post.status === 'deleted' ? '' : post.title, content: post.status === 'deleted' ? '' : post.content, category: searchCore.category(post.category),
    community: post.community || 'forum', recommended: post.community === 'experience' && post.status === 'published' && post.moderation === 'pass' && post.recommended === true, canRecommend: viewer.role === 'admin' && post.community === 'experience' && post.status === 'published' && post.moderation === 'pass', isAnonymous: !!post.isAnonymous, mediaIds: post.status === 'deleted' ? [] : post.mediaIds || [],
    likeCount: post.likeCount || 0, commentCount: post.commentCount || 0, editDeadline: post.createdAt + 30 * 60 * 1000,
    status: post.status, createdAt: post.createdAt, updatedAt: post.updatedAt,
    authorName: displayAuthorName(post), isOwner: owner, ...(sampleAuthors[post._id] ? { samplePost: true } : {}), revision: post.revision,
  };
  if (post.status !== 'deleted') {
    if (post.isAnonymous) result.avatarId = 'anonymous';
    else if (sampleAuthors[post._id]) result.avatarId = sampleAuthors[post._id].avatarId;
    else if (viewer.officialAuthorId && viewer.officialAuthorId === post.authorId) result.avatarId = 'official';
    else if (post.avatarId) result.avatarId = post.avatarId;
    if (post.hideTitle) result.hideTitle = true;
    if (post.poll?.length) result.poll = { options: post.poll, counts: post.pollCounts || post.poll.map(() => 0) };
    if (post.location) result.location = post.location;
    if (post.stickerId) result.stickerId = post.stickerId;
    if (post.replyScope === 'author') {
      result.replyScope = 'author';
      result.canReply = owner;
    }
    if (post.reviewReplies) result.reviewReplies = true;
    if (post.coverId) result.coverId = post.coverId;
  }
  if ((owner || viewer.role === 'admin') && post.reviewReason) result.reviewReason = post.reviewReason;
  return result;
}
function encodeCursor(item, scope) {
  return Buffer.from(JSON.stringify({ t: item.createdAt, i: item._id, s: scope })).toString('base64url');
}
function decodeCursor(value, scope) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 500 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('INVALID_CURSOR', '列表位置无效，请重新刷新。');
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (!Number.isSafeInteger(cursor.t) || cursor.t < 1 || !/^[a-f0-9]{32}$/.test(cursor.i) || cursor.s !== scope) throw new Error('invalid');
    return { createdAt: cursor.t, _id: cursor.i };
  } catch (_) { fail('INVALID_CURSOR', '列表位置无效，请重新刷新。'); }
}
function approved(member) {
  if (!member || member.kind !== 'member' || member.status !== 'approved') fail('ACCESS_DENIED', '校园墙正在封闭内测，请先申请并等待通过。');
  return member;
}
function admin(member) {
  approved(member);
  if (member.role !== 'admin') fail('FORBIDDEN', '只有管理员可以处理这项操作。');
  return member;
}
function verifyRevision(record, expected) {
  if (record.revision !== expected) fail('CONFLICT', '内容已被更新，请刷新后再操作。');
}

function createWallService({ repo, moderate, now = Date.now, bootstrapAdminOpenid = '', logger = console, storage, mediaCheck, campusEmailConfig }) {
  if (!repo || typeof moderate !== 'function') throw new Error('repo and moderate are required');

  async function moderation(openid, content, { captureRisky = false } = {}) {
    let result;
    try { result = await moderate(openid, content); }
    catch (error) {
      logger.error('wall_moderation_failed', { code: error.code || error.errCode || 'unknown' });
      fail('MODERATION_UNAVAILABLE', '内容审核暂不可用，内容已保留，请稍后重试。');
    }
    if (!result || (result.errcode !== undefined && result.errcode !== 0) || (result.errCode !== undefined && result.errCode !== 0)) fail('MODERATION_UNAVAILABLE', '微信未确认审核成功，内容已保留。');
    const suggestion = result && result.result && result.result.suggest;
    if (suggestion === 'risky' && !captureRisky) fail('CONTENT_REJECTED', '内容未通过安全审核，请修改后再试。');
    if (!['pass', 'review', ...(captureRisky ? ['risky'] : [])].includes(suggestion)) fail('MODERATION_UNAVAILABLE', '暂时无法确认审核结果，内容已保留，请稍后重试。');
    return { suggestion, traceId: typeof result.traceId === 'string' ? result.traceId : '' };
  }

  async function appendAudit(tx, { actor, target, action, from, to, reason = '', at, revision: rev }) {
    const auditId = hash(`${actor}:${target}:${action}:${rev}`);
    await tx.set('audit', auditId, { kind: 'audit', actorId: actor, targetId: target, action, from, to, reason, createdAt: at, revision: rev });
  }

  async function ensureBootstrap(openid, ownId) {
    if (!bootstrapAdminOpenid || openid !== bootstrapAdminOpenid) return;
    const at = now();
    await repo.transaction(async (tx) => {
      const lock = await tx.get('members', '__bootstrap_admin_v1');
      const existing = await tx.get('members', ownId);
      if (lock) return;
      if (existing && existing.status !== 'pending') fail('BOOTSTRAP_CONFLICT', '初始管理员配置与现有成员记录冲突，请联系维护者。');
      await tx.set('members', ownId, {
        kind: 'member', openid, nickname: '校园回声管理员', reason: '用户指定的初始管理员',
        role: 'admin', status: 'approved', revision: (existing ? existing.revision : 0) + 1,
        createdAt: existing ? existing.createdAt : at, updatedAt: at,
      });
      await tx.set('members', '__bootstrap_admin_v1', { kind: 'bootstrap', memberId: ownId, createdAt: at });
      await appendAudit(tx, { actor: ownId, target: ownId, action: 'bootstrapAdmin', from: existing ? existing.status : 'none', to: 'approved', at, revision: 1 });
    });
  }

  async function requestAccess(event, openid, ownId) {
    const nickname = text(event.nickname, 16, '昵称', 2);
    const reason = text(event.reason, 200, '申请说明', 2);
    const existing = await repo.get('members', ownId);
    if (existing) return { member: publicMember(existing), access: existing.status };
    const checked = await moderation(openid, `${nickname}\n${reason}`);
    const at = now();
    const saved = await repo.transaction(async (tx) => {
      const current = await tx.get('members', ownId);
      if (current) return current;
      const member = { _id: ownId, kind: 'member', openid, nickname, reason, role: 'member', status: 'pending', revision: 1, createdAt: at, updatedAt: at, moderation: checked.suggestion };
      await tx.set('members', ownId, member);
      await appendAudit(tx, { actor: ownId, target: ownId, action: 'requestAccess', from: 'none', to: 'pending', at, revision: 1 });
      return member;
    });
    return { member: publicMember(saved), access: saved.status };
  }

  async function paginate(type, where, cursor, scope, project) {
    const rows = await repo.query(type, { where, cursor: decodeCursor(cursor, scope), limit: PAGE_SIZE + 1 });
    const hasMore = rows.length > PAGE_SIZE;
    const page = rows.slice(0, PAGE_SIZE);
    return { [type === 'members' ? 'members' : 'posts']: page.map(project), nextCursor: hasMore ? encodeCursor(page[page.length - 1], scope) : null, hasMore };
  }

  async function publish(event, openid, ownId, member) {
    forum.active(member, true);
    campusEmail.assertVerified(member);
    const space = forum.community(event.community);
    const isAnonymous = event.isAnonymous === true;
    if (event.isAnonymous !== undefined && typeof event.isAnonymous !== 'boolean') fail('INVALID_INPUT', '匿名选项无效。');
    const mediaIds = await media.validateMedia(event.mediaIds, ownId);
    const presets = readPresets(event, fail);
    if (isAnonymous) delete presets.avatarId;
    checkImageCount(presets.coverId, mediaIds, fail);
    const category = event.category;
    const title = text(event.title, 60, '标题');
    const content = text(event.content, 2000, '正文');
    const requestId = event.requestId;
    if (typeof requestId !== 'string' || !/^[a-z0-9-]{10,64}$/.test(requestId)) fail('INVALID_INPUT', '发布请求无效，请重新打开发布表单。');
    const postSettings = Object.fromEntries(Object.entries(presets).filter(([key]) => ['stickerId', 'replyScope', 'reviewReplies', 'poll', 'location', 'hideTitle'].includes(key)));
    const quotePostId = event.quotePostId ? id(event.quotePostId) : '';
    if (quotePostId && space !== 'forum') fail('INVALID_INPUT', '仅论坛支持引用帖子。');
    const postId = hash(`${openid}:${requestId}`);
    const payloadHash = hash(JSON.stringify([category, title, content, space, isAnonymous, mediaIds, ...(presets.avatarId || presets.coverId ? [presets.avatarId || '', presets.coverId || ''] : []), ...(quotePostId ? [{ quotePostId }] : []), ...(Object.keys(postSettings).length ? [postSettings] : [])]));
    function existingResult(existing) {
      const oldPayloadHash = hash(JSON.stringify([category, title, content]));
      const matchesLegacy = !Object.keys(postSettings).length && !quotePostId && !presets.avatarId && !presets.coverId && !existing.community && !isAnonymous && !mediaIds.length && existing.payloadHash === oldPayloadHash;
      if ((!matchesLegacy && existing.payloadHash !== payloadHash) || existing.authorId !== ownId) fail('REQUEST_CONFLICT', '同一发布请求的内容发生变化，请重新发布。');
      return { postId, status: existing.status, revision: existing.revision };
    }
    const existing = await repo.get('posts', postId);
    if (existing) return existingResult(existing);
    if (!CATEGORIES.includes(category)) fail('INVALID_INPUT', '请选择有效的论坛分类。');
    const checked = await moderation(openid, [title, content, presets.location, ...(presets.poll || [])].filter(Boolean).join('\n'));
    const matched = BUSINESS_TERMS.filter(term => [title, content, presets.location, ...(presets.poll || [])].some(value => value?.includes(term)));
    const status = isAnonymous || checked.suggestion === 'review' || matched.length ? 'pending' : 'published';
    const at = now();
    return repo.transaction(async (tx) => {
      const actor = forum.active(await tx.get('members', ownId), true);
      campusEmail.assertVerified(actor);
      await media.validateMedia(mediaIds, ownId, tx);
      const saved = await tx.get('posts', postId);
      if (saved) return existingResult(saved);
      if (quotePostId) {
        const source = await tx.get('posts', quotePostId);
        if (!source || source.status !== 'published' || (source.community || 'forum') !== 'forum' || (source.replyScope === 'author' && source.authorId !== ownId) || !(await media.isPublicSafe(source, tx))) {
          fail('POST_UNAVAILABLE', '原帖暂不可引用。');
        }
      }
      await replacePostMediaReferences(tx, { postId, after: mediaIds, at });
      await tx.set('posts', postId, {
        kind: 'post', authorId: ownId, authorName: actor.nickname || member.nickname,
        category, title, content, status, payloadHash, ...(quotePostId ? { quotePostId } : {}), community: space, isAnonymous, mediaIds, ...presets, likeCount: 0, commentCount: 0, searchVersion: searchCore.TOKENIZER_VERSION, searchFields: searchCore.fields({ title, content }), moderation: checked.suggestion,
        moderationTraceId: checked.traceId, businessReview: matched.length > 0,
        createdAt: at, updatedAt: at, revision: 1,
      });
      await appendAudit(tx, { actor: ownId, target: postId, action: 'publish', from: 'none', to: status, reason: matched.length ? '业务关键词待人工复核' : '', at, revision: 1 });
      return { postId, status, revision: 1 };
    });
  }

  async function attachQuote(post) {
    if (!post.quotePostId || post.status === 'deleted') return undefined;
    const source = await repo.get('posts', post.quotePostId);
    if (!source || source.status !== 'published' || !(await media.isPublicSafe(source))) return { unavailable: true };
    return { id: source._id, title: source.title, authorName: displayAuthorName(source) };
  }

  async function getPost(event, member) {
    const post = await repo.get('posts', id(event.postId));
    if (!post || post.kind !== 'post') fail('NOT_FOUND', '这条帖子不存在或已不可查看。');
    if (post.status !== 'published' && !(post.status === 'deleted' && (post.hasCommentHistory || post.commentCount > 0)) && post.authorId !== member._id && member.role !== 'admin') fail('NOT_FOUND', '这条帖子不存在或已不可查看。');
    if (post.status === 'published' && !(await media.isPublicSafe(post))) fail('POST_UNAVAILABLE', '图片审核结果变化，帖子暂停展示。');
    const result = { ...publicPost(post, member), viewerAvatarOwner: member._id, quote: await attachQuote(post) };
    if (result.poll) {
      const vote = await repo.get('likes', hash(`${member._id}:poll:${post._id}`));
      result.poll.choice = vote?.choice ?? -1;
    }
    return { post: result };
  }

  async function mutatePost(event, ownId, action) {
    const postId = id(event.postId);
    const expected = revision(event.revision);
    let reason = '';
    let reviewCheck = null;
    if (action === 'reviewPost' && !['approve', 'reject'].includes(event.decision)) fail('INVALID_INPUT', '请选择通过或驳回。');
    if (action === 'hidePost' || event.decision === 'reject') reason = text(event.reason, 200, '处理原因', 2);
    if (action === 'reviewPost' && event.decision === 'approve') {
      const post = await repo.get('posts', postId);
      if (!post || post.status !== 'pending') fail('CONFLICT', '这条帖子已被处理，请刷新列表。');
      verifyRevision(post, expected);
      await media.validateMedia(post.mediaIds, post.authorId);
      const author = await repo.get('members', post.authorId);
      if (!author || !author.openid) fail('AUTHOR_UNAVAILABLE', '作者信息暂不可用，不能通过审核。');
      reviewCheck = await moderation(author.openid, [post.title, post.content, post.location, ...(post.poll || [])].filter(Boolean).join('\n'), { captureRisky: true });
      if (reviewCheck.suggestion === 'review') fail('POST_REVIEW_REQUIRED', '微信审核仍需复核，帖子保持待审核，暂不能公开。');
    }
    const at = now();
    const result = await repo.transaction(async (tx) => {
      const actor = await tx.get('members', ownId);
      if (action === 'deletePost') approved(actor); else admin(actor);
      const post = await tx.get('posts', postId);
      if (!post || post.kind !== 'post') fail('NOT_FOUND', '这条帖子不存在或已不可查看。');
      if (action === 'deletePost' && post.authorId !== ownId) fail('FORBIDDEN', '只能删除自己发布的帖子。');
      if (action === 'deletePost' && post.status === 'deleted') return { postId, status: 'deleted', revision: post.revision };
      verifyRevision(post, expected);
      if (action === 'reviewPost' && event.decision === 'approve') await media.validateMedia(post.mediaIds, post.authorId, tx);
      if (action === 'reviewPost' && post.status !== 'pending') fail('CONFLICT', '这条帖子已被处理，请刷新列表。');
      if (action === 'hidePost' && post.status !== 'published') fail('CONFLICT', '这条帖子已不在公开列表，请刷新。');
      const safetyRejected = reviewCheck && reviewCheck.suggestion === 'risky';
      const status = safetyRejected ? 'rejected' : action === 'deletePost' ? 'deleted' : action === 'hidePost' ? 'hidden' : event.decision === 'approve' ? 'published' : 'rejected';
      const reviewReason = safetyRejected ? '内容未通过微信安全审核，不能公开。' : reason;
      const updated = { ...post, status, updatedAt: at, revision: post.revision + 1, reviewReason };
      if (reviewCheck) { updated.moderation = reviewCheck.suggestion; updated.moderationTraceId = reviewCheck.traceId; }
      if (action === 'deletePost') { updated.title = ''; updated.content = ''; updated.mediaIds = []; updated.poll = null; updated.pollCounts = null; updated.location = ''; updated.stickerId = 0; updated.searchFields = searchCore.fields({ title: '', content: '' }); updated.searchVersion = searchCore.TOKENIZER_VERSION; updated.hasCommentHistory = post.hasCommentHistory || (post.commentCount || 0) > 0; }
      await replacePostMediaReferences(tx, { postId, before: post.mediaIds || [], after: ['published', 'pending'].includes(status) ? updated.mediaIds || [] : [], at });
      await tx.set('posts', postId, updated);
      await appendAudit(tx, { actor: ownId, target: postId, action: safetyRejected ? 'securityReject' : action, from: post.status, to: status, reason: reviewReason, at, revision: updated.revision });
      return { postId, status, revision: updated.revision };
    });
    // Throw only after commit so a risky verdict remains terminal and cannot be retried into approval.
    if (reviewCheck && reviewCheck.suggestion === 'risky') fail('CONTENT_REJECTED', '内容未通过微信安全审核，已标记为未通过，不能公开。');
    return result;
  }

  async function reviewMember(event, ownId) {
    const targetId = id(event.memberId, '成员');
    const expected = revision(event.revision);
    if (!['approve', 'reject', 'revoke'].includes(event.decision)) fail('INVALID_INPUT', '请选择有效的成员处理操作。');
    const reason = event.decision === 'approve' ? '' : text(event.reason, 200, '处理原因', 2);
    if (event.decision === 'approve') {
      const target = await repo.get('members', targetId);
      if (!target || !target.openid) fail('NOT_FOUND', '申请记录不存在。');
      const check = await moderation(target.openid, `${target.nickname}\n${target.reason || ''}`);
      if (check.suggestion !== 'pass') fail('MEMBER_REVIEW_REQUIRED', '申请内容仍需复核，请核实后由维护者处理，暂不开放权限。');
    }
    const at = now();
    return repo.transaction(async (tx) => {
      admin(await tx.get('members', ownId));
      const target = await tx.get('members', targetId);
      if (!target || target.kind !== 'member') fail('NOT_FOUND', '申请记录不存在。');
      if (target.role === 'admin') fail('FORBIDDEN', '请先由初始管理员取消其管理员权限，再处理内测资格；初始管理员不能被修改。');
      verifyRevision(target, expected);
      if (event.decision === 'approve' && !['pending', 'rejected', 'revoked'].includes(target.status)) fail('CONFLICT', '这位同学已经获得内测资格。');
      if (event.decision === 'reject' && target.status !== 'pending') fail('CONFLICT', '这份申请已经处理，请刷新。');
      if (event.decision === 'revoke' && target.status !== 'approved') fail('CONFLICT', '这位同学当前没有可撤销的资格。');
      const status = { approve: 'approved', reject: 'rejected', revoke: 'revoked' }[event.decision];
      const updated = { ...target, status, reviewReason: reason, updatedAt: at, revision: target.revision + 1 };
      await tx.set('members', targetId, updated);
      await appendAudit(tx, { actor: ownId, target: targetId, action: 'reviewMember', from: target.status, to: status, reason, at, revision: updated.revision });
      return { member: publicMember(updated, true) };
    });
  }

  async function setMemberRole(event, ownId) {
    const targetId = id(event.memberId, '成员');
    const expected = revision(event.revision);
    if (!['admin', 'member'].includes(event.role)) fail('INVALID_INPUT', '请选择有效的成员权限。');
    const at = now();
    return repo.transaction(async (tx) => {
      // The original bootstrap lock owns delegation authority. A changed deployment
      // variable or client role cannot transfer it to another administrator.
      admin(await tx.get('members', ownId));
      const lock = await tx.get('members', '__bootstrap_admin_v1');
      if (!lock || lock.kind !== 'bootstrap' || lock.memberId !== ownId) fail('FORBIDDEN', '只有初始管理员可以授予或取消管理员权限。');
      if (targetId === lock.memberId) fail('FORBIDDEN', '初始管理员的权限不能在这里修改。');
      const target = await tx.get('members', targetId);
      if (!target || target.kind !== 'member') fail('NOT_FOUND', '成员记录不存在，请刷新后再试。');
      if (target.status !== 'approved') fail('ACCESS_DENIED', '请先批准该成员的内测资格，再设置管理员权限。');
      verifyRevision(target, expected);
      if (target.role === event.role) fail('CONFLICT', '该成员权限已经更新，请刷新确认。');
      const updated = { ...target, role: event.role, updatedAt: at, revision: target.revision + 1 };
      await tx.set('members', targetId, updated);
      await appendAudit(tx, { actor: ownId, target: targetId, action: 'setMemberRole', from: target.role, to: event.role, at, revision: updated.revision });
      return { member: publicMember(updated, true) };
    });
  }

  const campusEmail = createCampusEmail({ ...campusEmailConfig, repo, now, approved, fail, logger });
  const media = createMediaService({ repo, now, hash, id, approved, fail, storage, mediaCheck, logger });
  const forum = createForumService({ repo, moderation, now, hash, id, text, revision, approved, admin, verifyRevision, fail, encodeCursor, decodeCursor, publicPost, attachQuote, appendAudit, validateMedia: media.validateMedia, isPublicSafe: media.isPublicSafe, businessTerms: BUSINESS_TERMS });
  const direct = createDirectMessages({ repo, hash, id, text, fail, approved, moderation, active: forum.active, isPublicSafe: media.isPublicSafe, isSamplePost: post => !!sampleAuthors[post._id], media, storage, now });
  const reports = createReportService({ repo, moderation, now, hash, id, text, revision, approved, admin, verifyRevision, encodeCursor, decodeCursor, fail });

  async function handle(event = {}, context = {}) {
    const traceId = randomUUID();
    try {
      if (!event || typeof event !== 'object' || Array.isArray(event)) fail('INVALID_INPUT', '请求格式无效。');
      if (context.APPID !== APPID || typeof context.OPENID !== 'string' || !context.OPENID || context.OPENID.length > 128) fail('UNAUTHENTICATED', '请从校园回声微信小程序进入后再试。');
      const openid = context.OPENID;
      const ownId = memberId(openid);
      const { action } = event;
      let result;
      if (action === 'session') {
        await ensureBootstrap(openid, ownId);
        const member = await repo.get('members', ownId);
        const lock = await repo.get('members', '__bootstrap_admin_v1');
        const canManageAdmins = !!(member && member.kind === 'member' && member.status === 'approved' && member.role === 'admin'
          && lock && lock.kind === 'bootstrap' && lock.memberId === ownId);
        result = {
          authenticated: true, supportsForumQuotes: true, supportsComposerOptions: true, canManageAdmins, member: publicMember(member),
          access: member ? member.status : 'none', categories: CATEGORIES, campusEmailSupported: true,
          campusEmailRequired: campusEmail.required, campusEmailAvailable: campusEmail.available,
          campusEmailVerified: campusEmail.verified(member),
        };
      } else if (action === 'requestAccess') {
        result = await requestAccess(event, openid, ownId);
      } else {
        const member = approved(await repo.get('members', ownId));
        if (['list', 'listMine', 'reviewList', 'getPost', 'searchPosts', 'search', 'searchDiscovery', 'listComments', 'reviewComments'].includes(action)) {
          const lock = await repo.get('members', '__bootstrap_admin_v1');
          if (lock?.kind === 'bootstrap') member.officialAuthorId = lock.memberId;
        }
        if (['reviewList', 'reviewPost', 'hidePost', 'listMembers', 'reviewMember', 'reviewReports', 'resolveReport', 'setMemberRole'].includes(action)) admin(member);
        if (['directList', 'directOpen', 'directSend', 'directRespond', 'directUpload', 'directAttachment', 'directFindMember'].includes(action)) result = await direct.handle(event, member, openid);
        else if (action === 'campusEmailSend') result = await campusEmail.send(event, ownId);
        else if (action === 'campusEmailVerify') result = await campusEmail.verify(event, ownId);
        else if (action === 'searchPosts' || action === 'search') result = await forum.searchPosts(event, member);
        else if (action === 'searchDiscovery') result = await forum.discover(event, member);
        else if (action === 'editPost') result = await forum.editPost(event, openid, ownId);
        else if (action === 'listComments') result = await forum.listComments(event, member);
        else if (action === 'publishComment') result = await forum.publishComment(event, openid, ownId);
        else if (action === 'deleteComment') result = await forum.deleteComment(event, openid, ownId);
        else if (action === 'reviewComment') result = await forum.reviewComment(event, openid, ownId);
        else if (action === 'reviewComments') result = await forum.reviewComments(event, member);
        else if (action === 'votePost') result = await forum.votePost(event, ownId);
        else if (action === 'setLiked') result = await forum.setLiked(event, ownId);
        else if (action === 'getLikeState') result = await forum.getLikeState(event, ownId);
        else if (action === 'setMemberSanction') { admin(member); result = await forum.setMemberSanction(event, openid, ownId); }
        else if (action === 'setExperienceRecommendation') { admin(member); result = await forum.setExperienceRecommendation(event, ownId); }
        else if (action === 'getPostAuthor') { admin(member); result = await forum.getPostAuthor(event, ownId); }
        else if (action === 'uploadMedia') result = await media.uploadMedia(event, openid, ownId);
        else if (action === 'getMedia') result = await media.getMedia(event, member);
        else if (action === 'reportPost') result = await reports.reportPost(event, openid, ownId);
        else if (action === 'reportComment') result = await reports.reportComment(event, openid, ownId);
        else if (action === 'listMyReports') result = await reports.listMyReports(event, member);
        else if (action === 'reviewReports') result = await reports.reviewReports(event, member);
        else if (action === 'getReport') result = await reports.getReport(event, member);
        else if (action === 'resolveReport') result = await reports.resolveReport(event, openid, ownId);
        else if (action === 'publish') result = await publish(event, openid, ownId, member);
        else if (action === 'getPost') result = await getPost(event, member);
        else if (action === 'list') {
          result = await forum.list(event, member);
        } else if (action === 'listMine') {
          if (event.status && !POST_STATES.includes(event.status)) fail('INVALID_INPUT', '帖子状态无效。');
          const where = { kind: 'post', authorId: ownId, ...(event.status ? { status: event.status } : {}) };
          result = await paginate('posts', where, event.cursor, `mine:${ownId}:${event.status || ''}`, (post) => publicPost(post, member));
        } else if (action === 'reviewList') {
          const status = event.status || 'pending';
          if (!['pending', 'published'].includes(status)) fail('INVALID_INPUT', '请选择待审核或已发布列表。');
          result = await paginate('posts', { kind: 'post', status }, event.cursor, `review:${status}`, (post) => publicPost(post, member));
        } else if (['deletePost', 'reviewPost', 'hidePost'].includes(action)) result = await mutatePost(event, ownId, action);
        else if (action === 'listMembers') {
          if (event.status && !MEMBER_STATES.includes(event.status)) fail('INVALID_INPUT', '成员状态无效。');
          result = await paginate('members', { kind: 'member', ...(event.status ? { status: event.status } : {}) }, event.cursor, `members:${event.status || ''}`, (target) => publicMember(target, true));
        } else if (action === 'reviewMember') result = await reviewMember(event, ownId);
        else if (action === 'setMemberRole') result = await setMemberRole(event, ownId);
        else fail('INVALID_ACTION', '请求无效，请更新小程序后重试。');
      }
      return { ok: true, version: VERSION, traceId, ...result };
    } catch (error) {
      if (!(error instanceof WallError)) logger.error('wall_request_failed', { traceId, code: error.code || error.errCode || 'unknown' });
      return { ok: false, version: VERSION, traceId, code: error instanceof WallError ? error.code : 'SERVICE_UNAVAILABLE', message: error instanceof WallError ? error.message : '校园墙暂不可用，请稍后重试。' };
    }
  }
  // Server entry owns trust verification; no client action routes to this method.
  return Object.assign(handle, { handleMediaCallback: (event, trusted) => media.handleCallback(event, trusted) });
}

module.exports = { createWallService, publicPost, publicMember, VERSION, APPID, CATEGORIES, PAGE_SIZE, memberId, hash, decodeCursor, encodeCursor };
