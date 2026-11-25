const C = require('../../utils/campus');
const { makeList } = require('../../utils/wall-list');
Page({ ...makeList({ route:'pages/experience/index', extra:{community:'experience'} }),
  onLoad(query = {}) { if (query.recommended === '1') this.setData({ filter: 'recommended' }); },
  listParams(){return {community:'experience',recommendedOnly:this.data.filter==='recommended'};},
  publish(){ if(this.data.access!=='approved')return C.goAccess(); wx.navigateTo({url:'/pages/wall-publish/index?community=experience'}); },
  search(){wx.navigateTo({url:'/pages/wall-search/index?community=experience'});}
});
