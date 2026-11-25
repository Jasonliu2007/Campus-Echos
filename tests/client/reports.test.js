const test=require('node:test');
const assert=require('node:assert/strict');
const {runtime,tick,event,input}=require('./runtime');
const ID='1234567890abcdef1234567890abcdef';
const session={access:'approved',member:{role:'admin'}};
function form(r){const p=r.page('report-post/index');p.onLoad({id:ID});p._visible=true;p._epoch=1;p.setData({allowed:true,loading:false,post:{title:'公开帖子',status:'published',isOwner:false}});return p;}
function admin(r){const p=r.page('admin-reports/detail');p.onLoad({id:ID});p._visible=true;p._epoch=1;p.setData({allowed:true,loading:false,report:{_id:ID,status:'pending',revision:1,currentPost:{status:'published',revision:4}},reason:'核实后处理',reasonCount:5});return p;}
async function openDetail(r,p,report){const done=p.onShow();r.requests.shift().resolve(session);await tick();r.requests.shift().resolve({report});await done;}

test('举报校验支持Unicode，其他必填，失败输入保留且连点只发一次',async()=>{
 const r=runtime(),p=form(r);await p.submit();assert.match(p.data.fieldError,/原因/);p.choose(event({value:'other'}));p.input(input('', '一'));await p.submit();assert.match(p.data.fieldError,/2–200/);p.input(input('','🙂'.repeat(201)));await p.submit();assert.equal(r.requests.length,0);assert.match(p.data.fieldError,/200/);p.input(input('','需要核实'));const one=p.submit(),two=p.submit();assert.equal(r.requests.length,1);r.requests.shift().reject(Error('timeout'));await Promise.all([one,two]);assert.equal(p.data.detail,'需要核实');assert.equal(p.data.reasonCode,'other');assert.equal(p.data.submitting,false);assert.match(p.data.error,/连接/);
});
test('举报超时重试返回既有记录，不覆盖原原因；不向本机存储证据',async()=>{
 const r=runtime(),p=form(r);p.choose(event({value:'privacy'}));p.input(input('','请核对'));const d=p.submit();const req=r.requests.shift();assert.equal(req.data.action,'reportPost');req.resolve({report:{_id:ID,status:'pending'},duplicate:true});await d;assert.equal(p.data.result.duplicate,true);assert.equal(r.storage.size,0);p.result();assert.match(r.navigation[0].options.url,/my-reports\/detail/);assert.ok(r.state.alertsDisabled);
});
test('举报离开需确认，取消保留输入；资格被撤销停止提交',async()=>{
 const r=runtime(),p=form(r);p.choose(event({value:'privacy'}));p.input(input('','请核对'));let d=p.cancel();r.modals.shift().success({confirm:false});await d;assert.equal(r.navigation.length,0);assert.equal(p.data.detail,'请核对');d=p.submit();r.requests.shift().resolve({ok:false,code:'ACCESS_DENIED',message:'资格失效'});await d;assert.equal(p.data.allowed,false);assert.equal(p.data.detail,'请核对');await p.submit();assert.equal(r.requests.length,0);d=p.cancel();r.modals.shift().success({confirm:true});await d;assert.equal(r.navigation.length,1);
});
test('举报页面隐藏后晚返回不能改结果或清输入',async()=>{
 const r=runtime(),p=form(r);p.choose(event({value:'privacy'}));const d=p.submit(),req=r.requests.shift();p.onHide();req.resolve({report:{_id:ID,status:'pending'}});await d;assert.equal(p.data.result,null);assert.equal(p.data.post,null);
});
test('管理员说明需2字，确认时连点锁定；取消不写',async()=>{
 const r=runtime(),p=admin(r);p.input(input('','一'));await p.decide();assert.match(p.data.reasonError,/2–200/);p.input(input('','已核对原文'));const d=p.decide();await p.decide();assert.equal(r.modals.length,1);assert.equal(r.requests.length,0);r.modals.shift().success({confirm:false});await d;assert.equal(r.requests.length,0);assert.equal(p.data.reason,'已核对原文');
});
test('管理员处理冲突保留输入，刷新后用新版本重新确认',async()=>{
 const r=runtime(),p=admin(r);let d=p.decide();r.modals.shift().success({confirm:true});await tick();assert.equal(r.requests[0].data.postRevision,4);r.requests.shift().resolve({ok:false,code:'CONFLICT',message:'版本变化'});await d;assert.equal(p.data.conflict,true);assert.equal(p.data.reason,'核实后处理');await p.decide();assert.equal(r.modals.length,0);
 d=p.refreshConflict();r.requests.shift().resolve(session);await tick();r.requests.shift().resolve({report:{_id:ID,status:'pending',revision:2,currentPost:{status:'hidden',revision:5}}});await d;assert.equal(p.data.conflict,false);assert.equal(p.data.reason,'核实后处理');d=p.decide();assert.match(r.modals[0].content,/内容已不可见并结案/);r.modals.shift().success({confirm:true});await tick();const req=r.requests.shift();assert.equal(req.data.revision,2);assert.equal(req.data.postRevision,5);req.reject(Error('offline'));await d;assert.equal(p.data.reason,'核实后处理');assert.equal(p.data.processing,false);
});
test('管理员返回取消保留处理说明，隐藏页清私有视图，晚返回不覆盖',async()=>{
 const r=runtime(),p=admin(r);let d=p.back();r.modals.shift().success({confirm:false});await d;assert.equal(p.data.reason,'核实后处理');assert.equal(r.navigation.length,0);d=p.decide();r.modals.shift().success({confirm:true});await tick();const req=r.requests.shift();p.onHide();req.resolve({report:{status:'hidden'}});await d;assert.equal(p.data.report,null);assert.equal(p.data.reason,'核实后处理');assert.equal(r.requests.length,0);
});
test('证据到期渲染清空自由文本与快照，当前帖也不展示原文',()=>{
 const r=runtime(),R=r.load('utils/reports.js');
 // Use the runtime clock for both input and comparison; host wall time can move
 // while the isolated runtime remains frozen, especially during parallel tests.
 for(const offset of [-1,0,1]) {
  const d=R.format({_id:ID,status:'hidden',reasonCode:'privacy',evidenceExpiresAt:r.now()+offset,detail:'私有举报说明',resolveReason:'私有处理说明',snapshot:{title:'原文'}});
  if(offset<=0) { assert.equal(d.detail,'');assert.equal(d.resolveReason,'');assert.equal(d.snapshot,null);assert.equal(d.evidenceExpired,true); }
  else { assert.equal(d.detail,'私有举报说明');assert.equal(d.resolveReason,'私有处理说明');assert.equal(d.snapshot.title,'原文');assert.notEqual(d.evidenceExpired,true); }
 }
});
test('当前详情打开期间证据到期清除显示，卸载取消计时',async()=>{
 const r=runtime(),p=r.page('admin-reports/detail');p.onLoad({id:ID});await openDetail(r,p,{_id:ID,status:'hidden',reasonCode:'privacy',evidenceExpiresAt:r.now()+10000,detail:'私有说明',snapshot:{title:'快照'}});assert.equal(p.data.report.detail,'私有说明');p.onHide();assert.equal(p.data.report,null);r.advance(10000);assert.equal(p.data.report,null);
});
test('举报列表快切筛选不会被旧请求覆盖，隐藏时晚返回无效',async()=>{
 const r=runtime(),p=r.page('my-reports/index');p._visible=true;p._epoch=1;p.setData({allowed:true,loading:false});const older=p.load(true),old=r.requests.shift();p.changeFilter(event({value:'pending'}));const fresh=r.requests.shift();fresh.resolve({reports:[{_id:'fresh',status:'pending',reasonCode:'other'}],hasMore:false});await tick();old.resolve({reports:[{_id:'old',status:'hidden'}],hasMore:true});await older;assert.equal(p.data.items[0]._id,'fresh');assert.equal(p.data.hasMore,false);const next=p.load(true),req=r.requests.shift();p.onHide();req.resolve({reports:[{_id:'late'}]});await next;assert.equal(p.data.items.length,0);
});
test('举报分页失败保留游标和列表，重试去重追加，撤销后清记录',async()=>{
 const r=runtime(),p=r.page('admin-reports/index');p._visible=true;p._epoch=1;p.setData({allowed:true,loading:false,items:[{_id:'one'}],hasMore:true,nextCursor:'page2'});let d=p.loadMore();r.requests.shift().reject(Error('offline'));await d;assert.equal(p.data.items[0]._id,'one');assert.equal(p.data.nextCursor,'page2');d=p.loadMore();r.requests.shift().resolve({reports:[{_id:'one'},{_id:'two'}],hasMore:false});await d;assert.equal(p.data.items.length,2);d=p.load(true);r.requests.shift().resolve({ok:false,code:'FORBIDDEN',message:'无资格'});await d;assert.equal(p.data.allowed,false);assert.equal(p.data.items.length,0);
});
test('仅他人公开帖子进入举报，本人或私有帖不导航',()=>{
 const r=runtime(),p=r.page('wall-detail/index');p.postId=ID;for(const post of [{isOwner:true,status:'published'},{isOwner:false,status:'pending'},null]){p.setData({post});p.report();}assert.equal(r.navigation.length,0);p.setData({post:{isOwner:false,status:'published'}});p.report();assert.match(r.navigation[0].options.url,/report-post/);
});


test('会话网络失败保留输入并可重试，不冒充资格失效', async () => {
  const r = runtime(), p = r.page('report-post/index');
  p.onLoad({id: ID});
  p.input(input('', '已经写好的说明'));
  let done = p.onShow();
  r.requests.shift().reject(Error('offline'));
  await done;
  assert.equal(p.data.accessError, false);
  assert.match(p.data.error, /连接/);
  assert.equal(p.data.detail, '已经写好的说明');
  done = p.load();
  r.requests.shift().resolve({access: 'revoked'});
  await done;
  assert.equal(p.data.accessError, true);
  assert.equal(p.data.allowed, false);
  assert.equal(p.data.detail, '已经写好的说明');
});

test('举报离开确认跨后台失效，返回时重载帖子而不延迟跳走', async () => {
  const r = runtime(), p = form(r);
  p.choose(event({value: 'privacy'}));
  const cancel = p.cancel();
  const modal = r.modals.shift();
  p.onHide();
  const shown = p.onShow();
  r.requests.shift().resolve(session);
  await tick();
  r.requests.shift().resolve({post: {title: '仍公开', status: 'published', isOwner: false}});
  await shown;
  modal.success({confirm: true});
  await cancel;
  assert.equal(r.navigation.length, 0);
  assert.equal(p._confirming, false);
  assert.equal(p.data.post.title, '仍公开');
});

test('管理员确认跨后台作废，重新展示后可重新核对但不提交旧决定', async () => {
  const r = runtime(), p = admin(r);
  const done = p.decide();
  const modal = r.modals.shift();
  p.onHide();
  const shown = p.onShow();
  r.requests.shift().resolve(session);
  await tick();
  r.requests.shift().resolve({report: {_id: ID, status: 'pending', revision: 2, currentPost: {status: 'published', revision: 5}}});
  await shown;
  modal.success({confirm: true});
  await done;
  assert.equal(r.requests.length, 0);
  assert.equal(p.data.report.revision, 2);
  assert.equal(p.data.reason, '核实后处理');
  assert.equal(p._confirming, false);
});

test('前台证据到期立即清空；长于计时器上限的保留期会分段重设', async () => {
  const r = runtime(), p = r.page('admin-reports/detail');
  p.onLoad({id: ID});
  const expires = r.now() + 30 * 24 * 60 * 60 * 1000;
  await openDetail(r, p, {_id: ID, status: 'hidden', reasonCode: 'privacy', evidenceExpiresAt: expires, detail: '举报私有说明', resolveReason: '处理私有说明', snapshot: {title: '原文'}});
  r.advance(2147483647);
  assert.equal(p.data.report.detail, '举报私有说明');
  r.advance(expires - r.now() - 1);
  assert.equal(p.data.report.evidenceExpired, undefined);
  r.advance(1);
  assert.equal(p.data.report.evidenceExpired, true);
  assert.equal(p.data.report.detail, '');
  assert.equal(p.data.report.resolveReason, '');
  assert.equal(p.data.report.snapshot, null);
  p.onUnload();
  r.advance(10000);
  assert.equal(p.data.report.detail, '');
});


test('服务端提前标记证据不可用时立即遮蔽，不能显示残留自由文本', () => {
  const r = runtime(), R = r.load('utils/reports.js');
  const item = R.format({_id: ID, status: 'hidden', evidenceExpired: true, evidenceExpiresAt: r.now() + 10000, detail: '残留说明', snapshot: {title: '残留'}, resolveReason: '残留处理'});
  assert.equal(item.detail, '');
  assert.equal(item.snapshot, null);
  assert.equal(item.resolveReason, '');
});

test('列表及详情区分网络故障和管理员资格失效', async () => {
  const r = runtime(), list = r.page('admin-reports/index');
  let done = list.onShow();
  r.requests.shift().reject(Error('offline'));
  await done;
  assert.equal(list.data.accessError, false);
  done = list.refresh();
  r.requests.shift().resolve({access: 'approved', member: {role: 'member'}});
  await done;
  assert.equal(list.data.accessError, true);
  const detail = r.page('admin-reports/detail');
  detail.onLoad({id: ID});
  done = detail.onShow();
  r.requests.shift().resolve(session);
  await tick();
  r.requests.shift().resolve({ok: false, code: 'FORBIDDEN', message: '权限已撤销'});
  await done;
  assert.equal(detail.data.report, null);
  assert.equal(detail.data.accessError, true);
});


test('冲突后编辑说明仍保留刷新入口；帖子不可见后编辑仍保留恢复提示', async () => {
  const r = runtime(), p = admin(r);
  let done = p.decide();
  r.modals.shift().success({confirm: true});
  await tick();
  r.requests.shift().resolve({ok: false, code: 'CONFLICT', message: '帖子状态已变化，请刷新'});
  await done;
  p.input(input('', '更新说明'));
  assert.equal(p.data.conflict, true);
  assert.match(p.data.error, /刷新/);
  const post = form(r);
  post.choose(event({value: 'privacy'}));
  done = post.submit();
  r.requests.shift().resolve({ok: false, code: 'POST_UNAVAILABLE', message: '帖子已不可举报，请刷新'});
  await done;
  post.input(input('', '仍待核对'));
  post.choose(event({value: 'other'}));
  assert.equal(post.data.unavailable, true);
  assert.match(post.data.error, /刷新/);
});
