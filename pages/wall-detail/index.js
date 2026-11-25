const C = require('../../utils/campus');
const Media = require('../../utils/forum-media');
const DRAFT = 'campusCommentDraft:';
Page({
 data:{voteChoice:-1,loading:true,error:'',post:null,images:[],deleting:false,recommending:false,liked:false,likeBusy:false,comments:[],commentsLoading:false,commentsError:'',commentHasMore:false,commentCursor:null,comment:'',commentCount:0,commentLines:1,keyboardHeight:0,commentSubmitting:false,replyTo:'',replyToName:'',commentInfo:'',reducedMotion:false,reducedTransparency:false},
 onLoad(q){this.postId=q.id;this._focusReply=q.reply==='1';try{const draft=wx.getStorageSync(DRAFT+this.postId);if(draft)this.setData({comment:draft.content||'',commentCount:Array.from(draft.content||'').length,replyTo:draft.replyTo||'',replyToName:draft.replyToName||''});this._commentRequest=draft.requestId||'';this._commentFingerprint=draft.fingerprint||'';this._commentAvatarId=draft.avatarId||'';}catch(_){}},
 onShow(){this._visible=true;this.setData({reducedMotion:C.getReducedMotion(),reducedTransparency:C.getReducedTransparency()});return this.load();},
 onHide(){this._visible=false;this._recommendConfirming=false;this._epoch=(this._epoch||0)+1;this._commentEpoch=(this._commentEpoch||0)+1;this._loading=false;this.setData({loading:false,keyboardHeight:0,commentFocus:false,commentsLoading:false,commentSubmitting:false,likeBusy:false,recommending:false});},
 onUnload(){this.onHide();if(wx.disableAlertBeforeUnload)wx.disableAlertBeforeUnload();},
 active(epoch){return this._visible!==false&&epoch===this._epoch;},
 async load(){
  if(this._loading)return;this._loading=true;const epoch=this._epoch=(this._epoch||0)+1;this.setData({loading:true,error:''});
  try{const r=await C.callWall('getPost',{postId:this.postId});if(!this.active(epoch))return;this.setData({post:C.formatPost(r.post),voteChoice:r.post.poll?.choice ?? -1,images:[]});
   if(r.post.status!=='deleted'){const images=await Media.hydrate(r.post);if(!this.active(epoch))return;this.setData({images});}
   if(r.post.status==='published'){try{const state=await C.callWall('getLikeState',{postId:this.postId});if(!this.active(epoch))return;this.setData({liked:state.liked,post:{...this.data.post,likeCount:state.likeCount}});}catch(error){if(!this.active(epoch))return;if(['ACCESS_DENIED','FORBIDDEN','UNAUTHENTICATED','ACCOUNT_BANNED'].includes(error.code))throw error;this.setData({error:error.message});}}
   await this.loadComments(true);
   if (this.active(epoch) && this._focusReply && r.post.status === 'published') {
     this._focusReply = false;
     this.focusReply();
   }
  }catch(e){if(this.active(epoch))this.setData({error:e.message,...(['ACCESS_DENIED','FORBIDDEN','UNAUTHENTICATED','NOT_FOUND','ACCOUNT_BANNED','POST_UNAVAILABLE'].includes(e.code)?{post:null,images:[],comments:[]}:{})});}
  finally{if(this.active(epoch)){this._loading=false;this.setData({loading:false});}}
 },
 async loadComments(reset=false){
  if(this.data.commentsLoading||!this.data.post||(!reset&&!this.data.commentHasMore))return;
  const epoch=this._commentEpoch=(this._commentEpoch||0)+1;this.setData({commentsLoading:true,commentsError:''});
  try{const r=await C.callWall('listComments',{postId:this.postId,...(!reset?{cursor:this.data.commentCursor}:{})});if(this._visible===false||epoch!==this._commentEpoch)return;
   const rows=r.comments.map(x=>({...x,displayTime:C.formatTime(x.createdAt),statusLabel:C.statusLabels[x.status]||'处理中'})),seen=new Set();this.setData({comments:(reset?rows:this.data.comments.concat(rows)).filter(x=>!seen.has(x._id)&&seen.add(x._id)),commentHasMore:r.hasMore,commentCursor:r.nextCursor,commentsLoading:false});
  }catch(e){if(this._visible===false||epoch!==this._commentEpoch)return;this.setData({commentsLoading:false,commentsError:e.message});if(['ACCESS_DENIED','FORBIDDEN','UNAUTHENTICATED','ACCOUNT_BANNED'].includes(e.code))this.setData({post:null,images:[],comments:[]});}
 },
 retryComments(){this.loadComments(true);}, moreComments(){this.loadComments(false);},
 rejectAccess(error){if(['ACCESS_DENIED','FORBIDDEN','UNAUTHENTICATED','ACCOUNT_BANNED'].includes(error.code)){this._epoch=(this._epoch||0)+1;this._commentEpoch=(this._commentEpoch||0)+1;this.setData({post:null,images:[],comments:[],loading:false,commentsLoading:false,commentSubmitting:false,likeBusy:false,error:error.message});return true;}return false;},
 async like(){
  if(this.data.likeBusy||!this.data.post||this.data.post.status!=='published')return;
  this.setData({likeBusy:true,error:''});const epoch=this._epoch;
  try{const r=await C.callWall('setLiked',{postId:this.postId,liked:!this.data.liked});if(this.active(epoch))this.setData({liked:r.liked,post:{...this.data.post,likeCount:r.likeCount}});}
  catch(e){if(this.active(epoch)&&!this.rejectAccess(e))this.setData({error:e.message});}finally{if(this.active(epoch))this.setData({likeBusy:false});}
 },
 async votePost(e) {
  if (this.data.voteBusy || this.data.voteChoice >= 0) return;
  this.setData({ voteBusy: true });
  try {
   const { choice, option } = e.currentTarget.dataset;
   const r = await C.callWall('votePost', { postId: this.postId, choice: Number(choice), option });
   this.setData({ 'post.poll': { options: r.options, counts: r.counts }, voteChoice: r.choice });
  } catch (error) { wx.showToast({ title: error.message, icon: 'none' }); }
  finally { this.setData({ voteBusy: false }); }
 },
 async decideReply(e) {
  const row = this.data.comments.find(item => item._id === e.currentTarget.dataset.id);
  if (!row?.canReview || this._decidingReply) return;
  this._decidingReply = true;
  const decision = e.currentTarget.dataset.decision;
  try {
   await C.callWall('reviewComment', { commentId: row._id, revision: row.revision, decision, reason: decision === 'approve' ? '作者通过' : '作者拒绝' });
   await this.load();
  } catch (error) { this.setData({ commentsError: error.message }); }
  finally { this._decidingReply = false; }
 },
 openQuote(){
  const id=this.data.post?.quote?.id;
  if(id)wx.navigateTo({url:'/pages/wall-detail/index?id='+encodeURIComponent(id)});
 },
 morePost(){
  const post=this.data.post;
  if (!post) return;
  const actions=[];
  if(post.canEdit) actions.push({label:'编辑',run:()=>this.edit()});
  if(post.isOwner) actions.push({label:'删除',run:()=>this.remove()});
  else if(post.status==='published') actions.push({label:'举报',run:()=>this.report()});
  if(actions.length)wx.showActionSheet({itemList:actions.map(action=>action.label),success:({tapIndex})=>actions[tapIndex]?.run()});
 },
 focusReply(){
  if (this.data.post?.status !== 'published') return;
  this.setData({commentFocus:false},()=>this.setData({commentFocus:true}));
 },
 onShareAppMessage(){
  const post=this.data.post;
  return post?.status==='published'
   ? {title:post.title,path:'/pages/wall-detail/index?id='+encodeURIComponent(post._id)}
   : {title:'校园回声',path:'/pages/campus-wall/index'};
 },
 commentLineChange(e) {
  if (!this.data.comment) return;
  const lines = Math.max(1, Math.min(4, e.detail.lineCount || 1));
  if (lines !== this.data.commentLines) this.setData({ commentLines: lines });
 },
 inputComment(e){if(this.data.commentSubmitting)return this.data.comment;const comment=e.detail.value;this.setData({comment,commentCount:Array.from(comment).length,...(!comment ? {commentLines:1} : {}),commentsError:'',commentInfo:''});this.saveComment();return comment;},
 saveComment(){try{wx.setStorageSync(DRAFT+this.postId,{content:this.data.comment,replyTo:this.data.replyTo,replyToName:this.data.replyToName,requestId:this._commentRequest||'',fingerprint:this._commentFingerprint||'',avatarId:this._commentAvatarId||''});}catch(_){this.setData({commentsError:'本机评论草稿未保存成功，请勿离开。'});}if(this.data.comment.trim()&&wx.enableAlertBeforeUnload)wx.enableAlertBeforeUnload({message:'评论尚未提交，本机草稿会保留。确认离开？'});else if(!this.data.comment.trim()&&wx.disableAlertBeforeUnload)wx.disableAlertBeforeUnload();},
 reply(e){if(this.data.commentSubmitting||this.data.post?.status!=='published')return;const row=this.data.comments.find(x=>x._id===e.currentTarget.dataset.id);if(!row||row.status!=='published')return;this.setData({replyTo:row._id,replyToName:row.authorName,commentFocus:true});this.saveComment();},
 cancelReply(){if(this.data.commentSubmitting)return;this.setData({replyTo:'',replyToName:''});this.saveComment();},
 async sendComment(){
  if(this.data.commentSubmitting||!this.data.post||this.data.post.status!=='published')return;
  const content=this.data.comment.trim();if(!content||Array.from(content).length>500){this.setData({commentsError:'评论请填写1–500字，输入已保留。',commentFocus:true});return;}
  let avatarId = this._commentAvatarId || '';
  const draftFingerprint = JSON.stringify([content, this.data.replyTo, ...(avatarId ? [avatarId] : [])]);
  if (draftFingerprint !== this._commentFingerprint || !this._commentRequest) {
    avatarId = '';
    this._commentFingerprint = '';
    this._commentRequest = '';
    if (!(this.data.post.isOwner && this.data.post.isAnonymous)) {
      try {
        const stored = this.data.post.viewerAvatarOwner && wx.getStorageSync('campusPostAvatar:' + this.data.post.viewerAvatarOwner);
        if (typeof stored === 'string' && /^avatar-[1-8]$/.test(stored)) avatarId = stored;
      } catch (error) {}
    }
    this._commentAvatarId = avatarId;
    this._commentFingerprint = JSON.stringify([content, this.data.replyTo, ...(avatarId ? [avatarId] : [])]);
    this._commentRequest = C.requestId();
  }
  this.saveComment();this.setData({commentSubmitting:true,commentsError:''});const epoch=this._epoch;
  try{const result=await C.callWall('publishComment',{postId:this.postId,content,replyTo:this.data.replyTo,requestId:this._commentRequest,...(avatarId ? {avatarId} : {})});if(!this.active(epoch))return;
   this.setData({comment:'',commentCount:0,commentLines:1,replyTo:'',replyToName:'',commentInfo:result.status==='published'?'评论已发布。':'评论待审核，目前仅本人和管理员可见。'});try{wx.removeStorageSync(DRAFT+this.postId);}catch(_){}if(wx.disableAlertBeforeUnload)wx.disableAlertBeforeUnload();await this.loadComments(true);
  }catch(e){if(this.active(epoch)&&!this.rejectAccess(e))this.setData({commentsError:e.message});}finally{if(this.active(epoch))this.setData({commentSubmitting:false});}
 },
 async deleteComment(e){const row=this.data.comments.find(x=>x._id===e.currentTarget.dataset.id);if(!row||!row.isOwner||this._commentDelete)return;this._commentDelete=true;const epoch=this._epoch;
  try{if(!await C.confirm({title:'删除这条评论？',content:'正文会清除；已有回复仍保留删除占位。',confirmText:'删除评论'}))return;if(!this.active(epoch))return;await C.callWall('deleteComment',{commentId:row._id,revision:row.revision});if(this.active(epoch))await this.loadComments(true);}catch(error){if(this.active(epoch))this.setData({commentsError:error.message});}finally{this._commentDelete=false;}
 },
 reportComment(e){const row=this.data.comments.find(x=>x._id===e.currentTarget.dataset.id);if(row&&!row.isOwner&&row.status==='published')wx.navigateTo({url:'/pages/report-post/index?id='+this.postId+'&commentId='+row._id});},
 async recommend(){
  const post=this.data.post;if(!post||!post.canRecommend||post.community!=='experience'||this.data.recommending||this._recommendConfirming)return;
  const epoch=this._epoch,target=!post.recommended;this._recommendConfirming=true;
  const yes=await C.confirm({title:target?'将这篇经验加入推荐？':'取消这篇经验的推荐？',content:target?'仅推荐当前已公开且安全审核通过的版本。作者后续编辑会取消推荐，需要重新核对。':'取消后仍可在全部投稿中阅读，内容公开状态不变。',confirmText:target?'确认推荐':'取消推荐'});
  this._recommendConfirming=false;if(!yes||!this.active(epoch))return;this.setData({recommending:true,error:''});
  try{const result=await C.callWall('setExperienceRecommendation',{postId:post._id,revision:post.revision,recommended:target,confirmed:true});if(!this.active(epoch))return;this.setData({post:C.formatPost(result.post)});if(C.markWallChanged)C.markWallChanged(post._id);}
  catch(error){if(!this.active(epoch))return;if(this.rejectAccess(error))return;this.setData({error:error.code==='CONFLICT'?'文章版本已变化，推荐未覆盖新版本。请重新加载并核对后再次确认。':error.message});}
  finally{if(this.active(epoch))this.setData({recommending:false});}
 },
 openDirect(){wx.navigateTo({url:'/pages/direct-chat/index?post='+encodeURIComponent(this.postId)});},
 keyboardChange(e){this.setData({keyboardHeight: Math.max(0, Number(e.detail.height) || 0)});},
 blurComment(){this.setData({keyboardHeight:0,commentFocus:false});},
 previewImage(e){
  const { id, cover } = e.currentTarget.dataset;
  const coverUrl = this.data.post?.coverId ? '/static/presets/' + this.data.post.coverId + '.jpg' : '';
  const current = cover ? coverUrl : this.data.images.find(image => image.mediaId === id)?.url;
  if (current) wx.previewImage({current,urls:[coverUrl,...this.data.images.map(image=>image.url)].filter(Boolean)});
 },
 edit(){if(this.data.post?.canEdit)wx.navigateTo({url:'/pages/wall-publish/index?id='+this.postId});},
 async remove(){
  if(this.data.deleting||this._confirming||!this.data.post)return;this._confirming=true;const epoch=this._epoch;
  const yes=await C.confirm({title:'删除这条帖子？',content:'标题、正文和图片将不再展示；已有评论保留安全占位，关闭新互动。',confirmText:'确认删除',confirmColor:'#B83D49'});this._confirming=false;if(!yes||!this.active(epoch))return;
  this.setData({deleting:true,error:''});try{await C.callWall('deletePost',{postId:this.postId,revision:this.data.post.revision});if(this.active(epoch))await this.load();}catch(e){if(!this.active(epoch))return;if(this.rejectAccess(e))return;this.setData({error:e.message});if(e.code==='CONFLICT')await this.load();}finally{if(this._visible!==false)this.setData({deleting:false});}
 },
 report(){const p=this.data.post;if(p&&!p.isOwner&&p.status==='published')wx.navigateTo({url:'/pages/report-post/index?id='+this.postId});},
 wall(){wx.switchTab({url:'/pages/campus-wall/index'});}
});
