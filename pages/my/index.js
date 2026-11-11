const C = require('../../utils/campus');
Page({
  data: {
    loading: true,
    error: '',
    member: null,
    access: 'none',
    accessLabel: '尚未开通内测',
    reducedMotion: false,
    reducedTransparency: false
  },
  onShow() {
    C.syncTab(this, 'pages/my/index');
    this.setData({
      reducedMotion: C.getReducedMotion(),
      reducedTransparency: C.getReducedTransparency()
    });
    this.refresh()
  },
  async refresh() {
    if (this._loading) return;
    this._loading = true;
    this.setData({
      loading: true,
      error: ''
    });
    try {
      const r = await C.callWall('session');
      this.setData({
        member: r.member,
        access: r.access,
        accessLabel: C.accessLabels[r.access] || '尚未开通内测'
      })
    } catch (e) {
      this.setData({
        error: e.message
      })
    } finally {
      this._loading = false;
      this.setData({
        loading: false
      })
    }
  },
  go(e) {
    wx.navigateTo({
      url: e.currentTarget.dataset.url
    })
  },
  unavailable: C.showUnavailable,
  goAccess: C.goAccess
});
