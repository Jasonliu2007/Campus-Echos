'use strict';

const COLLECTIONS = { materials: 'xiaopin_materials', orders: 'xiaopin_trade_orders', campusEmail: 'xiaopin_campus_email', directThreads: 'xiaopin_direct_threads', directMessages: 'xiaopin_direct_messages', posts: 'xiaopin_trial_posts', members: 'xiaopin_members', audit: 'xiaopin_moderation_audit', reports: 'xiaopin_reports', reportEvidence: 'xiaopin_report_evidence', comments: 'xiaopin_comments', likes: 'xiaopin_likes', mutations: 'xiaopin_forum_mutations', media: 'xiaopin_media', mediaTraces: 'xiaopin_media_traces', mediaCallbacks: 'xiaopin_media_callbacks' };

function createRepository(db) {
  // wx-server-sdk 3.0.1 supports this runtime option; missing documents return null,
  // while missing collections and permission failures still reject the request.
  db.config.throwOnNotFound = false;

  function reference(source, type, key) { return source.collection(COLLECTIONS[type]).doc(key); }
  async function getFrom(source, type, key) {
    const result = await reference(source, type, key).get();
    return result.data ? { ...result.data, _id: key } : null;
  }
  async function setIn(source, type, key, value) {
    const data = { ...value };
    delete data._id;
    await reference(source, type, key).set({ data });
  }
  return {
    get: (type, key) => getFrom(db, type, key),
    transaction: (work) => db.runTransaction((tx) => work({
      get: (type, key) => getFrom(tx, type, key),
      set: (type, key, value) => setIn(tx, type, key, value),
    })),
    async findDirectMembers(nickname) {
      const result = await db.collection(COLLECTIONS.members).where({ nickname, status: 'approved', kind: 'member' })
        .field({ _id: true, nickname: true, banned: true }).limit(20).get();
      return result.data;
    },
    async queryExpiredEvidence({ at, cursor, limit }) {
      const command = db.command;
      const where = { kind: 'reportEvidence', retentionStatus: 'expiring', expiresAt: command.lte(at) };
      const condition = cursor ? command.and(where, command.or(
        { expiresAt: command.gt(cursor.expiresAt) },
        { expiresAt: command.eq(cursor.expiresAt), _id: command.gt(cursor._id) },
      )) : where;
      const result = await db.collection(COLLECTIONS.reportEvidence).where(condition).orderBy('expiresAt', 'asc').orderBy('_id', 'asc').limit(limit).get();
      return result.data;
    },
    async query(type, { where, cursor, limit }) {
      const command = db.command;
      const condition = cursor ? command.and(
        where,
        command.or(
          { createdAt: command.lt(cursor.createdAt) },
          { createdAt: command.eq(cursor.createdAt), _id: command.lt(cursor._id) },
        ),
      ) : where;
      const result = await db.collection(COLLECTIONS[type]).where(condition).orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(limit).get();
      return result.data;
    },
  };
}

module.exports = { createRepository, COLLECTIONS };
