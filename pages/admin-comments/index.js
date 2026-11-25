const C = require('../../utils/campus');
const denied = error => ['FORBIDDEN', 'ACCESS_DENIED', 'UNAUTHENTICATED', 'ACCOUNT_BANNED'].includes(error.code);

Page({
  data: {
    items: [], filter: 'pending', loading: true, loadingMore: false, error: '', pageError: '',
    hasMore: false, nextCursor: null, allowed: false, reason: '', reasonFor: '', processing: false,
    conflict: false, reducedMotion: false, reducedTransparency: false
  },
  onShow() {
    this._visible = true;
    this.setData({ reducedMotion: C.getReducedMotion(), reducedTransparency: C.getReducedTransparency(), processing: false });
    return this.refresh();
  },
  onHide() {
    this._visible = false; this._seq = (this._seq || 0) + 1;
    this.setData({ loading: false, loadingMore: false, processing: false });
  },
  onUnload() { this.onHide(); if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload(); },
  active(seq) { return this._visible !== false && seq === this._seq; },
  async refresh() {
    if (this.data.processing || this._confirming) return;
    const seq = this._seq = (this._seq || 0) + 1;
    this.setData({ loading: true, loadingMore: false, error: '' });
    try {
      const s = await C.callWall('session');
      if (!this.active(seq)) return;
      const allowed = s.access === 'approved' && s.member?.role === 'admin' && !s.member.banned;
      this.setData({ allowed });
      if (!allowed) { this.setData({ items: [], hasMore: false, nextCursor: null, loading: false, error: '仅管理员可处理评论。' }); return; }
      return this.load(true);
    } catch (e) {
      if (!this.active(seq)) return;
      this.setData({ loading: false, error: e.message });
      if (denied(e)) this.setData({ allowed: false, items: [], hasMore: false, nextCursor: null });
    }
  },
  async load(reset = false) {
    if (!this.data.allowed || this.data.processing || this._confirming || (!reset && (this.data.loading || this.data.loadingMore || !this.data.hasMore))) return;
    const seq = this._seq = (this._seq || 0) + 1;
    this.setData({ loading: reset, loadingMore: !reset, error: '', pageError: '' });
    try {
      const r = await C.callWall('reviewComments', { status: this.data.filter, ...(!reset ? { cursor: this.data.nextCursor } : {}) });
      if (!this.active(seq)) return;
      const rows = r.comments.map(x => ({ ...x, displayTime: C.formatTime(x.createdAt) })), seen = new Set();
      this.setData({ items: (reset ? rows : this.data.items.concat(rows)).filter(x => !seen.has(x._id) && seen.add(x._id)),
        hasMore: r.hasMore, nextCursor: r.nextCursor, loading: false, loadingMore: false, conflict: false });
    } catch (e) {
      if (!this.active(seq)) return;
      this.setData({ loading: false, loadingMore: false, ...(reset ? { error: e.message } : { pageError: e.message }) });
      if (denied(e)) this.setData({ allowed: false, items: [], hasMore: false, nextCursor: null });
    }
  },
  async discard(reasonFor, filter) {
    if (!this.data.reason.trim()) return true;
    const seq = this._seq;
    this._confirming = true;
    try {
      const yes = await C.confirm({ title: '放弃未提交的说明？', content: '切换处理对象或列表会清除本次原因。', confirmText: '放弃并切换' });
      return yes && this.active(seq) && this.data.reasonFor === reasonFor && this.data.filter === filter;
    } finally { this._confirming = false; }
  },
  leaveAlert() {
    if (this.data.reason.trim() && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '处理说明尚未提交，离开会丢失输入。' });
    else if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
  },
  async filter(e) {
    if (this.data.processing || this._confirming) return;
    const filter = e.currentTarget.dataset.value;
    if (!['pending', 'published'].includes(filter) || filter === this.data.filter) return;
    if (!await this.discard(this.data.reasonFor, this.data.filter)) return;
    this.setData({ filter, reason: '', reasonFor: '', conflict: false, items: [], hasMore: false, nextCursor: null });
    this.leaveAlert(); return this.load(true);
  },
  async choose(e) {
    if (this.data.processing || this._confirming) return;
    const id = e.currentTarget.dataset.id;
    if (id === this.data.reasonFor || !this.data.items.some(x => x._id === id)) return;
    if (!await this.discard(this.data.reasonFor, this.data.filter)) return;
    this.setData({ reasonFor: id, reason: '', error: '', conflict: false }); this.leaveAlert();
  },
  input(e) {
    if (this.data.processing || this._confirming) return this.data.reason;
    this.setData({ reason: e.detail.value, error: this.data.conflict ? this.data.error : '', focusReason: false }); this.leaveAlert(); return e.detail.value;
  },
  async decide(e) {
    const row = this.data.items.find(x => x._id === this.data.reasonFor), reason = this.data.reason.trim(), decision = e.currentTarget.dataset.decision;
    if (!row || !this.data.allowed || this.data.processing || this._confirming || this.data.loading || this.data.loadingMore || this.data.conflict) return;
    if (this.data.filter === 'pending' ? !['approve', 'reject'].includes(decision) : decision !== 'hide') return;
    if (Array.from(reason).length < 2 || Array.from(reason).length > 200) { this.setData({ error: '请填写2–200字核实说明。', focusReason: true }); return; }
    const seq = this._seq; this._confirming = true;
    const yes = await C.confirm({ title: '确认处理这条评论？', content: '将按当前版本处理并留存审计；批准仍需微信审核通过。', confirmText: '确认处理' });
    this._confirming = false; if (!yes || !this.active(seq)) return;
    this.setData({ processing: true, error: '' });
    try {
      await C.callWall('reviewComment', { commentId: row._id, revision: row.revision, decision, reason });
      if (!this.active(seq)) return;
      this.setData({ reason: '', reasonFor: '', processing: false }); this.leaveAlert(); return this.load(true);
    } catch (error) {
      if (!this.active(seq)) return;
      this.setData({ error: error.code === 'CONFLICT' ? '评论已有新结果，说明已保留。请刷新核对后再次确认。' : error.message, processing: false, conflict: error.code === 'CONFLICT' });
      if (denied(error)) this.setData({ allowed: false, items: [], hasMore: false, nextCursor: null });
      if (error.code === 'CONTENT_REJECTED') { await this.load(true); if (this._visible) this.setData({ error: error.message }); }
    }
  },
  open(e) { wx.navigateTo({ url: '/pages/wall-detail/index?id=' + e.currentTarget.dataset.id }); },
  more() { return this.load(false); },
  onReachBottom() { return this.load(false); },
  async onPullDownRefresh() { try { await this.refresh(); } finally { wx.stopPullDownRefresh(); } }
});
