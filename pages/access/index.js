const C = require('../../utils/campus');
Page({
  data: {
    loading: true,
    error: '',
    member: null,
    access: 'none',
    nickname: '',
    reason: '',
    terms: false,
    submitting: false,
    reducedMotion: false,
    reducedTransparency: false
  },
  onShow() {
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
        access: r.access
      });
      this.updateLeaveAlert()
    } catch (e) {
      this.setData({
        error: e.message,
        access: 'error'
      })
    } finally {
      this._loading = false;
      this.setData({
        loading: false
      })
    }
  },
  input(e) {
    const key = e.currentTarget.dataset.key,
      max = key === 'nickname' ? 16 : 200;
    const value = e.detail.value;
    this.setData({
      [key]: value,
      error: '',
      [key+'Error']:'',
      focusNickname:false,
      focusReason:false
    });
    this.updateLeaveAlert();
    return value
  },
  updateLeaveAlert() {
    const dirty=this.data.access==='none' && (this.data.nickname.trim() || this.data.reason.trim());
    if(dirty && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({message:'内测申请尚未提交，离开会丢失本次输入。'});
    else if(wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
  },
  terms(e) {
    this.setData({
      terms: e.detail.value.length > 0
    })
  },
  explain() {
    wx.showModal({ title:'资格重新核对', content:'请向项目负责人说明情况。管理员核对后可重新批准当前账号；此页不会重复提交或覆盖原申请。', showCancel:false, confirmColor:'#0878BD' });
  },
  async submit() {
    if (this.data.submitting) return;
    const nickname = this.data.nickname.trim(),
      reason = this.data.reason.trim();
    const nicknameError = Array.from(nickname).length < 2 || Array.from(nickname).length > 16 ? '昵称请填写 2–16 字。' : '';
    const reasonError = Array.from(reason).length < 2 || Array.from(reason).length > 200 ? '申请说明请填写 2–200 字。' : '';
    if (nicknameError || reasonError || !this.data.terms) {
      this.setData({nicknameError,reasonError,error:!this.data.terms?'请阅读并勾选内测规则。':'请检查标出的字段，输入会保留。',focusNickname:!!nicknameError,focusReason:!nicknameError && !!reasonError});
      return;
    }
    this.setData({
      submitting: true,
      error: ''
    });
    try {
      const r = await C.callWall('requestAccess', {
        nickname,
        reason
      });
      this.setData({
        member: r.member,
        access: r.access
      });
      this.updateLeaveAlert()
    } catch (e) {
      this.setData({
        error: e.message
      })
    } finally {
      this.setData({
        submitting: false
      })
    }
  },
  my() {
    wx.switchTab({
      url: '/pages/my/index'
    })
  },
  wall() {
    wx.switchTab({
      url: '/pages/campus-wall/index'
    })
  }
});
