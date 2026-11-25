const C = require('../../utils/campus');
const DOMAIN = '@mail.bnbu.edu.cn';

function schoolEmail(value) {
  const account = value.trim().toLowerCase();
  return account.includes('@') ? account : account + DOMAIN;
}
Page({
  data: { account: '', code: '', loading: true, access: '', available: false, verified: false, sent: false, busy: false, notice: '', error: '' },
  onLoad() { return this.load(); },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const session = await C.callWall('session');
      this.setData({
        access: session.access,
        available: session.campusEmailAvailable === true,
        verified: session.campusEmailVerified === true
      });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ loading: false });
    }
  },
  inputAccount(e) {
    const account = e.detail.value;
    this.setData({ account, sent: this._sentEmail === schoolEmail(account), code: '', notice: '', error: '' });
  },
  inputCode(e) {
    this.setData({ code: e.detail.value, error: '' });
  },
  async send() {
    if (this.data.busy || !this.data.available || this.data.verified) return;
    const email = schoolEmail(this.data.account);
    this.setData({ busy: true, notice: '', error: '' });
    try {
      const result = await C.callWall('campusEmailSend', { email });
      this._sentEmail = email;
      this.setData({
        verified: result.campusEmailVerified === true, sent: true, code: '',
        notice: result.campusEmailVerified ? '' : '验证码已发送，10 分钟内有效。'
      });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ busy: false });
    }
  },
  async verify() {
    if (this.data.busy || !this.data.sent) return;
    this.setData({ busy: true, notice: '', error: '' });
    try {
      await C.callWall('campusEmailVerify', { email: schoolEmail(this.data.account), code: this.data.code });
      this._sentEmail = null;
      this.setData({ verified: true, sent: false, code: '', account: '' });
    } catch (error) {
      this.setData({ error: error.message });
    } finally {
      this.setData({ busy: false });
    }
  },
  done() { wx.navigateBack({ delta: 1, fail: () => wx.switchTab({ url: '/pages/my/index' }) }); },
  goAccess: C.goAccess
});
