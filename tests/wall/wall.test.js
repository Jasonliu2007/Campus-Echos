'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWallService, APPID, memberId, hash, VERSION } = require('../../cloudfunctions/xiaopinWall/service');
const { createRepository } = require('../../cloudfunctions/xiaopinWall/repository');

const ctx = (openid = 'admin-openid') => ({ APPID, OPENID: openid });
const clone = (value) => value === undefined ? undefined : structuredClone(value);

class MemoryRepository {
  constructor() { this.tables = { posts: new Map(), members: new Map(), audit: new Map() }; this.queue = Promise.resolve(); this.failAudit = false; }
  async get(type, id) { return clone(this.tables[type].get(id) || null); }
  async transaction(work) {
    const task = this.queue.then(async () => {
      const copy = Object.fromEntries(Object.entries(this.tables).map(([type, table]) => [type, new Map([...table].map(([key, value]) => [key, clone(value)]))]));
      const result = await work({
        get: async (type, id) => clone(copy[type].get(id) || null),
        set: async (type, id, value) => { if (type === 'audit' && this.failAudit) throw new Error('audit unavailable'); copy[type].set(id, { ...clone(value), _id: id }); },
      });
      this.tables = copy;
      return result;
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async query(type, { where, cursor, limit }) {
    return [...this.tables[type].values()]
      .filter((value) => Object.entries(where).every(([key, expected]) => value[key] === expected))
      .filter((value) => !cursor || value.createdAt < cursor.createdAt || (value.createdAt === cursor.createdAt && value._id < cursor._id))
      .sort((a, b) => b.createdAt - a.createdAt || b._id.localeCompare(a._id)).slice(0, limit).map(clone);
  }
}

function fixture(options = {}) {
  const repo = options.repo || new MemoryRepository();
  let suggestion = 'pass';
  let calls = 0;
  let moderationError = false;
  const service = createWallService({
    repo, now: options.now || (() => 1794329000000), bootstrapAdminOpenid: options.bootstrap === undefined ? 'admin-openid' : options.bootstrap,
    logger: { error() {} },
    moderate: async () => { calls += 1; if (moderationError) throw new Error('offline'); return { result: { suggest: suggestion }, traceId: 'moderation-trace' }; },
  });
  const send = (action, data = {}, openid = 'admin-openid') => service({ action, ...data }, ctx(openid));
  return { repo, service, send, setSuggestion(value) { suggestion = value; }, setError(value) { moderationError = value; }, get calls() { return calls; } };
}
const payload = (index = 1) => ({ category: '学习互助', title: `复习讨论${index}`, content: '欢迎一起交流学习方法。', requestId: `request-valid-${index}` });
async function setupMember(f, openid = 'student-openid') {
  const application = await f.send('requestAccess', { nickname: '同学乙', reason: '本校同学申请参与封闭内测。' }, openid);
  assert.equal(application.ok, true);
  const approved = await f.send('reviewMember', { memberId: application.member.id, decision: 'approve', revision: application.member.revision });
  assert.equal(approved.ok, true);
  return approved.member;
}

test('context APPID and OPENID are required; client identity cannot grant access', async () => {
  const f = fixture();
  for (const context of [{}, { APPID: 'wrong', OPENID: 'admin-openid' }, { APPID }]) {
    const result = await f.service({ action: 'session', OPENID: 'admin-openid' }, context);
    assert.equal(result.code, 'UNAUTHENTICATED');
  }
  const stranger = await f.send('session', { role: 'admin', openid: 'admin-openid' }, 'stranger');
  assert.equal(stranger.access, 'none');
  assert.equal(stranger.member, null);
  assert.equal(f.repo.tables.members.size, 0);
});

test('bootstrap is explicit, transactional and one-time; no first-visitor promotion', async () => {
  const absent = fixture({ bootstrap: '' });
  assert.equal((await absent.send('session')).member, null);
  const f = fixture();
  const first = await f.send('session');
  assert.equal(first.member.role, 'admin');
  assert.equal(first.member.status, 'approved');
  assert.equal(first.version, VERSION);
  assert.equal(JSON.stringify(first).includes('admin-openid'), false);
  await Promise.all([f.send('session'), f.send('session')]);
  assert.equal(f.repo.tables.audit.size, 1);
  const changed = fixture({ repo: f.repo, bootstrap: 'second-admin' });
  assert.equal((await changed.send('session', {}, 'second-admin')).member, null);
});

test('pending, rejected, revoked and unknown members cannot read or publish', async () => {
  const f = fixture(); await f.send('session');
  for (const status of ['pending', 'rejected', 'revoked']) {
    const who = `member-${status}`;
    f.repo.tables.members.set(memberId(who), { _id: memberId(who), kind: 'member', status, role: 'member' });
    for (const action of ['list', 'getPost', 'listMine', 'publish', 'listMembers']) {
      const result = await f.send(action, payload(), who);
      assert.equal(result.code, 'ACCESS_DENIED');
    }
  }
  assert.equal((await f.send('list', {}, 'stranger')).code, 'ACCESS_DENIED');
});

test('member application is moderated and idempotent; approval grants only member', async () => {
  const f = fixture(); await f.send('session');
  const first = await f.send('requestAccess', { nickname: '同学乙', reason: '本校内测申请', role: 'admin', status: 'approved' }, 'student');
  assert.equal(first.member.status, 'pending');
  assert.equal(first.member.role, 'member');
  const repeated = await f.send('requestAccess', { nickname: '伪造修改', reason: '新的申请说明' }, 'student');
  assert.equal(repeated.member.id, first.member.id);
  assert.equal(repeated.member.nickname, '同学乙');
  assert.equal(f.calls, 1);
  const rejectedAdmin = await f.send('reviewMember', { memberId: first.member.id, decision: 'approve', revision: 1 }, 'student');
  assert.equal(rejectedAdmin.code, 'ACCESS_DENIED');
  const approved = await f.send('reviewMember', { memberId: first.member.id, decision: 'approve', revision: 1 });
  assert.equal(approved.member.status, 'approved');
  assert.equal(approved.member.role, 'member');
  assert.equal(JSON.stringify(approved).includes('openid'), false);
});

test('risky applications and malformed form data never create records', async () => {
  const f = fixture(); await f.send('session'); f.setSuggestion('risky');
  assert.equal((await f.send('requestAccess', { nickname: '同学乙', reason: '本校内测申请' }, 'student')).code, 'CONTENT_REJECTED');
  assert.equal(await f.repo.get('members', memberId('student')), null);
  assert.equal((await f.send('requestAccess', { nickname: 'a', reason: '正常说明' }, 'student')).code, 'INVALID_INPUT');
});

test('publish validates category, title, body and request id before moderation', async () => {
  const f = fixture(); await f.send('session');
  const invalid = [{ category: '任意分区' }, { title: ' ' }, { title: 'a'.repeat(61) }, { content: 'a'.repeat(2001) }, { requestId: '../path' }, { content: 'hello\u0000' }];
  for (const patch of invalid) assert.equal((await f.send('publish', { ...payload(), ...patch })).code, 'INVALID_INPUT');
  assert.equal(f.calls, 0);
  assert.equal(f.repo.tables.posts.size, 0);
  const atLimit = await f.send('publish', { ...payload(), title: '好'.repeat(60), content: '好'.repeat(2000) });
  assert.equal(atLimit.ok, true);
});

test('published posts come only from safe checks; all failure modes fail closed', async () => {
  const f = fixture(); await f.send('session');
  assert.equal((await f.send('publish', payload(1))).status, 'published');
  f.setSuggestion('review');
  assert.equal((await f.send('publish', payload(2))).status, 'pending');
  f.setSuggestion('pass');
  assert.equal((await f.send('publish', { ...payload(3), content: '有人发考试答案，想请管理员查看。' })).status, 'pending');
  f.setSuggestion('risky');
  assert.equal((await f.send('publish', payload(4))).code, 'CONTENT_REJECTED');
  f.setSuggestion('unknown');
  assert.equal((await f.send('publish', payload(5))).code, 'MODERATION_UNAVAILABLE');
  f.setError(true);
  assert.equal((await f.send('publish', payload(6))).code, 'MODERATION_UNAVAILABLE');
  assert.equal(f.repo.tables.posts.size, 3);
});

test('concurrent publish retries create one post and one audit; payload mutation conflicts', async () => {
  const f = fixture(); await f.send('session');
  const results = await Promise.all(Array.from({ length: 8 }, () => f.send('publish', payload())));
  assert.equal(results.every((x) => x.ok), true);
  assert.equal(new Set(results.map((x) => x.postId)).size, 1);
  assert.equal(f.repo.tables.posts.size, 1);
  assert.equal([...f.repo.tables.audit.values()].filter((x) => x.action === 'publish').length, 1);
  assert.equal((await f.send('publish', { ...payload(), content: '同一个请求替换内容' })).code, 'REQUEST_CONFLICT');
});

test('audit failure rolls back the entire write, including post content', async () => {
  const f = fixture(); await f.send('session'); f.repo.failAudit = true;
  const response = await f.send('publish', payload());
  assert.equal(response.code, 'SERVICE_UNAVAILABLE');
  assert.equal(f.repo.tables.posts.size, 0);
});

test('stable cursor pagination handles equal timestamps and rejects cross-filter cursor', async () => {
  const f = fixture(); await f.send('session');
  for (let i = 0; i < 45; i += 1) assert.equal((await f.send('publish', payload(i))).ok, true);
  const first = await f.send('list');
  const second = await f.send('list', { cursor: first.nextCursor });
  const third = await f.send('list', { cursor: second.nextCursor });
  assert.deepEqual([first.posts.length, second.posts.length, third.posts.length], [20, 20, 5]);
  assert.equal(new Set([...first.posts, ...second.posts, ...third.posts].map((x) => x._id)).size, 45);
  assert.equal(third.nextCursor, null);
  assert.equal((await f.send('list', { category: '学习互助', cursor: first.nextCursor })).code, 'INVALID_CURSOR');
  assert.equal((await f.send('list', { cursor: 'not-json' })).code, 'INVALID_CURSOR');
  assert.equal(JSON.stringify(first).includes('authorId'), false);
});

test('public lists exclude pending content and private detail is owner/admin only', async () => {
  const f = fixture(); await f.send('session'); await setupMember(f);
  f.setSuggestion('review');
  const pending = await f.send('publish', payload(), 'student-openid');
  assert.equal((await f.send('list')).posts.length, 0);
  assert.equal((await f.send('getPost', { postId: pending.postId }, 'student-openid')).post.isOwner, true);
  const other = await setupMemberWithSafeModeration(f, 'other-student');
  assert.equal(other.status, 'approved');
  assert.equal((await f.send('getPost', { postId: pending.postId }, 'other-student')).code, 'NOT_FOUND');
  assert.equal((await f.send('reviewList', {}, 'student-openid')).code, 'FORBIDDEN');
  assert.equal((await f.send('listMine', {}, 'student-openid')).posts.length, 1);
});

async function setupMemberWithSafeModeration(f, openid) { f.setSuggestion('pass'); return setupMember(f, openid); }

test('review rechecks safety, rejects risky content, and version conflict prevents double action', async () => {
  const f = fixture(); await f.send('session'); f.setSuggestion('review');
  const pending = await f.send('publish', payload());
  f.setSuggestion('risky');
  assert.equal((await f.send('reviewPost', { postId: pending.postId, decision: 'approve', revision: 1 })).code, 'CONTENT_REJECTED');
  assert.equal((await f.repo.get('posts', pending.postId)).status, 'rejected');
  f.setSuggestion('pass');
  assert.equal((await f.send('reviewPost', { postId: pending.postId, decision: 'approve', revision: 2 })).code, 'CONFLICT');
  f.setSuggestion('review');
  const another = await f.send('publish', payload(2));
  f.setSuggestion('pass');
  const results = await Promise.all([
    f.send('reviewPost', { postId: another.postId, decision: 'approve', revision: 1 }),
    f.send('reviewPost', { postId: another.postId, decision: 'reject', reason: '内容需要进一步完善', revision: 1 }),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.code === 'CONFLICT').length, 1);
});

test('manual approval requires an explicit pass; review, unknown and outage remain private', async () => {
  const f = fixture(); await f.send('session'); f.setSuggestion('review');
  const pending = await f.send('publish', payload());
  const auditsBefore = f.repo.tables.audit.size;
  for (const [suggestion, expectedCode] of [['review', 'POST_REVIEW_REQUIRED'], ['unknown', 'MODERATION_UNAVAILABLE']]) {
    f.setSuggestion(suggestion);
    assert.equal((await f.send('reviewPost', { postId: pending.postId, decision: 'approve', revision: 1 })).code, expectedCode);
    const saved = await f.repo.get('posts', pending.postId);
    assert.equal(saved.status, 'pending');
    assert.equal(saved.revision, 1);
    assert.equal((await f.send('list')).posts.length, 0);
    assert.equal(f.repo.tables.audit.size, auditsBefore);
  }
  f.setError(true);
  assert.equal((await f.send('reviewPost', { postId: pending.postId, decision: 'approve', revision: 1 })).code, 'MODERATION_UNAVAILABLE');
  assert.equal((await f.repo.get('posts', pending.postId)).status, 'pending');
  f.setError(false); f.setSuggestion('pass');
  const allowed = await f.send('reviewPost', { postId: pending.postId, decision: 'approve', revision: 1 });
  assert.equal(allowed.status, 'published');
  const saved = await f.repo.get('posts', pending.postId);
  assert.equal(saved.moderation, 'pass');
  assert.equal(saved.moderationTraceId, 'moderation-trace');
  assert.equal((await f.send('list')).posts.length, 1);
});

test('risky recheck is an audited terminal rejection and cannot later be approved', async () => {
  const f = fixture(); await f.send('session'); f.setSuggestion('review');
  const pending = await f.send('publish', payload());
  f.setSuggestion('risky');
  const denied = await f.send('reviewPost', { postId: pending.postId, decision: 'approve', revision: 1 });
  assert.equal(denied.code, 'CONTENT_REJECTED');
  const saved = await f.repo.get('posts', pending.postId);
  assert.equal(saved.status, 'rejected');
  assert.equal(saved.revision, 2);
  assert.equal(saved.moderation, 'risky');
  assert.equal(saved.moderationTraceId, 'moderation-trace');
  assert.equal([...f.repo.tables.audit.values()].filter(x => x.action === 'securityReject' && x.targetId === pending.postId).length, 1);
  f.setSuggestion('pass');
  assert.equal((await f.send('reviewPost', { postId: pending.postId, decision: 'approve', revision: 2 })).code, 'CONFLICT');
  assert.equal((await f.send('list')).posts.length, 0);
});

test('audit outage rolls back a risky recheck rejection as well as content changes', async () => {
  const f = fixture(); await f.send('session'); f.setSuggestion('review');
  const pending = await f.send('publish', payload());
  f.setSuggestion('risky'); f.repo.failAudit = true;
  assert.equal((await f.send('reviewPost', { postId: pending.postId, decision: 'approve', revision: 1 })).code, 'SERVICE_UNAVAILABLE');
  const saved = await f.repo.get('posts', pending.postId);
  assert.equal(saved.status, 'pending');
  assert.equal(saved.revision, 1);
  assert.equal((await f.send('list')).posts.length, 0);
});

test('author can delete, others cannot, and hidden content is excluded from public view', async () => {
  const f = fixture(); await f.send('session'); await setupMember(f);
  const post = await f.send('publish', payload(), 'student-openid');
  assert.equal((await f.send('deletePost', { postId: post.postId, revision: 1 })).code, 'FORBIDDEN');
  const hidden = await f.send('hidePost', { postId: post.postId, revision: 1, reason: '运营复核中暂时隐藏' });
  assert.equal(hidden.status, 'hidden');
  assert.equal((await f.send('list')).posts.length, 0);
  const deleted = await f.send('deletePost', { postId: post.postId, revision: 2 }, 'student-openid');
  assert.equal(deleted.status, 'deleted');
  assert.equal((await f.repo.get('posts', post.postId)).content, '');
  assert.equal((await f.send('deletePost', { postId: post.postId, revision: 2 }, 'student-openid')).ok, true);
  assert.equal((await f.send('publish', payload(), 'student-openid')).status, 'deleted');
});

test('membership revocation takes effect on next request and cannot remove initial admin', async () => {
  const f = fixture(); const session = await f.send('session'); const member = await setupMember(f);
  assert.equal((await f.send('list', {}, 'student-openid')).ok, true);
  const revoked = await f.send('reviewMember', { memberId: member.id, revision: member.revision, decision: 'revoke', reason: '本次内测结束' });
  assert.equal(revoked.member.status, 'revoked');
  assert.equal((await f.send('list', {}, 'student-openid')).code, 'ACCESS_DENIED');
  assert.equal((await f.send('reviewMember', { memberId: session.member.id, revision: session.member.revision, decision: 'revoke', reason: '尝试撤销' })).code, 'FORBIDDEN');
});

test('unknown action, malformed event and low-level errors return safe bounded responses', async () => {
  const f = fixture(); await f.send('session');
  assert.equal((await f.send('bypassAdmin')).code, 'INVALID_ACTION');
  assert.equal((await f.service(null, ctx())).code, 'INVALID_INPUT');
  const broken = createWallService({ repo: { get: async () => { throw new Error('secret database credentials'); } }, moderate: async () => ({}), logger: { error() {} } });
  const response = await broken({ action: 'list' }, ctx());
  assert.equal(response.code, 'SERVICE_UNAVAILABLE');
  assert.equal(JSON.stringify(response).includes('secret'), false);
  assert.equal(typeof response.traceId, 'string');
});

test('SDK repository preserves collection errors and uses timestamp/id cursor conjunction', async () => {
  const seen = [];
  const q = {
    doc: (id) => ({ get: async () => ({ data: id === 'missing' ? null : { title: 'sample' } }), set: async (value) => seen.push(value) }),
    where(value) { seen.push(value); return this; }, orderBy(value, direction) { seen.push([value, direction]); return this; }, limit(value) { seen.push(value); return this; }, get: async () => ({ data: [] }),
  };
  const db = { config: {}, collection: (name) => { seen.push(name); return q; }, runTransaction: (callback) => callback(db), command: { and: (...x) => ({ and: x }), or: (...x) => ({ or: x }), lt: (x) => ({ lt: x }), eq: (x) => ({ eq: x }) } };
  const repo = createRepository(db);
  assert.equal(await repo.get('posts', 'missing'), null);
  assert.equal((await repo.get('posts', 'key'))._id, 'key');
  await repo.query('posts', { where: { status: 'published' }, cursor: { createdAt: 100, _id: 'a' }, limit: 21 });
  assert.equal(seen.includes('xiaopin_trial_posts'), true);
  const condition = seen.find((x) => x && x.and);
  assert.equal(condition.and.length, 2);
  assert.equal(condition.and[1].or.length, 2);
  assert.deepEqual(condition.and[1].or[1], { createdAt: { eq: 100 }, _id: { lt: 'a' } });
  assert.equal(db.config.throwOnNotFound, false);
  await repo.transaction((tx) => tx.set('posts', 'key', { _id: 'key', title: 'written' }));
  assert.deepEqual(seen.at(-1), { data: { title: 'written' } });
});
