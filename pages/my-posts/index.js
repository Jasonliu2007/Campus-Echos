const C = require('../../utils/campus');
const {
  makeList
} = require('../../utils/wall-list');
Page({
  ...makeList({
    action: 'listMine',
    extra: {
      filters: [{
        value: '',
        label: '全部'
      }, {
        value: 'published',
        label: '已发布'
      }, {
        value: 'pending',
        label: '待审核'
      }, {
        value: 'rejected',
        label: '未通过'
      }, {
        value: 'hidden',
        label: '已下架'
      }, {
        value: 'deleted',
        label: '已删除'
      }]
    }
  }),
  listParams() {
    return this.data.filter ? {
      status: this.data.filter
    } : {}
  },
  publish() {
    wx.navigateTo({
      url: '/pages/wall-publish/index'
    })
  }
});
