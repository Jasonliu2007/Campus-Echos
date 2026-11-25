const C = require('../../utils/campus');
const Media = require('../../utils/forum-media');
Page({
  data: {
    loading: true,
    error: '',
    post: null,
    reason: '', images: [], identity: null, identityReason: '', identityBusy: false,
    processing: false,
    admin: false,
    reducedMotion: false,
    reducedTransparency: false
  },
  onLoad(q) {
    this.postId = q.id
  },
  onShow() {
    this._visible = true;
    this.setData({
      reducedMotion: C.getReducedMotion(),
      reducedTransparency: C.getReducedTransparency()
    });
    this.load()
  },
  async load() {
    if (this._loading) return;
    this._loading = true;
    const epoch = this._epoch = (this._epoch || 0) + 1;
    this.setData({
      loading: true,
      error: ''
    });
    try {
      const s = await C.callWall('session');
      if (this._visible === false || epoch !== this._epoch) return;
      const isAdmin = s.access === 'approved' && s.member.role === 'admin';
      this.setData({
        admin: isAdmin
      });
      if (!isAdmin) throw new Error('只有管理员可以处理内容。');
      const r = await C.callWall('getPost', {
        postId: this.postId
      });
      const images = await Media.hydrate(r.post);
      if (this._visible === false || epoch !== this._epoch) return;
      this.setData({ post: C.formatPost(r.post), images });
    } catch (e) {
      if (this._visible === false || epoch !== this._epoch) return;
      this.setData({
        error: e.message,
        post: null
      })
    } finally {
      if (this._visible === false || epoch !== this._epoch) return;
      this._loading = false;
      this.setData({
        loading: false
      })
    }
  },
  identityInput(e) { this.setData({ identityReason: e.detail.value }); return e.detail.value; },
  async inspectIdentity() {
    if (this.data.identityBusy || !this.data.admin) return;
    const reason = this.data.identityReason.trim(); if (Array.from(reason).length < 2 || Array.from(reason).length > 200) { this.setData({ error: '核查身份前请填写2–200字原因。' }); return; }
    const epoch = this._epoch;
    this.setData({ identityBusy: true, error: '' });
    try { const result = await C.callWall('getPostAuthor', { postId: this.postId, reason }); if (this._visible === false || epoch !== this._epoch) return; this.setData({ identity: result.author }); }
    catch (error) { if (this._visible !== false && epoch === this._epoch) this.setData({ error: error.message, identity: null }); }
    finally { if (this._visible !== false && epoch === this._epoch) this.setData({ identityBusy: false }); }
  },
  previewImage(e) { const row = this.data.images.find(x => x.mediaId === e.currentTarget.dataset.id); if (row?.url) wx.previewImage({ current: row.url, urls: this.data.images.map(x => x.url).filter(Boolean) }); },
  updateReasonLeaveAlert() {
    const dirty = !!this.data.reason.trim();
    if (dirty && wx.enableAlertBeforeUnload) {
      wx.enableAlertBeforeUnload({ message: '处理说明尚未提交，离开会丢失输入。' });
      this._reasonLeaveAlert = true;
    } else if (this._reasonLeaveAlert && wx.disableAlertBeforeUnload) {
      wx.disableAlertBeforeUnload();
      this._reasonLeaveAlert = false;
    }
  },
  onHide() { this._visible = false; this._epoch = (this._epoch || 0) + 1; this._loading = false; this.setData({ identity: null, identityBusy: false, processing: false }); },
  onUnload() {
    this.onHide();
    if (this._reasonLeaveAlert && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    this._reasonLeaveAlert = false;
  },
  input(e) {
    const reason = e.detail.value;
    this.setData({
      reason,
      reasonError:'',
      focusReason:false,
      error: ''
    });
    this.updateReasonLeaveAlert();
    return reason
  },
  async decide(e) {
    if (this.data.processing || this._confirming || !this.data.post) return;
    const epoch = this._epoch;
    const decision = e.currentTarget.dataset.decision,
      reason = this.data.reason.trim();
    if (decision !== 'approve' && (Array.from(reason).length < 2 || Array.from(reason).length > 200)) {
      this.setData({
        error: '请填写 2–200 字处理说明，便于作者了解原因。',
        reasonError:'处理说明请填写2–200字。',
        focusReason:true
      });
      return
    }
    const labels = {
      approve: '通过',
      reject: '驳回',
      hide: '下架'
    };
    this._confirming = true;
    const yes = await C.confirm({
      title: '确认' + labels[decision] + '这条帖子？',
      content: decision === 'approve' ? '通过前会再次执行微信审核；只有可公开的内容才会展示，操作将留存记录。' : '处理说明会展示给作者，内容不会对外展示，操作将留存记录。',
      confirmText: '确认' + labels[decision],
      confirmColor: decision === 'approve' ? '#0878BD' : '#B83D49'
    });
    this._confirming = false;
    if (!yes || this._visible === false || epoch !== this._epoch) return;
    this.setData({
      processing: true,
      error: ''
    });
    try {
      await C.callWall(decision === 'hide' ? 'hidePost' : 'reviewPost', {
        postId: this.postId,
        revision: this.data.post.revision,
        reason,
        ...(decision === 'hide' ? {} : {
          decision
        })
      });
      if (this._visible === false || epoch !== this._epoch) return;
      wx.showToast({
        title: '已' + labels[decision],
        icon: 'success'
      });
      this.setData({
        reason: ''
      });
      this.updateReasonLeaveAlert();
      await this.load()
    } catch (e) {
      if (this._visible === false || epoch !== this._epoch) return;
      if (e.code === 'CONFLICT' || e.code === 'CONTENT_REJECTED') {
        await this.load();
        this.setData({
          error: e.code === 'CONTENT_REJECTED' ? e.message : '内容已被另一项操作处理，已刷新为最新状态。未覆盖已有处理结果。'
        })
      } else this.setData({
        error: e.message
      })
    } finally {
      if (this._visible !== false) this.setData({
        processing: false
      })
    }
  }
});
