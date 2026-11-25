const C = require('../../utils/campus');
const {
  makeList
} = require('../../utils/wall-list');
Page({
  ...makeList({
    action: 'reviewList',
    admin: true,
    extra: {
      filter: 'pending',
      filters: [{
        value: 'pending',
        label: '待审核'
      }, {
        value: 'published',
        label: '已公开'
      }]
    }
  }),
  comments() { wx.navigateTo({ url: '/pages/admin-comments/index' }); },
  listParams() {
    return {
      status: this.data.filter
    }
  },
  openPost(e) {
    wx.navigateTo({
      url: '/pages/admin-review/detail?id=' + ((e.detail && e.detail.id) || e.currentTarget.dataset.id)
    })
  }
});
