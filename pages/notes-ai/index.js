const C = require('../../utils/campus');
Page({
  data: {
    courses: ['高等数学', '大学英语', '线性代数'],
    purposes: ['期中期末冲刺', '跟着课堂学', '从头自学'],
    bases: ['概念还没弄懂', '懂概念，做题会卡', '基础题能独立完成'],
    course: '高等数学',
    purpose: '期中期末冲刺',
    basis: '概念还没弄懂',
    result: false,
    reducedMotion: false,
    reducedTransparency: false
  },
  onShow() {
    this.setData({
      reducedMotion: C.getReducedMotion(),
      reducedTransparency: C.getReducedTransparency()
    })
  },
  choose(e) {
    const {
      key,
      value
    } = e.currentTarget.dataset;
    this.setData({
      [key]: value,
      result: false
    })
  },
  recommend() {
    this.setData({
      result: true
    });
    wx.pageScrollTo({
      selector: '#ai-result',
      duration: this.data.reducedMotion ? 0 : 160
    })
  },
  unavailable: C.showUnavailable
});
