'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWallService, APPID, hash, memberId } = require('../../cloudfunctions/xiaopinWall/service');
const { cleanupExpired, RETENTION_MS } = require('../../cloudfunctions/xiaopinWall/reports');
const clone = value => value === undefined ? undefined : structuredClone(value);
class Repo {
  constructor() {
    this.tables = Object.fromEntries(['posts','members','audit','reports','reportEvidence','comments','media'].map(k=>[k,new Map()]));
    this.queue = Promise.resolve(); this.failType = ''; this.failKey = '';
  }
  async get(type,key) { return clone(this.tables[type].get(key)||null); }
  transaction(work) {
    const task = this.queue.then(async()=>{
      const copy = Object.fromEntries(Object.entries(this.tables).map(([k,v])=>[k,new Map([...v].map(([id,x])=>[id,clone(x)]))]));
      const result = await work({get: async(type,key)=>clone(copy[type].get(key)||null),set:async(type,key,value)=>{
        if (this.failType===type&&(!this.failKey||this.failKey===key)) throw new Error('isolated failure');
        copy[type].set(key,{...clone(value),_id:key});
      }});
      this.tables=copy;return result;
    });
    this.queue=task.catch(()=>{});return task;
  }
  async query(type,{where,cursor,limit}) {
    return [...this.tables[type].values()].filter(x=>Object.entries(where).every(([k,v])=>x[k]===v)).filter(x=>!cursor||x.createdAt<cursor.createdAt||(x.createdAt===cursor.createdAt&&x._id<cursor._id)).sort((a,b)=>b.createdAt-a.createdAt||b._id.localeCompare(a._id)).slice(0,limit).map(clone);
  }
  async queryExpiredEvidence({at,cursor,limit}) {
    return [...this.tables.reportEvidence.values()].filter(x=>x.retentionStatus==='expiring'&&x.expiresAt<=at).filter(x=>!cursor||x.expiresAt>cursor.expiresAt||(x.expiresAt===cursor.expiresAt&&x._id>cursor._id)).sort((a,b)=>a.expiresAt-b.expiresAt||a._id.localeCompare(b._id)).slice(0,limit).map(clone);
  }
}
function fixture() {
  const repo = new Repo();let at=1794370000000,suggest='pass',calls=0,moderationError=false,hook;
  const users = ['admin','author','reporter','other'];
  users.forEach(u=>repo.tables.members.set(memberId(u),{_id:memberId(u),kind:'member',openid:u,status:'approved',role:u==='admin'?'admin':'member',nickname:'测试同学',revision:1,createdAt:at,updatedAt:at}));
  const send=createWallService({repo,now:()=>at,logger:{error(){}},moderate:async()=>{calls++;if(hook){const h=hook;hook=null;await h();}if(moderationError)throw Error('moderation unavailable');return {result:{suggest},traceId:'safe-test-trace'};}});
  const call=(action,data={},who='reporter')=>send({action,...data},{APPID,OPENID:who});
  const post=(n=1,status='published')=>{const p={_id:hash('post'+n),kind:'post',authorId:memberId('author'),authorName:'作者',title:'测试标题'+n,content:'原文仅用于隔离测试。',category:'学习互助',status,revision:1,createdAt:at,updatedAt:at};repo.tables.posts.set(p._id,p);return p;};
  return {repo,call,post,time:()=>at,advance:ms=>{at+=ms;},suggest:v=>{suggest=v;},error:v=>{moderationError=v;},hook:fn=>{hook=fn;},calls:()=>calls};
}
async function submit(f,p,who='reporter',extra={}) {
  const r=await f.call('reportPost',{postId:p._id,reasonCode:'privacy',detail:'请人工核对隐私内容。',...extra},who);assert.equal(r.ok,true,JSON.stringify(r));return r.report;
}
const resolution=(report,post,decision='hide')=>({reportId:report._id,revision:report.revision,postRevision:post?post.revision:0,decision,reason:'已认真核对当时内容。'});

test('report access rejects unapproved, fake identity and ordinary admin requests',async()=>{
 const f=fixture(),p=f.post();for(const who of ['none','revoked','pending']){
  if(who!=='none')f.repo.tables.members.set(memberId(who),{kind:'member',status:who,role:'member'});
  for(const action of ['reportPost','listMyReports','getReport','reviewReports','resolveReport'])assert.equal((await f.call(action,{postId:p._id,role:'admin',OPENID:'admin'},who)).code,'ACCESS_DENIED');
 }
 assert.equal((await f.call('reviewReports')).code,'FORBIDDEN');assert.equal((await f.call('resolveReport')).code,'FORBIDDEN');
});
test('only public other-author posts may be reported; reason and Unicode detail are bounded',async()=>{
 const f=fixture();for(const status of ['pending','hidden','deleted','rejected'])assert.equal((await f.call('reportPost',{postId:f.post(status,status)._id,reasonCode:'scam'})).code,'POST_UNAVAILABLE');
 const p=f.post();assert.equal((await f.call('reportPost',{postId:p._id,reasonCode:'scam'},'author')).code,'FORBIDDEN');
 for(const data of [{reasonCode:'invalid'},{reasonCode:'other'},{reasonCode:'other',detail:'一'},{reasonCode:'abuse',detail:'🙂'.repeat(201)}])assert.equal((await f.call('reportPost',{postId:p._id,...data})).code,'INVALID_INPUT');
 assert.equal((await f.call('reportPost',{postId:p._id,reasonCode:'other',detail:'🙂🙂'})).ok,true);
});
test('submission snapshots server content and concurrent retries keep the first report',async()=>{
 const f=fixture(),p=f.post();const rs=await Promise.all(Array.from({length:5},()=>f.call('reportPost',{postId:p._id,reasonCode:'privacy',detail:'原始说明',snapshot:{title:'伪造'}})));
 assert.equal(rs.filter(x=>!x.duplicate).length,1);assert.equal(f.repo.tables.reports.size,1);assert.equal(f.repo.tables.reportEvidence.size,1);
 const report=rs[0].report,ev=await f.repo.get('reportEvidence',report._id);assert.equal(ev.snapshot.title,p.title);assert.equal(ev.detail,'原始说明');assert.equal(f.repo.tables.audit.size,1);
 p.status='hidden';f.repo.tables.posts.set(p._id,p);const again=await f.call('reportPost',{postId:p._id,reasonCode:'other',detail:'修改说明'});assert.equal(again.duplicate,true);assert.equal((await f.repo.get('reportEvidence',report._id)).detail,'原始说明');
});
test('moderation risky and exceptions never create reports; private review may enter queue',async()=>{
 const f=fixture(),p=f.post();f.suggest('risky');assert.equal((await f.call('reportPost',{postId:p._id,reasonCode:'privacy',detail:'补充文字'})).code,'CONTENT_REJECTED');f.error(true);assert.equal((await f.call('reportPost',{postId:p._id,reasonCode:'privacy',detail:'补充文字'})).code,'MODERATION_UNAVAILABLE');assert.equal(f.repo.tables.reports.size,0);f.error(false);f.suggest('review');assert.equal((await submit(f,p)).status,'pending');
});
test('submission rechecks revocation and post disappearance inside transaction',async()=>{
 const f=fixture(),p=f.post();f.hook(()=>{f.repo.tables.members.get(memberId('reporter')).status='revoked';});assert.equal((await f.call('reportPost',{postId:p._id,reasonCode:'privacy',detail:'补充说明'})).code,'ACCESS_DENIED');assert.equal(f.repo.tables.reports.size,0);
 const g=fixture(),q=g.post();g.hook(()=>{g.repo.tables.posts.get(q._id).status='deleted';});assert.equal((await g.call('reportPost',{postId:q._id,reasonCode:'privacy',detail:'补充说明'})).code,'POST_UNAVAILABLE');
});
test('evidence and identity never leak through lists, to the author, or other members',async()=>{
 const f=fixture(),p=f.post(),report=await submit(f,p);for(const who of ['author','other'])assert.equal((await f.call('getReport',{reportId:report._id},who)).code,'NOT_FOUND');
 const own=await f.call('getReport',{reportId:report._id});assert.equal(own.report.detail,'请人工核对隐私内容。');assert.equal(own.report.snapshot,undefined);assert.equal(own.report.currentPost,undefined);
 const admin=await f.call('getReport',{reportId:report._id},'admin');assert.equal(admin.report.snapshot.content,p.content);assert.equal(admin.report.currentPost.revision,1);
 for(const action of ['listMyReports','reviewReports']){const list=await f.call(action,{},action==='reviewReports'?'admin':'reporter');const str=JSON.stringify(list);for(const forbidden of ['原文仅用于','请人工核对','reporterId','authorId','openid','snapshot'])assert.equal(str.includes(forbidden),false,forbidden);}
});
test('report pagination is stable for equal times and cursor is bound to user and status',async()=>{
 const f=fixture();for(let i=0;i<23;i++)await submit(f,f.post(i));const first=await f.call('listMyReports');assert.equal(first.reports.length,20);assert.equal(first.hasMore,true);const second=await f.call('listMyReports',{cursor:first.nextCursor});assert.equal(second.reports.length,3);assert.equal(new Set(first.reports.concat(second.reports).map(x=>x._id)).size,23);assert.equal((await f.call('listMyReports',{cursor:first.nextCursor,status:'pending'})).code,'INVALID_CURSOR');assert.equal((await f.call('listMyReports',{cursor:first.nextCursor},'other')).code,'INVALID_CURSOR');
});
test('resolve hides and closes atomically, exposes fixed reason only, and rejects concurrent processing',async()=>{
 const f=fixture(),p=f.post(),report=await submit(f,p);const rs=await Promise.all([f.call('resolveReport',resolution(report,p),'admin'),f.call('resolveReport',resolution(report,p),'admin')]);assert.equal(rs.filter(x=>x.ok).length,1);assert.equal(rs.find(x=>!x.ok).code,'CONFLICT');const post=await f.repo.get('posts',p._id);assert.equal(post.status,'hidden');assert.equal(post.reviewReason.includes('请人工核对'),false);assert.equal(post.reviewReason.includes('已认真'),false);assert.equal((await f.call('list',{},'other')).posts.length,0);assert.equal((await f.call('getPost',{postId:p._id},'other')).code,'NOT_FOUND');
 const rr=await f.repo.get('reports',report._id);assert.equal(rr.evidenceExpiresAt,f.time()+RETENTION_MS);const audit=[...f.repo.tables.audit.values()];assert.equal(audit.length,2);for(const x of audit){assert.equal(x.reason,undefined);assert.equal(x.detail,undefined);assert.equal(x.snapshot,undefined);}
});
test('dismiss leaves public post intact; changes in report/post revisions cannot be overwritten',async()=>{
 const f=fixture(),p=f.post(),report=await submit(f,p);p.revision=2;f.repo.tables.posts.set(p._id,p);assert.equal((await f.call('resolveReport',resolution(report,{...p,revision:1}),'admin')).code,'CONFLICT');const res=await f.call('resolveReport',resolution(report,p,'dismiss'),'admin');assert.equal(res.report.status,'dismissed');assert.equal((await f.repo.get('posts',p._id)).status,'published');assert.equal((await f.call('resolveReport',resolution(report,p),'admin')).code,'CONFLICT');
});
test('deleted, hidden, rejected, or missing posts close unavailable and never revive content',async()=>{
 for(const state of ['deleted','hidden','rejected','missing']){const f=fixture(),p=f.post(),report=await submit(f,p);if(state==='missing')f.repo.tables.posts.delete(p._id);else{p.status=state;p.revision=2;if(state==='deleted'){p.title='';p.content='';}f.repo.tables.posts.set(p._id,p);}const res=await f.call('resolveReport',resolution(report,state==='missing'?null:p),'admin');assert.equal(res.report.status,'unavailable');const d=await f.call('getReport',{reportId:report._id},'admin');assert.equal(d.report.snapshot.title,'测试标题1');assert.equal((await f.repo.get('posts',p._id))?.status,state==='missing'?undefined:state);}
});
test('resolution rechecks role/revocation after moderation and moderation failure preserves pending',async()=>{
 const f=fixture(),p=f.post(),report=await submit(f,p);f.error(true);assert.equal((await f.call('resolveReport',resolution(report,p),'admin')).code,'MODERATION_UNAVAILABLE');f.error(false);f.suggest('risky');assert.equal((await f.call('resolveReport',resolution(report,p),'admin')).code,'CONTENT_REJECTED');f.suggest('pass');f.hook(()=>{f.repo.tables.members.get(memberId('admin')).status='revoked';});assert.equal((await f.call('resolveReport',resolution(report,p),'admin')).code,'ACCESS_DENIED');assert.equal((await f.repo.get('reports',report._id)).status,'pending');
});
test('audit outage rolls back report, evidence and post changes',async()=>{
 const f=fixture(),p=f.post();f.repo.failType='audit';assert.equal((await f.call('reportPost',{postId:p._id,reasonCode:'scam'})).code,'SERVICE_UNAVAILABLE');assert.equal(f.repo.tables.reports.size,0);assert.equal(f.repo.tables.reportEvidence.size,0);f.repo.failType='';const report=await submit(f,p);f.repo.failType='audit';assert.equal((await f.call('resolveReport',resolution(report,p),'admin')).code,'SERVICE_UNAVAILABLE');assert.equal((await f.repo.get('posts',p._id)).status,'published');assert.equal((await f.repo.get('reports',report._id)).status,'pending');assert.equal((await f.repo.get('reportEvidence',report._id)).resolveReason,'');
});
test('overdue flag begins after 24h; pending evidence has no cleanup clock',async()=>{
 const f=fixture(),p=f.post(),report=await submit(f,p);f.advance(24*3600000);const res=await f.call('reviewReports',{status:'pending'},'admin');assert.equal(res.reports[0].overdue,true);f.advance(RETENTION_MS*2);const clean=await cleanupExpired({repo:f.repo,now:f.time,logger:{error(){}}});assert.equal(clean.cleared,0);assert.ok((await f.call('getReport',{reportId:report._id},'admin')).report.snapshot);
});
test('expiry hides content at boundary before cleanup; cleanup replaces content and preserves minimal records',async()=>{
 const f=fixture(),p=f.post(),report=await submit(f,p);await f.call('resolveReport',resolution(report,p,'dismiss'),'admin');f.advance(RETENTION_MS-1);assert.ok((await f.call('getReport',{reportId:report._id},'admin')).report.snapshot);f.advance(1);for(const who of ['admin','reporter']){const d=(await f.call('getReport',{reportId:report._id},who)).report;assert.equal(d.detail,'');assert.equal(d.evidenceExpired,true);if(who==='admin'){assert.equal(d.snapshot,null);assert.equal(d.resolveReason,'');}}
 const clean=await cleanupExpired({repo:f.repo,now:f.time,logger:{error(){}}});assert.equal(clean.cleared,1);const ev=await f.repo.get('reportEvidence',report._id);for(const field of ['snapshot','detail','resolveReason','moderation'])assert.equal(ev[field],undefined);assert.equal(ev.retentionStatus,'cleared');assert.equal(f.repo.tables.reports.size,1);assert.equal(f.repo.tables.audit.size,2);assert.equal((await cleanupExpired({repo:f.repo,now:f.time})).cleared,0);assert.equal((await f.call('cleanupExpired',{now:0},'admin')).code,'INVALID_ACTION');
});
test('cleanup continues past failed rows and safely retries on the next run',async()=>{
 const f=fixture();for(let i=0;i<5;i++){const p=f.post(i),report=await submit(f,p);await f.call('resolveReport',resolution(report,p,'dismiss'),'admin');}f.advance(RETENTION_MS);const key=[...f.repo.tables.reportEvidence.keys()].sort()[1];f.repo.failType='reportEvidence';f.repo.failKey=key;const log=[];const first=await cleanupExpired({repo:f.repo,now:f.time,batchSize:2,logger:{error:(...x)=>log.push(x)}});assert.equal(first.cleared,4);assert.equal(first.failed,1);assert.ok(log.length);assert.equal((await f.repo.get('reportEvidence',key)).retentionStatus,'expiring');f.repo.failType='';const second=await cleanupExpired({repo:f.repo,now:f.time,batchSize:2});assert.equal(second.cleared,1);assert.equal(second.failed,0);
});


test('non-string private detail is rejected instead of silently omitted', async () => {
 const f=fixture(),p=f.post();
 for (const detail of [123,{},[],null]) assert.equal((await f.call('reportPost',{postId:p._id,reasonCode:'privacy',detail})).code,'INVALID_INPUT');
 assert.equal(f.repo.tables.reports.size,0);
});
test('administrator current post projection never returns raw content at any retention age',async()=>{
 const f=fixture(),p=f.post(),report=await submit(f,p);
 const before=(await f.call('getReport',{reportId:report._id},'admin')).report;
 assert.deepEqual(Object.keys(before.currentPost).sort(),['_id','revision','status']);
 await f.call('resolveReport',resolution(report,p,'dismiss'),'admin');f.advance(RETENTION_MS);
 const expired=(await f.call('getReport',{reportId:report._id},'admin')).report;
 assert.equal(expired.snapshot,null);assert.equal(expired.currentPost.content,undefined);assert.equal(expired.currentPost.title,undefined);
});
test('two reporters cannot overwrite a hide through a stale parallel dismissal',async()=>{
 const f=fixture(),p=f.post(),one=await submit(f,p),two=await submit(f,p,'other');
 assert.equal((await f.call('resolveReport',resolution(one,p),'admin')).report.status,'hidden');
 assert.equal((await f.call('resolveReport',resolution(two,p,'dismiss'),'admin')).code,'CONFLICT');
 const latest=await f.repo.get('posts',p._id);
 assert.equal((await f.call('resolveReport',resolution(two,latest,'dismiss'),'admin')).report.status,'unavailable');
 assert.equal((await f.repo.get('posts',p._id)).status,'hidden');
});
test('missing evidence prevents close and hide as one atomic unit',async()=>{
 const f=fixture(),p=f.post(),report=await submit(f,p);f.repo.tables.reportEvidence.delete(report._id);
 assert.equal((await f.call('resolveReport',resolution(report,p),'admin')).code,'EVIDENCE_UNAVAILABLE');
 assert.equal((await f.repo.get('reports',report._id)).status,'pending');assert.equal((await f.repo.get('posts',p._id)).status,'published');
});
test('cleanup metadata mismatch fails closed and database query outage rejects safely',async()=>{
 const f=fixture(),p=f.post(),report=await submit(f,p);await f.call('resolveReport',resolution(report,p,'dismiss'),'admin');f.advance(RETENTION_MS);
 f.repo.tables.reports.get(report._id).evidenceExpiresAt+=1;
 const first=await cleanupExpired({repo:f.repo,now:f.time,logger:{error(){}}});assert.equal(first.failed,1);assert.equal(first.cleared,0);
 assert.ok((await f.repo.get('reportEvidence',report._id)).snapshot);
 f.repo.tables.reports.get(report._id).evidenceExpiresAt-=1;
 assert.equal((await cleanupExpired({repo:f.repo,now:f.time})).cleared,1);
 const query=f.repo.queryExpiredEvidence;f.repo.queryExpiredEvidence=async()=>{throw new Error('temporary query failure')};
 await assert.rejects(cleanupExpired({repo:f.repo,now:f.time}),/temporary query failure/);f.repo.queryExpiredEvidence=query;
});
test('cleanup entry rejects client-forged timer events, non-timers and user-supplied time',async()=>{
 const {createCleanupHandler,TRIGGER_NAME}=require('../../cloudfunctions/xiaopinReportCleanup/handler');
 const f=fixture(),p=f.post(),report=await submit(f,p);await f.call('resolveReport',resolution(report,p,'dismiss'),'admin');
 const logger={error(){},info(){}};const timer={Type:'Timer',TriggerName:TRIGGER_NAME,now:9999999999999};
 for(const identity of [{OPENID:'admin'},{UNIONID:'someone'},{FROM_OPENID:'someone'},null,{}, {SOURCE:'wx_http'}, {SOURCE:'wx_client,scf'}, {SOURCE:'wx_trigger,scf'}, {SOURCE:'wx_trigger',OPENID:'admin'}]){
  const handle=createCleanupHandler({repo:f.repo,context:()=>identity,now:f.time,logger});assert.equal((await handle(timer)).code,'FORBIDDEN');
 }
 const handle=createCleanupHandler({repo:f.repo,context:()=>({SOURCE:'wx_trigger'}),now:f.time,logger});
 assert.equal((await handle({})).code,'INVALID_TRIGGER');assert.equal((await handle({...timer,TriggerName:'forged'})).code,'INVALID_TRIGGER');
 assert.equal((await handle(timer)).cleared,0);assert.ok((await f.repo.get('reportEvidence',report._id)).snapshot);
 f.advance(RETENTION_MS);const result=await handle(timer);assert.equal(result.ok,true);assert.equal(result.cleared,1);
});
test('real lowercase cleanup timer clears expired evidence and rejects other casing and client sources',async()=>{
 const {createCleanupHandler,TRIGGER_NAME}=require('../../cloudfunctions/xiaopinReportCleanup/handler');
 const f=fixture(),p=f.post(),report=await submit(f,p);await f.call('resolveReport',resolution(report,p,'dismiss'),'admin');f.advance(RETENTION_MS);
 const logger={error(){},info(){}};const timer={Type:'timer',TriggerName:TRIGGER_NAME};
 const handle=createCleanupHandler({repo:f.repo,context:()=>({SOURCE:'wx_trigger'}),now:f.time,logger});
 for(const Type of ['TIMER','tImEr','',null])assert.equal((await handle({...timer,Type})).code,'INVALID_TRIGGER');
 const forged=createCleanupHandler({repo:f.repo,context:()=>({SOURCE:'wx_client',OPENID:'admin'}),now:f.time,logger});
 assert.equal((await forged(timer)).code,'FORBIDDEN');assert.ok((await f.repo.get('reportEvidence',report._id)).snapshot);
 assert.equal((await handle(timer)).cleared,1);assert.equal((await f.repo.get('reportEvidence',report._id)).snapshot,undefined);
});
test('cleanup entry marks partial failure as failure, then safely completes retry',async()=>{
 const {createCleanupHandler,TRIGGER_NAME}=require('../../cloudfunctions/xiaopinReportCleanup/handler');
 const f=fixture(),p=f.post(),report=await submit(f,p);await f.call('resolveReport',resolution(report,p,'dismiss'),'admin');f.advance(RETENTION_MS);
 const handle=createCleanupHandler({repo:f.repo,context:()=>({SOURCE:'wx_trigger'}),now:f.time,logger:{error(){},info(){}}});f.repo.failType='reportEvidence';
 await assert.rejects(handle({Type:'Timer',TriggerName:TRIGGER_NAME}),{code:'CLEANUP_INCOMPLETE'});f.repo.failType='';
 assert.equal((await handle({Type:'Timer',TriggerName:TRIGGER_NAME})).cleared,1);
});
test('independent cleanup deployment shares exact worker and repository sources',()=>{
 const {readFileSync}=require('node:fs');const {resolve}=require('node:path');
 for(const name of ['report-cleanup.js','repository.js','media-lifecycle.js'])assert.equal(readFileSync(resolve(__dirname,'../../cloudfunctions/xiaopinWall',name),'utf8'),readFileSync(resolve(__dirname,'../../cloudfunctions/xiaopinReportCleanup',name),'utf8'),name);
});

test('reason categories must be canonical strings rather than coercible arrays or objects',async()=>{
 const f=fixture(),p=f.post();for(const reasonCode of [['privacy'],{code:'privacy'},null,'constructor','toString'])assert.equal((await f.call('reportPost',{postId:p._id,reasonCode})).code,'INVALID_INPUT');assert.equal(f.repo.tables.reports.size,0);
});


test('comment report snapshots only the reported text and requires current comment version',async()=>{
 const f=fixture(),p=f.post();const cid=hash('comment-private');f.repo.tables.comments.set(cid,{_id:cid,kind:'comment',postId:p._id,authorId:memberId('other'),content:'当时评论原文',status:'published',revision:1,createdAt:f.time()});
 const submit=await f.call('reportComment',{postId:p._id,targetType:'comment',commentId:cid,reasonCode:'privacy'});assert.equal(submit.ok,true,JSON.stringify(submit));
 const r=submit.report;const ev=await f.repo.get('reportEvidence',r._id);assert.equal(ev.snapshot.content,'当时评论原文');assert.equal(ev.snapshot.title,'评论举报');assert.deepEqual(ev.snapshot.mediaIds,[]);
 const admin=(await f.call('getReport',{reportId:r._id},'admin')).report;assert.equal(admin.currentComment.revision,1);assert.equal(admin.currentComment.content,undefined);
 assert.equal((await f.call('resolveReport',{...resolution(r,p),commentRevision:0},'admin')).code,'CONFLICT');
 const ok=await f.call('resolveReport',{...resolution(r,p),commentRevision:1},'admin');assert.equal(ok.report.status,'hidden');assert.equal((await f.repo.get('comments',cid)).status,'hidden');assert.equal((await f.repo.get('posts',p._id)).status,'published');
 const mine=(await f.call('getReport',{reportId:r._id})).report;assert.equal(mine.snapshot,undefined);assert.equal(mine.currentComment,undefined);
});
test('image report retains sealed references through author deletion and settlement',async()=>{
 const f=fixture(),p=f.post();const mid=hash('sealed-image');p.mediaIds=[mid];f.repo.tables.posts.set(p._id,p);f.repo.tables.media.set(mid,{kind:'media',status:'approved',fileId:'private-sealed-test',evidenceRefs:{}});
 const r=await submit(f,p);assert.equal((await f.repo.get('media',mid)).evidenceRefs[r._id],null);assert.deepEqual((await f.repo.get('reportEvidence',r._id)).snapshot.mediaIds,[mid]);
 p.status='deleted';p.title='';p.content='';p.mediaIds=[];p.revision=2;f.repo.tables.posts.set(p._id,p);
 await f.call('resolveReport',resolution(r,p),'admin');assert.equal((await f.repo.get('media',mid)).evidenceRefs[r._id],f.time()+RETENTION_MS);assert.equal((await f.call('getReport',{reportId:r._id},'admin')).report.snapshot.mediaIds[0],mid);
});

test('a banned account cannot submit a new report, but a muted member retains reporting access',async()=>{
 const f=fixture(),p=f.post();f.repo.tables.members.get(memberId('reporter')).banned=true;
 assert.equal((await f.call('reportPost',{postId:p._id,reasonCode:'privacy'})).code,'ACCOUNT_BANNED');
 f.repo.tables.members.get(memberId('reporter')).banned=false;f.repo.tables.members.get(memberId('reporter')).mutedUntil=f.time()+86400000;
 assert.equal((await f.call('reportPost',{postId:p._id,reasonCode:'privacy'})).ok,true);
});
