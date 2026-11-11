'use strict';

const { createHash, randomUUID } = require('crypto');

const VERSION = 'wall-20261111-v1.1';
const APPID = 'wxa16f2146b48a2c2e';
const CATEGORIES = ['失物招领', '吐槽树洞', '学习互助', '闲置转让'];
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
  };
  if (member.reviewReason) result.reviewReason = member.reviewReason;
  if (admin) result.reason = member.reason || '';
  return result;
}
function publicPost(post, viewer) {
  const owner = post.authorId === viewer._id;
  const result = {
    _id: post._id, title: post.title, content: post.content, category: post.category,
    status: post.status, createdAt: post.createdAt, updatedAt: post.updatedAt,
    authorName: post.authorName, isOwner: owner, revision: post.revision,
  };
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

function createWallService({ repo, moderate, now = Date.now, bootstrapAdminOpenid = '', logger = console }) {
  if (!repo || typeof moderate !== 'function') throw new Error('repo and moderate are required');

  async function moderation(openid, content, { captureRisky = false } = {}) {
    let result;
    try { result = await moderate(openid, content); }
    catch (error) {
      logger.error('wall_moderation_failed', { code: error.code || error.errCode || 'unknown' });
      fail('MODERATION_UNAVAILABLE', '内容审核暂不可用，内容已保留，请稍后重试。');
    }
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
    const category = event.category;
    if (!CATEGORIES.includes(category)) fail('INVALID_INPUT', '请选择有效的校园墙分区。');
    const title = text(event.title, 60, '标题');
    const content = text(event.content, 2000, '正文');
    const requestId = event.requestId;
    if (typeof requestId !== 'string' || !/^[a-z0-9-]{10,64}$/.test(requestId)) fail('INVALID_INPUT', '发布请求无效，请重新打开发布表单。');
    const postId = hash(`${openid}:${requestId}`);
    const payloadHash = hash(JSON.stringify([category, title, content]));
    function existingResult(existing) {
      if (existing.payloadHash !== payloadHash || existing.authorId !== ownId) fail('REQUEST_CONFLICT', '同一发布请求的内容发生变化，请重新发布。');
      return { postId, status: existing.status, revision: existing.revision };
    }
    const existing = await repo.get('posts', postId);
    if (existing) return existingResult(existing);
    const checked = await moderation(openid, `${title}\n${content}`);
    const matched = BUSINESS_TERMS.filter((term) => `${title}\n${content}`.includes(term));
    const status = checked.suggestion === 'review' || matched.length ? 'pending' : 'published';
    const at = now();
    return repo.transaction(async (tx) => {
      const actor = approved(await tx.get('members', ownId));
      const saved = await tx.get('posts', postId);
      if (saved) return existingResult(saved);
      await tx.set('posts', postId, {
        kind: 'post', authorId: ownId, authorName: actor.nickname || member.nickname,
        category, title, content, status, payloadHash, moderation: checked.suggestion,
        moderationTraceId: checked.traceId, businessReview: matched.length > 0,
        createdAt: at, updatedAt: at, revision: 1,
      });
      await appendAudit(tx, { actor: ownId, target: postId, action: 'publish', from: 'none', to: status, reason: matched.length ? '业务关键词待人工复核' : '', at, revision: 1 });
      return { postId, status, revision: 1 };
    });
  }

  async function getPost(event, member) {
    const post = await repo.get('posts', id(event.postId));
    if (!post || post.kind !== 'post') fail('NOT_FOUND', '这条帖子不存在或已不可查看。');
    if (post.status !== 'published' && post.authorId !== member._id && member.role !== 'admin') fail('NOT_FOUND', '这条帖子不存在或已不可查看。');
    return { post: publicPost(post, member) };
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
      const author = await repo.get('members', post.authorId);
      if (!author || !author.openid) fail('AUTHOR_UNAVAILABLE', '作者信息暂不可用，不能通过审核。');
      reviewCheck = await moderation(author.openid, `${post.title}\n${post.content}`, { captureRisky: true });
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
      if (action === 'reviewPost' && post.status !== 'pending') fail('CONFLICT', '这条帖子已被处理，请刷新列表。');
      if (action === 'hidePost' && post.status !== 'published') fail('CONFLICT', '这条帖子已不在公开列表，请刷新。');
      const safetyRejected = reviewCheck && reviewCheck.suggestion === 'risky';
      const status = safetyRejected ? 'rejected' : action === 'deletePost' ? 'deleted' : action === 'hidePost' ? 'hidden' : event.decision === 'approve' ? 'published' : 'rejected';
      const reviewReason = safetyRejected ? '内容未通过微信安全审核，不能公开。' : reason;
      const updated = { ...post, status, updatedAt: at, revision: post.revision + 1, reviewReason };
      if (reviewCheck) { updated.moderation = reviewCheck.suggestion; updated.moderationTraceId = reviewCheck.traceId; }
      if (action === 'deletePost') { updated.title = ''; updated.content = ''; }
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
      if (target.role === 'admin') fail('FORBIDDEN', '初始管理员不能在这里被撤销或修改。');
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

  return async function handle(event = {}, context = {}) {
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
        result = { member: publicMember(member), access: member ? member.status : 'none', categories: CATEGORIES };
      } else if (action === 'requestAccess') {
        result = await requestAccess(event, openid, ownId);
      } else {
        const member = approved(await repo.get('members', ownId));
        if (['reviewList', 'reviewPost', 'hidePost', 'listMembers', 'reviewMember'].includes(action)) admin(member);
        if (action === 'publish') result = await publish(event, openid, ownId, member);
        else if (action === 'getPost') result = await getPost(event, member);
        else if (action === 'list') {
          if (event.category && !CATEGORIES.includes(event.category)) fail('INVALID_INPUT', '请选择有效的校园墙分区。');
          const where = { kind: 'post', status: 'published', ...(event.category ? { category: event.category } : {}) };
          result = await paginate('posts', where, event.cursor, `list:${event.category || ''}`, (post) => publicPost(post, member));
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
        else fail('INVALID_ACTION', '请求无效，请更新小程序后重试。');
      }
      return { ok: true, version: VERSION, traceId, ...result };
    } catch (error) {
      if (!(error instanceof WallError)) logger.error('wall_request_failed', { traceId, code: error.code || error.errCode || 'unknown' });
      return { ok: false, version: VERSION, traceId, code: error instanceof WallError ? error.code : 'SERVICE_UNAVAILABLE', message: error instanceof WallError ? error.message : '校园墙暂不可用，请稍后重试。' };
    }
  };
}

module.exports = { createWallService, VERSION, APPID, CATEGORIES, PAGE_SIZE, memberId, hash, decodeCursor, encodeCursor };
