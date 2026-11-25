const C = require('../../utils/campus');
const { materials } = require('../../utils/demo-data');
const { chaptersFor } = require('../../utils/material-preview');
Page({
  data: { material: null, chapters: [], selected: 0, error: '', reducedMotion: false, reducedTransparency: false },
  onLoad(query = {}) {
    const material = materials.find(item => item.id === query.id);
    this.setData({ material: material || null, chapters: material ? chaptersFor(material.id) : [] });
  },
  onShow() {
    this.setData({ reducedMotion: C.getReducedMotion(), reducedTransparency: C.getReducedTransparency() });
  },
  scrollTo(selector) {
    wx.pageScrollTo({ selector, offsetTop: -16, duration: this.data.reducedMotion ? 0 : 220,
      fail: () => this.setData({ error: '暂时无法定位，请向下滑动查看。' }) });
  },
  contents() { this.scrollTo('#contents'); },
  preview(e) {
    const raw = e && e.currentTarget && e.currentTarget.dataset.index;
    const index = raw === undefined ? 0 : Number(raw);
    if (!Number.isInteger(index) || index < 0 || index >= this.data.chapters.length) return;
    this.setData({ selected: index, error: '' });
    this.scrollTo('#sample-' + index);
  },
  back() { wx.switchTab({ url: '/pages/materials/index' }); },
  unavailable: C.showUnavailable
});
