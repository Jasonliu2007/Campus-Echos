const C = require('../../utils/campus');
const {
  materials
} = require('../../utils/demo-data');
Page({
  data: {
    materials,
    reducedMotion: false,
    reducedTransparency: false
  },
  onShow() {
    C.syncTab(this, 'pages/materials/index');
    this.setData({
      reducedMotion: C.getReducedMotion(),
      reducedTransparency: C.getReducedTransparency()
    })
  },
  unavailable: C.showUnavailable,
  goAI() {
    wx.navigateTo({
      url: '/pages/notes-ai/index'
    })
  }
});
