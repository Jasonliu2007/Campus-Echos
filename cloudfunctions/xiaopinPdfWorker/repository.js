'use strict';

const COLLECTIONS = {
  members: 'xiaopin_members', profiles: 'xiaopin_trade_profiles', materials: 'xiaopin_materials',
  versions: 'xiaopin_material_versions', uploads: 'xiaopin_trade_uploads', chunks: 'xiaopin_trade_chunks',
  orders: 'xiaopin_trade_orders', entitlements: 'xiaopin_trade_entitlements', jobs: 'xiaopin_trade_file_jobs',
  afterSales: 'xiaopin_trade_after_sales', messages: 'xiaopin_trade_messages', audit: 'xiaopin_trade_audit',
  complaints: 'xiaopin_material_complaints', evidence: 'xiaopin_trade_evidence', assets: 'xiaopin_trade_assets',
};

function createRepository(db) {
  db.config.throwOnNotFound = false;
  async function get(source, type, key) {
    const result = await source.collection(COLLECTIONS[type]).doc(key).get();
    return result.data ? { ...result.data, _id: key } : null;
  }
  async function set(source, type, key, value) {
    const data = { ...value }; delete data._id;
    await source.collection(COLLECTIONS[type]).doc(key).set({ data });
  }
  return {
    get: (type, key) => get(db, type, key),
    transaction: work => db.runTransaction(tx => work({
      get: (type, key) => get(tx, type, key), set: (type, key, value) => set(tx, type, key, value),
    })),
    async query(type, { where = {}, cursor, limit = 21 } = {}) {
      const c = db.command;
      const condition = cursor ? c.and(where, c.or({ createdAt: c.lt(cursor.createdAt) }, { createdAt: c.eq(cursor.createdAt), _id: c.lt(cursor._id) })) : where;
      return (await db.collection(COLLECTIONS[type]).where(condition).orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(limit).get()).data;
    },
  };
}
module.exports = { createRepository, COLLECTIONS };
