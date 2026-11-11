const C = require('../../utils/campus');
const {
  makeList
} = require('../../utils/wall-list');
Page({
  ...makeList({
    route: 'pages/campus-wall/index',
    filters: true,
    extra: {
      categories: ['全部', ...C.categories]
    }
  }),
  publish() {
    if (this.data.access !== 'approved') return C.goAccess();
    wx.navigateTo({
      url: '/pages/wall-publish/index'
    })
  }
});
