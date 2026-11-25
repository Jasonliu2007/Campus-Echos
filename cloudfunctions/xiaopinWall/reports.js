'use strict';
const { replacePostMediaReferences } = require('./media-lifecycle');

const REPORT_REASONS = {
  illegal: '违法违规', scam: '诈骗广告', privacy: '侵犯隐私',
  academic: '学术不端', abuse: '人身攻击', other: '其他'
};
const REPORT_STATES = ['pending', 'hidden', 'dismissed', 'unavailable'];
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RESULT_LABELS = { pending: '待处理', hidden: '已下架', dismissed: '未认定违规', unavailable: '内容已不可见' };

function createReportService(deps) {
  const { repo, moderation, now, hash, id, text, revision, approved, admin, verifyRevision, encodeCursor, decodeCursor, fail } = deps;
  function project(report, at) {
    return {
      _id: report._id, postId: report.postId, targetType: report.targetType || 'post', ...(report.commentId ? { commentId: report.commentId } : {}), reasonCode: report.reasonCode,
      status: report.status, resultLabel: RESULT_LABELS[report.status], revision: report.revision,
      createdAt: report.createdAt, updatedAt: report.updatedAt,
      resolvedAt: report.resolvedAt || null, evidenceExpiresAt: report.evidenceExpiresAt || null,
      evidenceExpired: !!report.evidenceExpiresAt && report.evidenceExpiresAt <= at,
      overdue: report.status === 'pending' && at - report.createdAt >= 24 * 60 * 60 * 1000
    };
  }
  async function audit(tx, actorId, report, action, from, at) {
    await tx.set('audit', hash(`report:${report._id}:${action}:${report.revision}`), {
      kind: 'audit', actorId, targetId: report._id, postId: report.postId,
      action, from, to: report.status, reasonCode: report.reasonCode, targetType: report.targetType || 'post', ...(report.commentId ? { commentId: report.commentId } : {}),
      createdAt: at, revision: report.revision
    });
  }
  function validReport(value) {
    if (!value || value.kind !== 'report') fail('NOT_FOUND', '这条举报不存在或不可查看。');
    return value;
  }
  async function reportPost(event, openid, ownId) {
    const actor = approved(await repo.get('members', ownId));
    if (actor.banned) fail('ACCOUNT_BANNED', '账号已被限制新社区活动，已有订单及售后可继续处理。');
    if (event.targetType !== undefined && !['post', 'comment'].includes(event.targetType)) fail('INVALID_INPUT', '举报对象类型无效。');
    const targetType = event.targetType === 'comment' ? 'comment' : 'post';
    const postId = id(event.postId), commentId = targetType === 'comment' ? id(event.commentId, '评论') : '';
    const reportId = hash(targetType === 'post' ? `report:${ownId}:${postId}` : `report-comment:${ownId}:${commentId}`);
    const saved = await repo.get('reports', reportId);
    if (saved) return { report: project(validReport(saved), now()), duplicate: true };
    if (typeof event.reasonCode !== 'string' || !Object.prototype.hasOwnProperty.call(REPORT_REASONS, event.reasonCode)) fail('INVALID_INPUT', '请选择有效的举报原因。');
    if (event.detail !== undefined && typeof event.detail !== 'string') fail('INVALID_INPUT', '补充说明格式无效。');
    const detail = text(event.detail === undefined ? '' : event.detail, 200, '补充说明', event.reasonCode === 'other' ? 2 : 0);
    const post = await repo.get('posts', postId);
    if (!post || post.kind !== 'post' || post.status !== 'published') fail('POST_UNAVAILABLE', '这条帖子已不可举报，请刷新页面。');
    const target = targetType === 'comment' ? await repo.get('comments', commentId) : post;
    if (!target || (targetType === 'comment' && (target.kind !== 'comment' || target.postId !== postId || target.status !== 'published'))) fail('POST_UNAVAILABLE', '这条评论已不可举报，请刷新。');
    if (target.authorId === ownId) fail('FORBIDDEN', '自己的内容请使用删除功能。');
    const checked = detail ? await moderation(openid, detail) : null;
    const at = now();
    return repo.transaction(async tx => {
      const actor = approved(await tx.get('members', ownId));
      if (actor.banned) fail('ACCOUNT_BANNED', '账号已被限制新社区活动。');
      const existing = await tx.get('reports', reportId);
      if (existing) return { report: project(validReport(existing), at), duplicate: true };
      const current = await tx.get('posts', postId);
      if (!current || current.kind !== 'post' || current.status !== 'published') fail('POST_UNAVAILABLE', '这条帖子已不可举报，请刷新页面。');
      const currentTarget = targetType === 'comment' ? await tx.get('comments', commentId) : current;
      if (!currentTarget || (targetType === 'comment' && (currentTarget.kind !== 'comment' || currentTarget.postId !== postId || currentTarget.status !== 'published'))) fail('POST_UNAVAILABLE', '这条评论已不可举报，请刷新。');
      if (currentTarget.authorId === ownId) fail('FORBIDDEN', '自己的内容请使用删除功能。');
      const report = { _id: reportId, kind: 'report', postId, targetType, ...(commentId ? { commentId } : {}), reporterId: ownId, reasonCode: event.reasonCode, status: 'pending', revision: 1, createdAt: at, updatedAt: at, resolvedAt: null, evidenceExpiresAt: null };
      await tx.set('reports', reportId, report);
      for (const mediaId of (targetType === 'post' ? current.mediaIds || [] : [])) {
        const asset = await tx.get('media', mediaId);
        if (!asset || asset.status !== 'approved') fail('EVIDENCE_UNAVAILABLE', '图片状态已变化，请刷新后举报。');
        await tx.set('media', mediaId, { ...asset, evidenceRefs: { ...(asset.evidenceRefs || {}), [reportId]: null } });
      }
      await tx.set('reportEvidence', reportId, {
        kind: 'reportEvidence', reportId, detail, resolveReason: '',
        snapshot: { targetType, title: targetType === 'post' ? current.title : '评论举报', content: currentTarget.content, category: current.category, community: current.community || 'forum', isAnonymous: !!current.isAnonymous && (targetType === 'post' || currentTarget.authorId === current.authorId), mediaIds: targetType === 'post' ? (current.mediaIds || []).slice(0, 9) : [], createdAt: currentTarget.createdAt, revision: currentTarget.revision, postRevision: current.revision },
        moderation: checked ? checked.suggestion : 'not-needed',
        createdAt: at, expiresAt: null, retentionStatus: 'pending', clearedAt: null
      });
      await audit(tx, ownId, report, 'reportPost', 'none', at);
      return { report: project(report, at), duplicate: false };
    });
  }
  async function list(event, member, isAdmin) {
    if (isAdmin) admin(member);
    if (event.status && !REPORT_STATES.includes(event.status)) fail('INVALID_INPUT', '请选择有效的举报状态。');
    const where = { kind: 'report', ...(!isAdmin ? { reporterId: member._id } : {}), ...(event.status ? { status: event.status } : {}) };
    const scope = `reports:${isAdmin ? 'admin' : member._id}:${event.status || ''}`;
    const rows = await repo.query('reports', { where, cursor: decodeCursor(event.cursor, scope), limit: 21 });
    const hasMore = rows.length > 20, page = rows.slice(0, 20), at = now();
    return { reports: page.map(x => project(x, at)), nextCursor: hasMore ? encodeCursor(page[page.length - 1], scope) : null, hasMore };
  }
  async function getReport(event, member) {
    const report = validReport(await repo.get('reports', id(event.reportId, '举报')));
    if (report.reporterId !== member._id && member.role !== 'admin') fail('NOT_FOUND', '这条举报不存在或不可查看。');
    const at = now(), result = project(report, at), evidence = await repo.get('reportEvidence', report._id);
    const retained = evidence && evidence.retentionStatus !== 'cleared' && (!report.evidenceExpiresAt || at < report.evidenceExpiresAt);
    result.evidenceExpired = !retained;
    result.detail = retained ? evidence.detail || '' : '';
    if (member.role === 'admin') {
      result.snapshot = retained ? evidence.snapshot || null : null;
      result.resolveReason = retained ? evidence.resolveReason || '' : '';
      const post = await repo.get('posts', report.postId);
      result.currentPost = post && post.kind === 'post' ? { _id: post._id, status: post.status, revision: post.revision } : null;
      if (report.targetType === 'comment') {
        const comment = await repo.get('comments', report.commentId);
        result.currentComment = comment && comment.kind === 'comment' ? { _id: comment._id, status: comment.status, revision: comment.revision } : null;
      }
    }
    return { report: result };
  }
  async function resolveReport(event, openid, ownId) {
    const reportId = id(event.reportId, '举报'), expected = revision(event.revision);
    if (!['hide', 'dismiss'].includes(event.decision)) fail('INVALID_INPUT', '请选择有效的处理操作。');
    if (!Number.isSafeInteger(event.postRevision) || event.postRevision < 0) fail('INVALID_INPUT', '帖子版本无效，请刷新后再操作。');
    const reason = text(event.reason, 200, '处理说明', 2);
    // Reasons remain private but still use WeChat text moderation.
    await moderation(openid, reason);
    const at = now();
    return repo.transaction(async tx => {
      admin(await tx.get('members', ownId));
      const report = validReport(await tx.get('reports', reportId));
      verifyRevision(report, expected);
      if (report.status !== 'pending') fail('CONFLICT', '这条举报已被处理，请刷新。');
      const post = await tx.get('posts', report.postId);
      if (post && post.kind !== 'post') fail('NOT_FOUND', '帖子记录无效，请联系维护者。');
      if ((post ? post.revision : 0) !== event.postRevision) fail('CONFLICT', '帖子状态已更新，请刷新核对后再处理。');
      const target = report.targetType === 'comment' ? await tx.get('comments', report.commentId) : post;
      if (report.targetType === 'comment') {
        const expectedCommentRevision = Number.isSafeInteger(event.commentRevision) && event.commentRevision >= 0 ? event.commentRevision : -1;
        if ((target ? target.revision : 0) !== expectedCommentRevision) fail('CONFLICT', '评论状态已更新，请刷新核对。');
      }
      const evidence = await tx.get('reportEvidence', reportId);
      if (!evidence || evidence.retentionStatus === 'cleared') fail('EVIDENCE_UNAVAILABLE', '举报证据暂不可用，请联系维护者后再处理。');
      const status = !post || post.status !== 'published' || !target || target.status !== 'published' ? 'unavailable' : event.decision === 'hide' ? 'hidden' : 'dismissed';
      if (status === 'hidden') {
        // Never copy the reporter's private statement or admin free text to the author/audit.
        const fixedReason = `经人工核实，因${REPORT_REASONS[report.reasonCode]}已下架。`;
        if (report.targetType === 'comment') {
          await tx.set('comments', report.commentId, { ...target, status: 'hidden', reviewReason: fixedReason, revision: target.revision + 1, updatedAt: at });
          await tx.set('posts', post._id, { ...post, commentCount: Math.max(0, (post.commentCount || 0) - 1), revision: post.revision + 1, updatedAt: at });
        } else {
          await replacePostMediaReferences(tx, { postId: post._id, before: post.mediaIds || [], at });
          await tx.set('posts', post._id, { ...post, status: 'hidden', reviewReason: fixedReason, revision: post.revision + 1, updatedAt: at });
        }
      }
      const updated = { ...report, status, revision: report.revision + 1, updatedAt: at, resolvedAt: at, evidenceExpiresAt: at + RETENTION_MS };
      for (const mediaId of evidence.snapshot?.mediaIds || []) {
        const asset = await tx.get('media', mediaId);
        if (asset) await tx.set('media', mediaId, { ...asset, evidenceRefs: { ...(asset.evidenceRefs || {}), [reportId]: updated.evidenceExpiresAt } });
      }
      await tx.set('reportEvidence', reportId, { ...evidence, resolveReason: reason, expiresAt: updated.evidenceExpiresAt, retentionStatus: 'expiring' });
      await tx.set('reports', reportId, updated);
      await audit(tx, ownId, updated, 'resolveReport', report.status, at);
      return { report: project(updated, at) };
    });
  }
  return { reportPost, reportComment: (event, openid, ownId) => reportPost({ ...event, targetType: 'comment' }, openid, ownId), listMyReports: (event, member) => list(event, member, false), reviewReports: (event, member) => list(event, member, true), getReport, resolveReport };
}

const { cleanupExpired } = require('./report-cleanup');

module.exports = { createReportService, cleanupExpired, REPORT_REASONS, REPORT_STATES, RETENTION_MS, RESULT_LABELS };
