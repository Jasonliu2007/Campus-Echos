'use strict';
const { createWallService, APPID, memberId, hash } = require('../../cloudfunctions/xiaopinWall/service');
const clone = x => structuredClone(x);
class Repo {
  constructor() { this.tables = Object.fromEntries(['posts','members','audit','reports','reportEvidence','comments','likes','mutations','media','mediaTraces','mediaCallbacks','directThreads','directMessages','campusEmail','materials','orders'].map(k => [k,new Map()])); this.queue = Promise.resolve(); this.failType = ''; }
  async get(type,key) { return clone(this.tables[type].get(key) || null); }
  transaction(work) {
    const next = this.queue.then(async () => {
      const tables = Object.fromEntries(Object.entries(this.tables).map(([k,v]) => [k,new Map([...v].map(([id,r]) => [id,clone(r)]))]));
      const result = await work({ get: async (type,key) => clone(tables[type].get(key) || null), set: async (type,key,row) => { if(type === this.failType) throw Error('isolated write outage'); tables[type].set(key,{...clone(row),_id:key}); } });
      this.tables = tables; return result;
    }); this.queue = next.catch(() => {}); return next;
  }
  async findDirectMembers(nickname) { return [...this.tables.members.values()].filter(row => row.nickname === nickname && row.status === 'approved'); }
  async query(type,{where,cursor,limit}) { return [...this.tables[type].values()].filter(r => Object.entries(where).every(([k,v]) => r[k] === v)).filter(r => !cursor || r.createdAt < cursor.createdAt || r.createdAt === cursor.createdAt && r._id < cursor._id).sort((a,b) => b.createdAt-a.createdAt || b._id.localeCompare(a._id)).slice(0,limit).map(clone); }
}
function fixture(options = {}) {
  const repo = new Repo(); let clock=1794502000000, suggest='pass', hook, error=false, sequence=[];
  for(const who of ['admin','author','other']) repo.tables.members.set(memberId(who),{_id:memberId(who),kind:'member',openid:who,nickname:`真实昵称-${who}`,status:'approved',role:who==='admin'?'admin':'member',revision:1,createdAt:clock,updatedAt:clock});
  repo.tables.members.set('__bootstrap_admin_v1',{kind:'bootstrap',memberId:memberId('admin')});
  const service = createWallService({repo, now:()=>clock, moderate:async()=>{if(hook){const h=hook;hook=undefined;await h();} if(error)throw Error('offline');return {result:{suggest:sequence.length ? sequence.shift() : suggest},traceId:'text-trace'};},logger:{error(){}},...options});
  const call=(action,event={},who='author')=>service({action,...event},{APPID,OPENID:who});
  const post=(n=1,patch={})=>{const row={_id:hash(`post-${n}`),kind:'post',authorId:memberId('author'),authorName:'真实昵称-author',title:`学习经验${n}`,content:'学习方法和准备经历',category:'校园生活墙',community:'forum',isAnonymous:false,status:'published',revision:1,createdAt:clock,updatedAt:clock,...patch};repo.tables.posts.set(row._id,row);return row;};
  return {repo,call,post,time:()=>clock,advance:n=>{clock+=n;},suggest:v=>{suggest=v;},sequence:v=>{sequence=v;},error:v=>{error=v;},hook:f=>{hook=f;}};
}
module.exports = { Repo, fixture };
