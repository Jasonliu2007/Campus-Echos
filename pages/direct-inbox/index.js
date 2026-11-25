const C = require('../../utils/campus');
Page({
  data: { threads: [], items: [], query: '', tab: 'inbox', loading: true, error: '' },
  onShow() {
    this.setData({ reducedTransparency: C.getReducedTransparency() });
    C.syncTab(this, 'pages/direct-inbox/index');
    return this.load(this._loaded);
  },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  async load(quiet = false) {
    const seq = this.seq = (this.seq || 0) + 1;
    if (quiet !== true) this.setData({ loading: true, error: '' });
    try {
      const { threads } = await C.callWall('directList');
      if (seq === this.seq) {
        this._loaded = true;
        this.setData({ threads, items: this.filtered(threads), error: '', loading: false });
      }
    } catch (error) {
      if (seq === this.seq && (quiet !== true || ['ACCESS_DENIED', 'FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code))) {
        this._loaded = false;
        this.setData({ threads: [], items: [], error: error.message });
      }
    } finally { if (seq === this.seq) this.setData({ loading: false }); }
  },
  filtered(threads) {
    const query = this.data.query.trim().toLowerCase();
    return threads.filter(row => {
      const request = row.status === 'pending' && row.incoming;
      return request === (this.data.tab === 'requests') &&
        (!query || (row.name || '').toLowerCase().includes(query));
    }).map(row => ({ ...row, time: C.formatTime(row.updatedAt) }));
  },
  filter() { this.setData({ items: this.filtered(this.data.threads) }); },
  search(e) { this.setData({ query: e.detail.value }); this.filter(); },
  select(e) { this.setData({ tab: e.currentTarget.dataset.tab }); this.filter(); },
  open(e) { wx.navigateTo({ url: '/pages/direct-chat/index?id=' + encodeURIComponent(e.currentTarget.dataset.id) }); },
  compose() { this.setData({ composing: true, nickname: '', users: null, findError: '' }); },
  closeCompose() { this.findSequence = (this.findSequence || 0) + 1; this.setData({ composing: false, finding: false }); },
  nickname(e) {
    this.findSequence = (this.findSequence || 0) + 1;
    this.setData({ nickname: e.detail.value, users: null, findError: '', finding: false });
  },
  async findMember() {
    const nickname = this.data.nickname.trim();
    if (!this.data.composing || this.data.finding || Array.from(nickname).length < 2) return;
    const sequence = this.findSequence = (this.findSequence || 0) + 1;
    this.setData({ finding: true, findError: '', users: null });
    try {
      const { users } = await C.callWall('directFindMember', { nickname });
      if (sequence === this.findSequence) this.setData({ users });
    } catch (error) {
      if (sequence === this.findSequence) this.setData({ findError: error.message });
    } finally {
      if (sequence === this.findSequence) this.setData({ finding: false });
    }
  },
  openMember(e) {
    wx.navigateTo({ url: '/pages/direct-chat/index?peer=' + encodeURIComponent(e.currentTarget.dataset.id) });
  },
});
