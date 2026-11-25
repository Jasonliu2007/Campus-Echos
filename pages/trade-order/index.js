const V = require('../../utils/trade-view');
const C=require('../../utils/campus');const T=require('../../utils/trade');
Page({
 data:{order:null,loading:true,error:'',notice:'',busy:'',messages:[],message:'',messageCount:0,messageError:'',hasMoreMessages:false,messagesCursor:null,sales:[],salesMore:false,salesCursor:null,reducedMotion:false,reducedTransparency:false},

 contactPeer(){wx.navigateTo({url:'/pages/direct-chat/index?order='+encodeURIComponent(this.orderId)});},
 onLoad(q={}){this.orderId=q.id;try{const draft=wx.getStorageSync('trade-message-'+this.orderId);if(draft)this.setData({message:draft.content||'',messageCount:Array.from(draft.content||'').length});this._messageRequest=draft&&draft.requestId||'';}catch(_){}},

 onShow(){V.show(this);this._confirming=false;this.setData({busy:''});this.setData({reducedMotion:C.getReducedMotion(),reducedTransparency:C.getReducedTransparency()});this.load();},

 onHide(){V.hide(this);},
  onUnload(){V.unload(this);},

 clearAccess(message){V.invalidate(this);this.setData({busy:'',order:null,messages:[],sales:[],hasMoreMessages:false,salesMore:false,messagesCursor:null,salesCursor:null,notice:'',error:message,loading:false});},

 async load(){if(this._loading)return;this._loading=true;const view=V.token(this);const seq=this._seq=(this._seq||0)+1;this.setData({loading:!this.data.order,error:''});try{const r=await T.call('getOrder',{orderId:this.orderId});if(seq!==this._seq||!V.current(this,view))return;this.setData({order:T.order(r.order),notice:r.paymentNotice||''});await Promise.allSettled([this.loadMessages(true),this.loadSales(true)]);}catch(e){if(seq===this._seq&&V.current(this,view)){if(T.invalidAccess(e))this.clearAccess(e.message);else this.setData({error:e.message});}}finally{if(seq===this._seq&&V.current(this,view)){this._loading=false;this.setData({loading:false});}}},

 async loadMessages(reset=false){if(this._messagesLoading||(!reset&&!this.data.hasMoreMessages))return;this._messagesLoading=true;const view=V.token(this);try{const r=await T.call('listOrderMessages',{orderId:this.orderId,...(reset?{}:{cursor:this.data.messagesCursor})});if(!V.current(this,view))return;this.setData({messages:(reset?r.items:this.data.messages.concat(r.items)).map(x=>({...x,displayTime:C.formatTime(x.createdAt),speakerLabel:{buyer:'买家',seller:'卖家',admin:'管理员'}[x.speaker]})),hasMoreMessages:r.hasMore,messagesCursor:r.nextCursor,messageError:''});}catch(e){if(V.current(this,view)){if(T.invalidAccess(e))this.clearAccess(e.message);else this.setData({messageError:e.message,...(e.code==='EVIDENCE_CLEARED'?{messages:[],hasMoreMessages:false,messagesCursor:null}:{})});}}finally{if(V.current(this,view))this._messagesLoading=false;}},

 moreMessages(){this.loadMessages(false);},

 async loadSales(reset=false){if(this._salesLoading||(!reset&&!this.data.salesMore))return;this._salesLoading=true;const view=V.token(this);try{const r=await T.call('listOrderAfterSales',{orderId:this.orderId,...(reset?{}:{cursor:this.data.salesCursor})});if(!V.current(this,view))return;this.setData({sales:reset?r.items:this.data.sales.concat(r.items),salesMore:r.hasMore,salesCursor:r.nextCursor});}catch(e){if(V.current(this,view)){if(T.invalidAccess(e))this.clearAccess(e.message);else this.setData({error:e.message});}}finally{if(V.current(this,view))this._salesLoading=false;}},

 moreSales(){this.loadSales(false);},

 input(e){const value=e.detail.value;this._messageRequest='';this.setData({message:value,messageCount:Array.from(value).length,messageError:''});this.saveMessage();if(value&&wx.enableAlertBeforeUnload)wx.enableAlertBeforeUnload({message:'订单留言尚未提交，离开后可从本机草稿继续。'});else if(wx.disableAlertBeforeUnload)wx.disableAlertBeforeUnload();},

 saveMessage(){try{wx.setStorageSync('trade-message-'+this.orderId,{content:this.data.message,requestId:this._messageRequest||''});}catch(_){this.setData({messageError:'本机草稿未保存成功，请勿关闭页面。'});}},

 async send(){const view=V.token(this);if(this.data.busy)return;const content=this.data.message.trim();if(!content||Array.from(content).length>500){this.setData({messageError:'留言请填写1–500字。'});return;}this._messageRequest=this._messageRequest||C.requestId();this.saveMessage();this.setData({busy:'message',messageError:''});try{await T.call('sendOrderMessage',{orderId:this.orderId,requestId:this._messageRequest,content});if(!V.current(this,view))return;if(this.data.message.trim()===content){this.setData({message:'',messageCount:0});this._messageRequest='';try{wx.removeStorageSync('trade-message-'+this.orderId);}catch(_){}if(wx.disableAlertBeforeUnload)wx.disableAlertBeforeUnload();}await this.loadMessages(true);}catch(e){if(V.current(this,view)){if(T.invalidAccess(e))this.clearAccess(e.message);else this.setData({messageError:e.message,...(e.code==='EVIDENCE_CLEARED'?{messages:[],hasMoreMessages:false,messagesCursor:null}:{})});}}finally{if(V.current(this,view))this.setData({busy:''});}},

 async claim(){const view=V.token(this);if(this.data.busy||this._confirming||!this.data.order)return;this._confirming=true;const yes=await C.confirm({title:'领取专属PDF',content:'首次领取起7天为普通内容售后与自动完成期限；续签不重置。技术交付问题可持续报修。链接短时有效，已下载文件无法远程收回。',confirmText:'了解并领取'});this._confirming=false;if(!yes||!V.current(this,view))return;this.setData({busy:'claim',error:''});try{const r=await T.call('claimOrder',{orderId:this.orderId,termsAccepted:true});if(!V.current(this,view))return;this.setData({order:T.order(r.order),notice:'领取链接已签发，正在下载并打开。'});await T.openDocument(r.url);if(!V.current(this,view))return;this.setData({notice:'已交由微信文档阅读器打开。你可以在阅读器菜单中保存。'});}catch(e){if(V.current(this,view)){if(T.invalidAccess(e))this.clearAccess(e.message);else this.setData({error:e.message});}}finally{if(V.current(this,view))this.setData({busy:''});}},

 async mutate(action,
  options={}){const view=V.token(this);if(this.data.busy||!this.data.order)return;this.setData({busy:action,error:''});try{const r=await T.call(action,{orderId:this.orderId,revision:this.data.order.revision,...options});if(!V.current(this,view))return;if(r.order)this.setData({order:T.order(r.order)});else await this.load();}catch(e){if(!V.current(this,view))return;if(T.invalidAccess(e)){this.clearAccess(e.message);return;}const message=e.message;if(e.code==='CONFLICT'){await this.load();this.setData({error:message+' 已刷新状态，请核对后重新确认。'});}else this.setData({error:message});}finally{if(V.current(this,view))this.setData({busy:''});}},

 async cancel(){const view=V.token(this);if(this._confirming||this.data.busy)return;this._confirming=true;const yes=await C.confirm({title:'取消这笔订单？',content:'只取消待付款订单。若已经站外转账，请保留材料并使用迟到付款协调。',confirmText:'确认取消'});this._confirming=false;if(yes&&V.current(this,view))this.mutate('cancelOrder');},

 async complete(){const view=V.token(this);if(this._confirming||this.data.busy)return;this._confirming=true;const yes=await C.confirm({title:'确认资料已完成交付？',content:'请先实际打开并核对文件。技术交付问题仍可报修，平台不会代替你确认退款到账。',confirmText:'确认完成'});this._confirming=false;if(yes&&V.current(this,view))this.mutate('completeOrder');},

 retryDelivery(){this.mutate('retryDelivery');},

 payment(){wx.navigateTo({url:'/pages/trade-payment/index?id='+this.orderId});},

 support(){wx.navigateTo({url:'/pages/trade-support/index?orderId='+this.orderId});},

 openSale(e){wx.navigateTo({url:'/pages/trade-support/index?caseId='+e.currentTarget.dataset.id+'&orderId='+this.orderId});},

 async feedback(e){const view=V.token(this);if(this.data.busy)return;this.setData({busy:'feedback',error:''});try{await T.call('submitFeedback',{orderId:this.orderId,feedback:e.currentTarget.dataset.value});if(!V.current(this,view))return;this.setData({notice:'反馈已私有保存，不计入信用分或销量榜。'});}catch(error){if(!V.current(this,view))return;if(T.invalidAccess(error)){this.clearAccess(error.message);return;}this.setData({error:error.message});}finally{if(V.current(this,view))this.setData({busy:''});}}
});
