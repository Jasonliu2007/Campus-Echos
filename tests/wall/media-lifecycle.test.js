'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Repo, fixture } = require('./forum-fixture');
const { hash, memberId } = require('../../cloudfunctions/xiaopinWall/service');
const { garbageCollectMedia, replacePostMediaReferences, ORPHAN_GRACE_MS } = require('../../cloudfunctions/xiaopinWall/media-lifecycle');
const at = 1794502000000;
const asset = (key, patch = {}) => ({_id:key, kind:'media', ownerId:memberId('author'), status:'approved', fileId:'cloud://isolated/'+key, sha256:'f'.repeat(64), traceId:'security-trace', moderationVersion:1, createdAt:at-ORPHAN_GRACE_MS, updatedAt:at-ORPHAN_GRACE_MS, postRefs:{}, evidenceRefs:{}, ...patch});

test('post, active evidence and database references prevent physical deletion', async () => {
  const repo = new Repo(); const ids = ['post','pending-evidence','active-reference','expired-evidence'].map(hash);
  ids.forEach(key=>repo.tables.media.set(key,asset(key)));
  repo.tables.posts.set(hash('post'), {_id:hash('post'),kind:'post',status:'published',createdAt:1,mediaIds:[ids[0]]});
  repo.tables.reportEvidence.set(hash('pending'), {_id:hash('pending'),kind:'reportEvidence',retentionStatus:'pending',expiresAt:null,createdAt:1,snapshot:{mediaIds:[ids[1]]}});
  repo.tables.media.get(ids[2]).evidenceRefs = {[hash('report')]:null};
  repo.tables.reportEvidence.set(hash('expired'), {_id:hash('expired'),kind:'reportEvidence',retentionStatus:'expiring',expiresAt:at,createdAt:1,snapshot:{mediaIds:[ids[3]]}});
  const removed=[]; const result = await garbageCollectMedia({repo,at,storage:{delete:async files=>removed.push(...files)}});
  assert.equal(result.deleted,1); assert.deepEqual(removed,['cloud://isolated/'+ids[3]]);
  assert.equal((await repo.get('media',ids[3])).fileId,undefined);
  for (const key of ids.slice(0,3)) assert.equal((await repo.get('media',key)).status,'approved');
});

test('storage failure stays locked, rejects new post references, and safely retries', async () => {
  const repo = new Repo(), key=hash('retry-file'); repo.tables.media.set(key,asset(key));
  const first = await garbageCollectMedia({repo,at,storage:{delete:async()=>{throw Error('network');}},logger:{error(){}}});
  assert.equal(first.failed,1); assert.equal((await repo.get('media',key)).status,'deleting');
  await assert.rejects(repo.transaction(tx=>replacePostMediaReferences(tx,{postId:hash('new-post'),after:[key],at})), e=>e.code==='MEDIA_NOT_APPROVED');
  const next=await garbageCollectMedia({repo,at,storage:{delete:async()=>{}}});
  assert.equal(next.deleted,1); assert.equal((await repo.get('media',key)).status,'deleted');
});

test('a post reference added after candidate scan wins before the deletion lock', async () => {
  const repo = new Repo(), key=hash('concurrent-reference'); repo.tables.media.set(key,asset(key));
  const query=repo.query.bind(repo); let changed=false;
  repo.query=async(type,options)=>{const rows=await query(type,options);if(type==='media'&&!changed){changed=true;await repo.transaction(tx=>replacePostMediaReferences(tx,{postId:hash('racing-post'),after:[key],at}));}return rows;};
  let calls=0;const result=await garbageCollectMedia({repo,at,storage:{delete:async()=>{calls++;}}});
  assert.equal(calls,0); assert.equal(result.deleted,0); assert.equal((await repo.get('media',key)).status,'approved');
});

test('new orphan uploads have a grace period; retired files are removed with the asset', async () => {
  const repo = new Repo(), fresh=hash('fresh'), stale=hash('stale');
  repo.tables.media.set(fresh,asset(fresh,{createdAt:at-ORPHAN_GRACE_MS+1}));
  repo.tables.media.set(stale,asset(stale,{retiredFileIds:['cloud://isolated/prior-upload']}));
  let removed=[];await garbageCollectMedia({repo,at,storage:{delete:async files=>{removed.push(...files);}}});
  assert.equal((await repo.get('media',fresh)).status,'approved');
  assert.deepEqual(new Set(removed),new Set(['cloud://isolated/'+stale,'cloud://isolated/prior-upload']));
});

test('publish, edit and delete maintain media references and erase deleted search text', async () => {
  const f=fixture();const first=hash('first-image'),next=hash('next-image');
  f.repo.tables.media.set(first,asset(first));f.repo.tables.media.set(next,asset(next));
  const pub=await f.call('publish',{category:'校园生活墙',title:'原始标题',content:'需要清除的原文',requestId:'media-post-reference',mediaIds:[first]});
  assert.equal(pub.ok,true);assert.equal((await f.repo.get('media',first)).postRefs[pub.postId],true);
  const edit=await f.call('editPost',{postId:pub.postId,revision:1,category:'校园生活墙',title:'更新标题',content:'更新正文',requestId:'media-edit-reference',mediaIds:[next]});
  assert.equal(edit.ok,true);assert.deepEqual((await f.repo.get('media',first)).postRefs,{});assert.equal((await f.repo.get('media',next)).postRefs[pub.postId],true);
  await f.call('deletePost',{postId:pub.postId,revision:2});
  const deleted=await f.repo.get('posts',pub.postId);assert.equal(deleted.title,'');assert.deepEqual(deleted.mediaIds,[]);
  assert.equal(JSON.stringify(deleted.searchFields).includes('更新正文'),false);assert.deepEqual((await f.repo.get('media',next)).postRefs,{});
});

test('old upload retries retain a fresh grace period and active upload lease',async()=>{
 const repo=new Repo(),fresh=hash('old-retry-fresh'),busy=hash('old-retry-busy');
 repo.tables.media.set(fresh,asset(fresh,{updatedAt:at-1}));
 repo.tables.media.set(busy,asset(busy,{status:'uploading',uploadLeaseUntil:at+1,gcCandidateAt:at-1}));
 let calls=0;const r=await garbageCollectMedia({repo,at,storage:{delete:async()=>{calls++;}}});
 assert.equal(r.deleted,0);assert.equal(calls,0);
});
