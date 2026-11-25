const C = require('../../utils/campus');
Page({
  data: { loading: true, error: '', sessionNotice: '', member: null, authenticated: false, canManageAdmins: false,
    access: 'none', accessLabel: '尚未开通内测', reducedMotion: false, reducedTransparency: false },
  onShow() {
    this._visible = true;
    C.syncTab(this, 'pages/my/index');
    this.setData({ reducedMotion: C.getReducedMotion(), reducedTransparency: C.getReducedTransparency() });
    this.refresh(this._loaded === true);
  },
  onHide() { this._visible = false; this._sessionEpoch = (this._sessionEpoch || 0) + 1; this._loading = false; },
  onUnload() { this._unloaded = true; this.onHide(); },
  async refresh(quiet = false) {
    if (this._loading || this._unloaded || this._visible === false) return;
    const epoch = (this._sessionEpoch || 0) + 1;
    this._sessionEpoch = epoch;
    const active = () => !this._unloaded && this._visible !== false && this._sessionEpoch === epoch;
    this._loading = true;
    if (quiet !== true) this.setData({ loading: true, error: '' });
    try {
      const r = await C.callWall('session');
      if (!active()) return;
      this._loaded = true;
      this.setData({ member: r.member, authenticated: true, canManageAdmins: r.canManageAdmins === true,
        campusEmailSupported: r.campusEmailSupported === true, campusEmailVerified: r.campusEmailVerified === true, access: r.access, accessLabel: C.accessLabels[r.access] || '尚未开通内测', error: '', sessionNotice: '' });
    } catch (e) {
      if (!active()) return;
      if (['ACCESS_DENIED','UNAUTHENTICATED','FORBIDDEN'].includes(e.code)) {
        this.setData({ member: null, authenticated: false, canManageAdmins: false, access: 'none', accessLabel: '请重新核对资格', sessionNotice: '', error: e.message });
      } else this.setData(quiet === true ? { sessionNotice: '暂时无法核对身份，当前页面已保留。进入管理时会再次验证权限。' } : { error: e.message });
    } finally { if (active()) { this._loading = false; this.setData({ loading: false }); } }
  },
  go(e) { wx.navigateTo({ url: e.currentTarget.dataset.url }); },
  login() { wx.navigateTo({ url: '/pages/wechat-login/index' }); },
  unavailable: C.showUnavailable, goAccess: C.goAccess
});
