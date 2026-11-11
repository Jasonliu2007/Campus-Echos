'use strict';

const COLLECTIONS = { posts: 'xiaopin_trial_posts', members: 'xiaopin_members', audit: 'xiaopin_moderation_audit' };

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
