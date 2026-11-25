const V = require('../../utils/trade-view');
const C=require('../../utils/campus');const T=require('../../utils/trade');
const tabs=[{id:'materials',
  label:'资料审核',
  action:'reviewMaterials'},{id:'afterSales',
  label:'售后协调',
  action:'listAfterSales'},{id:'complaints',
  label:'资料投诉',
  action:'listMaterialComplaints'}];
Page({data:{tabs,tab:'materials',items:[],loading:true,loadingMore:false,hasMore:false,nextCursor:null,error:'',reason:'',selected:null,busy:false,reducedMotion:false,reducedTransparency:false},
  onShow(){V.show(this);this._confirming=false;this.setData({busy:false});this.setData({selected:null});this.setData({reducedMotion:C.getReducedMotion(),reducedTransparency:C.getReducedTransparency()});this.load(true);},
  onHide(){V.hide(this);this.setData({selected:null});},
  onUnload(){V.unload(this);},
  clearAccess(message){V.invalidate(this);this.setData({busy:false,items:[],selected:null,hasMore:false,nextCursor:null,error:message,loading:false,loadingMore:false});},
  async load(reset=false){if(this._loading||(!reset&&!this.data.hasMore))return;this._loading=true;const view=V.token(this);this.setData({loading:reset,loadingMore:!reset,error:''});try{const action=tabs.find(x=>x.id===this.data.tab).action;const r=await T.call(action,reset?{}:{cursor:this.data.nextCursor});if(!V.current(this,view))return;const items=(reset?r.items:this.data.items.concat(r.items)).map(x=>({...x,displayTime:C.formatTime(x.createdAt)}));this.setData({items,hasMore:r.hasMore,nextCursor:r.nextCursor,selected:this.data.selected?items.find(x=>x._id===this.data.selected._id)||null:null});}catch(e){if(V.current(this,view)){if(T.invalidAccess(e))this.clearAccess(e.message);else this.setData({error:e.message});}}finally{if(V.current(this,view)){this._loading=false;this.setData({loading:false,loadingMore:false});}}},
  async tab(e){
    const view=V.token(this);if(this._loading||this.data.busy||this._confirming)return;
    const tab=e.currentTarget.dataset.tab;if(tab===this.data.tab||!tabs.some(x=>x.id===tab))return;
    if(this.data.reason.trim()){
      this._confirming=true;const yes=await C.confirm({title:'切换前放弃未提交说明？',content:'核查说明尚未提交，切换后需要重新填写。',confirmText:'放弃并切换',cancelText:'继续填写'});
      if(!V.current(this,view))return;this._confirming=false;if(!yes)return;
    }
    if(!V.current(this,view))return;this._reasonId='';
    this.setData({tab,items:[],hasMore:false,nextCursor:null,selected:null,reason:''});
    if(wx.disableAlertBeforeUnload)wx.disableAlertBeforeUnload();this.load(true);
  },
  retry(){this.load(true);},
  more(){this.load(false);},
  async open(e){
    const view=V.token(this);if(this.data.busy||this._confirming)return;
    const x=this.data.items.find(r=>r._id===e.currentTarget.dataset.id);if(!x)return;
    if(this.data.tab==='materials'){wx.navigateTo({url:'/pages/admin-material/index?id='+x._id});return;}
    if(this.data.tab==='afterSales'){wx.navigateTo({url:'/pages/trade-support/index?caseId='+x._id+'&orderId='+x.orderId});return;}
    if(this._reasonId!==x._id&&this.data.reason.trim()){
      this._confirming=true;const yes=await C.confirm({title:'切换前放弃未提交说明？',content:'当前投诉的核查说明尚未提交，切换后需要重新填写。',confirmText:'放弃并切换',cancelText:'继续填写'});
      if(!V.current(this,view))return;this._confirming=false;if(!yes)return;
    }
    if(!V.current(this,view))return;
    const reason=this._reasonId===x._id?this.data.reason:'';
    this.setData({selected:x,reason,error:''});this._reasonId=x._id;
    if(!reason&&wx.disableAlertBeforeUnload)wx.disableAlertBeforeUnload();
  },
  input(e){this._reasonVersion=(this._reasonVersion||0)+1;this.setData({reason:e.detail.value,error:''});if(wx.enableAlertBeforeUnload)wx.enableAlertBeforeUnload({message:'核查说明尚未提交，确认离开？'});},
  async close(){
    const view=V.token(this);if(this.data.busy||this._confirming)return;
    if(this.data.reason.trim()){
      this._confirming=true;const yes=await C.confirm({title:'放弃未提交的核查说明？',content:'说明尚未保存，关闭后需要重新填写。',confirmText:'放弃说明',cancelText:'继续填写'});
      if(!V.current(this,view))return;this._confirming=false;if(!yes)return;
    }
    if(!V.current(this,view))return;this._reasonId='';this.setData({selected:null,reason:''});
    if(wx.disableAlertBeforeUnload)wx.disableAlertBeforeUnload();
  },
  async inspect(){const view=V.token(this);if(this.data.busy||!this.data.selected)return;this.setData({busy:true,error:''});try{const r=await T.call('getPrivatePdf',{versionId:this.data.selected.versionId});if(!V.current(this,view))return;await T.openDocument(r.url);if(!V.current(this,view))return;}catch(e){if(V.current(this,view)){if(T.invalidAccess(e))this.clearAccess(e.message);else this.setData({error:e.message});}}finally{if(V.current(this,view))this.setData({busy:false});}},
  async resolve(e){const view=V.token(this);if(this.data.busy||this._confirming||!this.data.selected)return;const reason=this.data.reason.trim();if(Array.from(reason).length<2||Array.from(reason).length>200){this.setData({error:'核查说明请填写2–200字。'});return;}const decision=e.currentTarget.dataset.decision,reasonVersion=this._reasonVersion||0;const selected=this.data.selected;this._confirming=true;const yes=await C.confirm({title:decision==='restore'?'记录核查并尝试恢复？':'维持版权或安全限制？',content:'将核对投诉版本；其他未结投诉或既有限制仍会阻止恢复。已下载文件无法远程收回。',confirmText:'确认核查结果'});this._confirming=false;if(!yes||!V.current(this,view))return;this.setData({busy:true,error:''});try{await T.call('resolveMaterialComplaint',{complaintId:selected._id,revision:selected.revision,decision,reason});if(!V.current(this,view))return;if((this._reasonVersion||0)===reasonVersion){this._reasonId='';this.setData({selected:null,reason:''});if(wx.disableAlertBeforeUnload)wx.disableAlertBeforeUnload();}else this.setData({selected:null,error:'核查结果已记录，后续说明尚未提交，仍保留在本页。'});await this.load(true);}catch(error){if(!V.current(this,view))return;if(T.invalidAccess(error)){this.clearAccess(error.message);return;}this.setData({error:error.message+' 输入已保留。'});}finally{if(V.current(this,view))this.setData({busy:false});}}});
