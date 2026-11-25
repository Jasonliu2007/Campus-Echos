'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWallService, APPID, VERSION, memberId } = require('../../cloudfunctions/xiaopinWall/service');

const clone = value => value === undefined ? undefined : structuredClone(value);
class MemoryRepository {
  constructor() {
    this.tables = Object.fromEntries(['posts', 'members', 'audit', 'reports', 'reportEvidence'].map(type => [type, new Map()]));
    this.queue = Promise.resolve();
    this.failAudit = false;
    this.beforeTransaction = null;
  }
  async get(type, key) { return clone(this.tables[type].get(key) || null); }
  transaction(work) {
    const task = this.queue.then(async () => {
      if (this.beforeTransaction) {
        const hook = this.beforeTransaction;
        this.beforeTransaction = null;
        await hook();
      }
      const copy = Object.fromEntries(Object.entries(this.tables).map(([type, table]) => [type, new Map([...table].map(([key, value]) => [key, clone(value)]))]));
      const result = await work({
        get: async (type, key) => clone(copy[type].get(key) || null),
        set: async (type, key, value) => {
          if (type === 'audit' && this.failAudit) throw new Error('isolated audit failure');
          copy[type].set(key, { ...clone(value), _id: key });
        },
      });
      this.tables = copy;
      return result;
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async query(type, { where, cursor, limit }) {
    return [...this.tables[type].values()]
      .filter(value => Object.entries(where).every(([key, expected]) => value[key] === expected))
      .filter(value => !cursor || value.createdAt < cursor.createdAt || (value.createdAt === cursor.createdAt && value._id < cursor._id))
      .sort((a, b) => b.createdAt - a.createdAt || b._id.localeCompare(a._id)).slice(0, limit).map(clone);
  }
}

async function fixture() {
  const repo = new MemoryRepository();
  let moderationHook;
  const service = createWallService({
    repo, bootstrapAdminOpenid: 'initial-owner', now: () => 1794400000000,
    logger: { error() {} },
    moderate: async () => {
      if (moderationHook) {
        const hook = moderationHook;
        moderationHook = null;
        await hook();
      }
      return { result: { suggest: 'pass' }, traceId: 'isolated-safe-check' };
    },
  });
  const call = (action, data = {}, who = 'initial-owner') => service({ action, ...data }, { APPID, OPENID: who });
  await call('session');
  function seed(who, status = 'approved', role = 'member') {
    const record = { _id: memberId(who), kind: 'member', openid: who, nickname: '测试成员', reason: '本校同学申请内测', role, status, revision: 1, createdAt: 1794399000000, updatedAt: 1794399000000 };
    repo.tables.members.set(record._id, record);
    return clone(record);
  }
  const role = (who, value, revision = 1, actor = 'initial-owner') => call('setMemberRole', { memberId: memberId(who), role: value, revision }, actor);
  return { repo, service, call, seed, role, hookModeration: hook => { moderationHook = hook; } };
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('session authenticates trusted WeChat identity and only the initial owner can delegate', async () => {
  const f = await fixture();
  const owner = await f.call('session');
  assert.equal(owner.authenticated, true);
  assert.equal(owner.canManageAdmins, true);
  assert.equal(owner.version, VERSION);
  const stranger = await f.call('session', { role: 'admin', canManageAdmins: true, OPENID: 'initial-owner' }, 'stranger');
  assert.equal(stranger.authenticated, true);
  assert.equal(stranger.canManageAdmins, false);
  assert.equal(stranger.member, null);
  assert.equal(stranger.access, 'none');
  assert.equal(JSON.stringify(owner).includes('initial-owner'), false);
  const forged = await f.service({ action: 'session', OPENID: 'initial-owner' }, { APPID });
  assert.equal(forged.code, 'UNAUTHENTICATED');
  assert.notEqual(forged.authenticated, true);
});

test('owner grant is available at the same account next session with no second login', async () => {
  const f = await fixture(); const member = f.seed('delegate');
  assert.equal((await f.call('reviewList', {}, 'delegate')).code, 'FORBIDDEN');
  const granted = await f.role('delegate', 'admin');
  assert.equal(granted.ok, true);
  assert.equal(granted.member.role, 'admin');
  assert.equal(granted.member.revision, member.revision + 1);
  const session = await f.call('session', {}, 'delegate');
  assert.equal(session.authenticated, true);
  assert.equal(session.member.role, 'admin');
  assert.equal(session.canManageAdmins, false);
  assert.equal((await f.call('reviewList', {}, 'delegate')).ok, true);
  const audit = [...f.repo.tables.audit.values()].find(row => row.action === 'setMemberRole');
  assert.equal(audit.actorId, memberId('initial-owner'));
  assert.equal(audit.targetId, memberId('delegate'));
  assert.equal(audit.from, 'member'); assert.equal(audit.to, 'admin');
  assert.equal(audit.reason, '');
  assert.equal(JSON.stringify(granted).includes('openid'), false);
});

test('ordinary and delegated administrators cannot grant, revoke or self-promote', async () => {
  const f = await fixture(); f.seed('delegate'); f.seed('other');
  assert.equal((await f.role('delegate', 'admin', 1, 'delegate')).code, 'FORBIDDEN');
  await f.role('delegate', 'admin');
  for (const target of ['other', 'delegate', 'initial-owner']) {
    const record = await f.repo.get('members', memberId(target));
    for (const role of ['admin', 'member']) {
      assert.equal((await f.role(target, role, record.revision, 'delegate')).code, 'FORBIDDEN');
    }
  }
  assert.equal((await f.repo.get('members', memberId('other'))).role, 'member');
});

test('original owner cannot be modified and a changed bootstrap setting cannot transfer authority', async () => {
  const f = await fixture();
  assert.equal((await f.role('initial-owner', 'member')).code, 'FORBIDDEN');
  f.seed('delegate'); await f.role('delegate', 'admin');
  const changed = createWallService({ repo: f.repo, bootstrapAdminOpenid: 'delegate', logger: { error() {} }, moderate: async () => ({ result: { suggest: 'pass' } }) });
  const session = await changed({ action: 'session' }, { APPID, OPENID: 'delegate' });
  assert.equal(session.canManageAdmins, false);
  assert.equal((await f.repo.get('members', '__bootstrap_admin_v1')).memberId, memberId('initial-owner'));
  f.repo.tables.members.delete('__bootstrap_admin_v1');
  assert.equal((await f.role('delegate', 'member', 2)).code, 'FORBIDDEN');
});

test('unapproved targets, invalid roles and stale revisions cannot change permissions', async () => {
  const f = await fixture();
  for (const status of ['pending', 'rejected', 'revoked']) {
    f.seed(status, status);
    assert.equal((await f.role(status, 'admin')).code, 'ACCESS_DENIED');
    assert.equal((await f.repo.get('members', memberId(status))).role, 'member');
  }
  f.seed('delegate');
  assert.equal((await f.role('delegate', 'owner')).code, 'INVALID_INPUT');
  assert.equal((await f.role('delegate', 'admin', 99)).code, 'CONFLICT');
  assert.equal((await f.role('missing', 'admin')).code, 'NOT_FOUND');
  assert.equal((await f.call('setMemberRole', { memberId: '__bootstrap_admin_v1', role: 'member', revision: 1 })).code, 'INVALID_INPUT');
});

test('revoking delegated role takes effect on every management request', async () => {
  const f = await fixture(); f.seed('delegate'); await f.role('delegate', 'admin');
  assert.equal((await f.role('delegate', 'member', 2)).ok, true);
  for (const action of ['reviewList', 'reviewPost', 'hidePost', 'listMembers', 'reviewMember', 'reviewReports', 'resolveReport', 'setMemberRole']) {
    const result = await f.call(action, { role: 'admin', memberId: memberId('delegate'), revision: 3 }, 'delegate');
    assert.equal(result.code, 'FORBIDDEN', action);
  }
  assert.equal((await f.call('session', {}, 'delegate')).member.role, 'member');
  assert.equal((await f.call('list', {}, 'delegate')).ok, true);
});

test('concurrent role changes use revision and cannot overwrite the completed result', async () => {
  const f = await fixture(); f.seed('delegate');
  const results = await Promise.all([f.role('delegate', 'admin'), f.role('delegate', 'admin')]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.filter(result => result.code === 'CONFLICT').length, 1);
  assert.equal((await f.repo.get('members', memberId('delegate'))).revision, 2);
  assert.equal([...f.repo.tables.audit.values()].filter(row => row.action === 'setMemberRole').length, 1);
});

test('audit write failure rolls back role and revision before a safe retry', async () => {
  const f = await fixture(); const original = f.seed('delegate');
  f.repo.failAudit = true;
  assert.equal((await f.role('delegate', 'admin')).code, 'SERVICE_UNAVAILABLE');
  assert.deepEqual(await f.repo.get('members', original._id), original);
  assert.equal([...f.repo.tables.audit.values()].filter(row => row.action === 'setMemberRole').length, 0);
  f.repo.failAudit = false;
  assert.equal((await f.role('delegate', 'admin')).ok, true);
});

test('delegation rechecks actor status and owner lock inside the transaction', async () => {
  const f = await fixture(); f.seed('delegate');
  f.repo.beforeTransaction = () => { f.repo.tables.members.get(memberId('initial-owner')).status = 'revoked'; };
  assert.equal((await f.role('delegate', 'admin')).code, 'ACCESS_DENIED');
  assert.equal((await f.repo.get('members', memberId('delegate'))).role, 'member');
  const g = await fixture(); g.seed('delegate');
  g.repo.beforeTransaction = () => { g.repo.tables.members.get('__bootstrap_admin_v1').memberId = memberId('different-owner'); };
  assert.equal((await g.role('delegate', 'admin')).code, 'FORBIDDEN');
});

test('member approval in progress cannot commit after the administrator role is revoked', async () => {
  const f = await fixture(); f.seed('delegate'); f.seed('pending-student', 'pending');
  await f.role('delegate', 'admin');
  const entered = deferred(), release = deferred();
  f.hookModeration(async () => { entered.resolve(); await release.promise; });
  const approval = f.call('reviewMember', { memberId: memberId('pending-student'), revision: 1, decision: 'approve' }, 'delegate');
  await entered.promise;
  assert.equal((await f.role('delegate', 'member', 2)).ok, true);
  release.resolve();
  assert.equal((await approval).code, 'FORBIDDEN');
  assert.equal((await f.repo.get('members', memberId('pending-student'))).status, 'pending');
});

test('active administrator status cannot be altered by membership review', async () => {
  const f = await fixture(); f.seed('delegate'); await f.role('delegate', 'admin');
  const direct = await f.call('reviewMember', { memberId: memberId('delegate'), revision: 2, decision: 'revoke', reason: '测试撤销资格' });
  assert.equal(direct.code, 'FORBIDDEN');
  assert.match(direct.message, /取消.*管理员/);
  assert.equal((await f.repo.get('members', memberId('delegate'))).status, 'approved');
  await f.role('delegate', 'member', 2);
  const revoked = await f.call('reviewMember', { memberId: memberId('delegate'), revision: 3, decision: 'revoke', reason: '测试撤销资格' });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.member.status, 'revoked');
  assert.equal((await f.call('listMembers', {}, 'delegate')).code, 'ACCESS_DENIED');
});
