const C = require('../../utils/campus');
Page({
  data: { submitting: false, error: '', result: null, reducedMotion: false, reducedTransparency: false },
  onShow() {
    this._visible = true;
    this._loginEpoch = (this._loginEpoch || 0) + 1;
    this.setData({ submitting: false, reducedMotion: C.getReducedMotion(), reducedTransparency: C.getReducedTransparency() });
  },
  onHide() { this._visible = false; this._loginEpoch = (this._loginEpoch || 0) + 1; },
  onUnload() { this._unloaded = true; this.onHide(); },
  async login() {
    if (this.data.submitting || this._unloaded || this._visible === false) return;
    const epoch = (this._loginEpoch || 0) + 1;
    this._loginEpoch = epoch;
    const active = () => !this._unloaded && this._visible !== false && epoch === this._loginEpoch;
    this.setData({ submitting: true, error: '', result: null });
    try {
      await new Promise((resolve, reject) => wx.login({
        timeout: 10000,
        success: value => value && value.code ? resolve() : reject(new Error('微信登录暂未完成，请重试。')),
        fail: () => reject(new Error('微信登录暂未完成，请检查网络后重试。'))
      }));
      if (!active()) return;
      // The cloud runtime supplies the trusted WeChat identity. Never send a role,
      // OpenID, AppSecret or a fabricated local token from the client.
      const session = await C.callWall('session');
      if (!active()) return;
      this.setData({ result: {
        admin: session.access === 'approved' && session.member && session.member.role === 'admin',
        access: session.access, label: C.accessLabels[session.access] || '尚未开通内测'
      } });
    } catch (error) {
      if (active()) this.setData({ error: error.message });
    } finally {
      if (active()) this.setData({ submitting: false });
    }
  },
  mine() { wx.switchTab({ url: '/pages/my/index' }); },
  access: C.goAccess
});
