const V = require('../../utils/trade-view');
const C = require('../../utils/campus');
const T = require('../../utils/trade');
Page({
 data:{items:[],side:'buyer',loading:true,loadingMore:false,hasMore:false,nextCursor:null,error:'',pageError:'',reducedMotion:false,reducedTransparency:false},

 onShow(){V.show(this);this.setData({reducedMotion:C.getReducedMotion(),reducedTransparency:C.getReducedTransparency()});this.load(true);},
  onHide(){V.hide(this);},
  onUnload(){V.unload(this);},

 async load(reset=false){if(this._loading||(!reset&&!this.data.hasMore))return;this._loading=true;this.setData({loading:reset,loadingMore:!reset,error:'',pageError:''});const view=V.token(this);const seq=this._seq=(this._seq||0)+1;try{const r=await T.call('listOrders',{side:this.data.side,...(reset?{}:{cursor:this.data.nextCursor})});if(seq!==this._seq||!V.current(this,view))return;this._loaded=true;const seen=new Set();this.setData({items:(reset?r.items.map(T.order):this.data.items.concat(r.items.map(T.order))).filter(x=>!seen.has(x._id)&&seen.add(x._id)),hasMore:r.hasMore,nextCursor:r.nextCursor});}catch(e){if(seq===this._seq&&V.current(this,view))this.setData({... (reset?{error:e.message}:{pageError:e.message}),...(T.invalidAccess(e)?{items:[],hasMore:false,nextCursor:null}:{})});}finally{if(seq===this._seq&&V.current(this,view)){this._loading=false;this.setData({loading:false,loadingMore:false});}}},

 side(e){const side=e.currentTarget.dataset.side;if(side===this.data.side||this._loading)return;this.setData({side,items:[],hasMore:false,nextCursor:null});this.load(true);},

 retry(){this.load(true);},
  more(){this.load(false);},
  onReachBottom(){this.load(false);},
  async onPullDownRefresh(){try{await this.load(true);}finally{wx.stopPullDownRefresh();}},

 open(e){wx.navigateTo({url:'/pages/trade-order/index?id='+e.currentTarget.dataset.id});},

 materials(){wx.navigateTo({url:'/pages/my-materials/index'});},
  payment(){wx.navigateTo({url:'/pages/trade-payment/index?mode=setup'});}
});
