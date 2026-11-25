'use strict';
const { createTradeService, APPID, memberId, key } = require('../../cloudfunctions/xiaopinTrade/service');
const { createWorker, TRIGGER_NAME } = require('../../cloudfunctions/xiaopinPdfWorker/worker');
const { COLLECTIONS } = require('../../cloudfunctions/xiaopinTrade/repository');
const clone = value => value === undefined ? undefined : structuredClone(value);
class MemoryRepository {
  constructor() { this.tables = Object.fromEntries(Object.keys(COLLECTIONS).map(t => [t, new Map()])); this.queue = Promise.resolve(); this.failAudit = false; this.beforeTransaction = null; }
  async get(type, id) { return clone(this.tables[type].get(id) || null); }
  transaction(work) {
    const promise = this.queue.then(async () => {
      if (this.beforeTransaction) { const hook = this.beforeTransaction; this.beforeTransaction = null; await hook(); }
      const copy = Object.fromEntries(Object.entries(this.tables).map(([t, rows]) => [t, new Map([...rows].map(([k, value]) => [k, clone(value)]))]));
      const result = await work({ get: async (t, k) => clone(copy[t].get(k) || null), set: async (t, k, value) => { if (t === 'audit' && this.failAudit) throw Error('isolated failure'); copy[t].set(k, { ...clone(value), _id: k }); } });
      this.tables = copy; return result;
    });
    this.queue = promise.catch(() => {}); return promise;
  }
  async query(type, { where = {}, cursor, limit = 21 } = {}) {
    return [...this.tables[type].values()].filter(row => Object.entries(where).every(([field, expected]) => row[field] === expected)).filter(row => !cursor || row.createdAt < cursor.createdAt || (row.createdAt === cursor.createdAt && row._id < cursor._id)).sort((a, b) => b.createdAt - a.createdAt || b._id.localeCompare(a._id)).slice(0, limit).map(clone);
  }
}
function fixture(options = {}) {
  const repo = new MemoryRepository(), files = new Map(), signed = [], deleted = [];
  let time = 1794500000000, verdict = 'pass', deleteFailure = false;
  const now = () => time;
  const storage = {
    reserve: async path => `cloud://test/${path}`,
    put: async (path, bytes) => { const fileId = `cloud://test/${path}`; files.set(fileId, Buffer.from(bytes)); return fileId; },
    get: async id => { if (!files.has(id)) throw Error('FILE_MISSING'); return Buffer.from(files.get(id)); },
    sign: async (id, age) => { if (!files.has(id)) throw Error('FILE_MISSING'); signed.push({ id, age }); return `https://private.invalid/${key(id)}`; },
    remove: async id => { if (deleteFailure) throw Error('isolated deletion failure'); files.delete(id); deleted.push(id); },
  };
  const service = createTradeService({ repo, storage, now, paidEnabled: options.paidEnabled || false, sellerFeePayment: options.sellerFeePayment, logger: { error() {} }, moderate: async () => { if (verdict === 'exception') throw Error('unavailable'); return { result: { suggest: verdict }, traceId: 'isolated-safe-check' }; } });
  const call = (action, data = {}, who = 'buyer') => service({ action, ...data }, { OPENID: who, APPID });
  const seed = (who, status = 'approved', role = 'member') => { const row = { _id: memberId(who), kind: 'member', openid: who, nickname: who, status, role, revision: 1, createdAt: time, updatedAt: time }; repo.tables.members.set(row._id, row); return row; };
  seed('buyer'); seed('seller'); seed('admin', 'approved', 'admin'); seed('stranger');
  async function adult(who = 'buyer') { return call('confirmAdult', { adultConfirmed: true, termsAccepted: true }, who); }
  function published(priceCents = 0) {
    const materialId = key('material'), versionId = key('version'), sourceFileId = 'cloud://test/source';
    files.set(sourceFileId, Buffer.from('%PDF-isolated-source'));
    const material = { _id: materialId, kind: 'material', sellerId: memberId('seller'), title: '数学学习笔记', course: '微积分', type: '课程笔记', description: '逐章复习知识点', learningModes: ['系统复习'], catalog: [{ title: '第一章', page: 1 }], status: 'published', currentVersionId: versionId, pageCount: 2, priceCents, revision: 1, createdAt: time, updatedAt: time };
    const version = { _id: versionId, kind: 'materialVersion', materialId, sellerId: memberId('seller'), status: 'approved', sha256: require('crypto').createHash('sha256').update(files.get(sourceFileId)).digest('hex'), sourceFileId, previewFileId: 'cloud://test/preview', previewPages: [1], catalog: material.catalog, pageCount: 2, createdAt: time };
    files.set(version.previewFileId, Buffer.from('%PDF-preview')); repo.tables.materials.set(materialId, material); repo.tables.versions.set(versionId, version);
    return { material, version, materialId, versionId };
  }
  const worker = runPdf => createWorker({ repo, storage, now, runPdf: runPdf || (async () => { throw Error('not configured'); }), context: () => ({ SOURCE: 'wx_trigger' }), logger: { error() {}, info() {} } });
  return { repo, files, signed, deleted, storage, service, call, seed, adult, published, worker, timer: { Type: 'Timer', TriggerName: TRIGGER_NAME }, now, advance: value => { time += value; }, verdict: value => { verdict = value; }, failDelete: value => { deleteFailure = value; } };
}
module.exports = { MemoryRepository, fixture, clone };
