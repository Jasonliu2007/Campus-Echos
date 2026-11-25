const C = require('../../utils/campus');
const R = require('../../utils/reports');

Page({
  data: {
    loading: true, allowed: false, accessError: false, error: '', post: null,
    reasonCode: '', detail: '', detailCount: 0, fieldError: '',
    submitting: false, result: null, unavailable: false, reasons: R.reasons,
    reducedMotion: false, reducedTransparency: false
  },
  onLoad(query) { this.postId = query.id; this.commentId = query.commentId || ''; this.setData({ commentTarget: !!this.commentId }); },
  onShow() {
    this._visible = true;
    this.setData(R.preferences());
    return this.load();
  },
  onHide() {
    R.dispose(this);
    this.setData({ post: null, loading: false, submitting: false });
  },
  onUnload() {
    R.dispose(this);
    R.leaveAlert(this, false);
    this.data.detail = '';
  },
  async load() {
    if (this.data.submitting) return;
    const epoch = this._epoch = (this._epoch || 0) + 1;
    this.setData({ loading: true, error: '', accessError: false });
    try {
      const session = await C.callWall('session');
      if (!this._visible || epoch !== this._epoch) return;
      const allowed = session.access === 'approved';
      this.setData({ allowed, accessError: !allowed });
      if (!allowed) {
        this.setData({ loading: false, post: null });
        return;
      }
      if (this.data.result) {
        this.setData({ loading: false });
        return;
      }
      const response = await C.callWall('getPost', { postId: this.postId });
      if (!this._visible || epoch !== this._epoch) return;
      if ((!this.commentId && response.post.isOwner) || response.post.status !== 'published') {
        this.setData({
          unavailable: true, post: null, loading: false,
          error: response.post.isOwner ? '自己的帖子请使用删除功能。' : '这条帖子已不可举报。'
        });
        return;
      }
      this.setData({ post: response.post, loading: false, unavailable: false });
    } catch (error) {
      if (!this._visible || epoch !== this._epoch) return;
      this.setData({ error: error.message, loading: false, post: null, accessError: R.denied(error) });
      if (R.denied(error)) this.setData({ allowed: false });
    }
  },
  choose(event) {
    if (this.data.submitting || this._confirming) return;
    const reasonCode = event.currentTarget.dataset.value;
    if (!R.reasons.some((reason) => reason.value === reasonCode)) return;
    this.setData({ reasonCode, fieldError: '', error: this.data.unavailable ? this.data.error : '' });
    this.updateLeave();
  },
  input(event) {
    if (this.data.submitting || this._confirming) return;
    const detail = event.detail.value;
    this.setData({ detail, detailCount: R.length(detail), fieldError: '', focusDetail: false, error: this.data.unavailable ? this.data.error : '' });
    this.updateLeave();
    return detail;
  },
  updateLeave() {
    R.leaveAlert(this, !this.data.result && !!(this.data.reasonCode || this.data.detail.trim()), '举报尚未提交，离开会丢失本次原因与说明。');
  },
  async submit() {
    if (!this.data.allowed || !this.data.post || this.data.loading || this.data.submitting || this._confirming || this.data.result || this.data.unavailable) return;
    const detail = this.data.detail.trim();
    let fieldError = '';
    if (!this.data.reasonCode) fieldError = '请选择举报原因。';
    else if (R.length(detail) > 200) fieldError = '补充说明最多200字。';
    else if (this.data.reasonCode === 'other' && R.length(detail) < 2) fieldError = '选择“其他”时，请填写2–200字说明。';
    if (fieldError) {
      this.setData({ fieldError, focusDetail: this.data.reasonCode === 'other' || R.length(detail) > 200 });
      if (!this.data.reasonCode && wx.pageScrollTo) {
        wx.pageScrollTo({ selector: '.report-reasons', duration: this.data.reducedMotion ? 0 : 160 });
      }
      return;
    }
    const epoch = this._epoch;
    this.setData({ submitting: true, error: '' });
    try {
      const response = await C.callWall(this.commentId ? 'reportComment' : 'reportPost', { postId: this.postId, ...(this.commentId ? { commentId: this.commentId } : {}), reasonCode: this.data.reasonCode, detail });
      if (!this._visible || epoch !== this._epoch) return;
      this.setData({
        result: { ...response.report, duplicate: !!response.duplicate }, submitting: false,
        detail: '', detailCount: 0, reasonCode: ''
      });
      R.leaveAlert(this, false);
    } catch (error) {
      if (!this._visible || epoch !== this._epoch) return;
      this.setData({ submitting: false, error: error.message, accessError: R.denied(error) });
      if (R.denied(error)) this.setData({ allowed: false, post: null });
      if (error.code === 'POST_UNAVAILABLE') this.setData({ unavailable: true });
    }
  },
  async cancel() {
    if (this.data.submitting || this._confirming) return;
    const epoch = this._epoch;
    if (!this.data.result && (this.data.reasonCode || this.data.detail.trim())) {
      this._confirming = true;
      const yes = await C.confirm({
        title: '放弃这次举报说明？', content: '尚未提交的原因与说明会丢失。',
        confirmText: '放弃并离开', cancelText: '继续填写'
      });
      this._confirming = false;
      if (!yes || !this._visible || epoch !== this._epoch) return;
    }
    R.leaveAlert(this, false);
    C.goBack();
  },
  result() {
    if (this.data.result) wx.navigateTo({ url: '/pages/my-reports/detail?id=' + this.data.result._id });
  },
  wall() { wx.switchTab({ url: '/pages/campus-wall/index' }); },
  goAccess: C.goAccess
});
