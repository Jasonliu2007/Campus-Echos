const C = require('../../utils/campus');
const Attachment = require('../../utils/direct-attachment');
Page({
  data: { thread: null, messages: [], draft: '', error: '', busy: false, selecting: false, attachment: null, keyboard: 0 },
  onLoad(q = {}) {
    if (q.post) this.target = { postId: q.post };
    else if (q.peer) this.target = { peerId: q.peer };
    else if (q.order) this.target = { orderId: q.order };
    else if (q.material) this.target = { materialId: q.material };
    else this.target = { threadId: q.id };
  },
  onShow() {
    this.visible = true;
    this.setData({ reducedTransparency: C.getReducedTransparency() });
    this.load();
    this.checkAttachment();
  },
  async onPullDownRefresh() { try { await this.load(); await this.checkAttachment(); } finally { wx.stopPullDownRefresh(); } },
  onHide() {
    this.visible = false;
    clearTimeout(this.refreshTimer);
    this.seq = (this.seq || 0) + 1;
    this.setData({ keyboard: 0 });
  },
  onUnload() { this.visible = false; clearTimeout(this.refreshTimer); this.seq = (this.seq || 0) + 1; },
  async load(quiet = false) {
    clearTimeout(this.refreshTimer);
    const seq = this.seq = (this.seq || 0) + 1;
    try {
      const { thread, messages, trade } = await C.callWall('directOpen', this.target);
      if (seq !== this.seq) return;
      const last = messages[messages.length - 1]?.id;
      this.setData({ thread, messages: messages.map(row => ({ ...row, quoteAmount: row.quote ? (row.quote.cents / 100).toFixed(2) : '' })), trade,
        canSend: thread.status === 'accepted' || thread.status === 'new' || (thread.status === 'pending' && thread.incoming),
        error: '', anchor: last ? 'message-' + last : '' });
    } catch (error) {
      if (seq === this.seq && (quiet !== true || ['ACCESS_DENIED', 'NOT_FOUND', 'ACCOUNT_BANNED', 'FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code))) {
        this.setData({ thread: null, messages: [], canSend: false, trade: null, error: error.message });
      }
    } finally {
      if (this.visible && seq === this.seq && this.data.thread?.status && this.data.thread.status !== 'new') {
        this.refreshTimer = setTimeout(() => this.load(true), 5000);
      }
    }
  },
  async addAttachment() {
    if (this.data.selecting || this.data.busy || !this.data.canSend) return;
    this.setData({ selecting: true, error: '' });
    try {
      const path = await Attachment.chooseAttachment();
      if (!path) return;
      const uploaded = await C.callWall('directUpload', { ...this.target, requestId: C.requestId(), base64: await Attachment.base64(path) });
      this.setData({ attachment: { ...uploaded, path } });
    } catch (error) {
      this.setData({ error: error.message || '无法添加图片，请重试。' });
    } finally { this.setData({ selecting: false }); }
  },
  removeAttachment() {
    if (!this.data.busy && !this.data.selecting) this.setData({ attachment: null });
  },
  async checkAttachment() {
    const current = this.data.attachment;
    if (!current || !['checking', 'uploading'].includes(current.status)) return;
    try {
      const next = await C.callWall('getMedia', { mediaId: current.mediaId });
      if (this.data.attachment?.mediaId === current.mediaId) this.setData({ attachment: { ...current, ...next } });
    } catch (error) { this.setData({ error: error.message }); }
  },
  async openAttachment(e) {
    if (!this.data.thread || this.data.thread.status === 'new') return;
    try {
      const { url } = await C.callWall('directAttachment', { threadId: this.data.thread.id, messageId: e.currentTarget.dataset.id });
      wx.previewImage({ urls: [url], current: url });
    } catch (error) { wx.showToast({ title: error.message, icon: 'none' }); }
  },
  input(e) { this.setData({ draft: e.detail.value }); },
  keyboard(e) { this.setData({ keyboard: Math.max(0, Number(e.detail.height) || 0) }); },
  blur() { this.setData({ keyboard: 0 }); },
  openTrade(e) {
    const { type, id } = e.currentTarget.dataset;
    const route = type === 'order' ? 'trade-order' : 'material-detail';
    wx.navigateTo({ url: '/pages/' + route + '/index?id=' + encodeURIComponent(id) });
  },
  quote() {
    if (!this.data.canSend || this.data.busy || !this.data.trade) return;
    wx.showModal({
      title: '发送报价', editable: true, placeholderText: '填写金额（元）', confirmText: '发送',
      success: ({ confirm, content }) => {
        if (!confirm) return;
        const price = (content || '').trim();
        if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(price) || Number(price) > 100000) {
          this.setData({ error: '请输入 0 到 100,000 元，最多两位小数。' });
          return;
        }
        this.sendMessage(Math.round(Number(price) * 100));
      }
    });
  },
  send() { return this.sendMessage(); },
  async sendMessage(quoteCents) {
    const content = quoteCents === undefined ? this.data.draft.trim() : '';
    const attachment = quoteCents === undefined ? this.data.attachment : null;
    if (this.data.busy || this.data.selecting || !this.data.canSend || (!content && !attachment && quoteCents === undefined)) return;
    if (attachment && attachment.status !== 'approved') return;
    const trade = this.data.trade;
    const context = quoteCents === undefined || !trade ? {} : { [trade.type === 'order' ? 'orderId' : 'materialId']: trade.id, quoteCents };
    const fingerprint = JSON.stringify([content, attachment?.mediaId || '', context]);
    if (fingerprint !== this.pendingText) { this.pendingText = fingerprint; this.requestId = C.requestId(); }
    this.setData({ busy: true, error: '' });
    try {
      const { threadId } = await C.callWall('directSend', { ...this.target, ...context, content, ...(attachment ? { attachmentId: attachment.mediaId } : {}), requestId: this.requestId });
      const { materialId, orderId } = this.target;
      this.target = { threadId, ...(materialId ? { materialId } : {}), ...(orderId ? { orderId } : {}) };
      this.pendingText = '';
      const first = this.data.thread?.status === 'new';
      this.setData({ ...(quoteCents === undefined ? { draft: '', attachment: null } : {}),
        ...(first ? { 'thread.status': 'pending', canSend: false } : {}) });
      await this.load();
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ busy: false }); }
  },
  more() {
    if (this.data.thread?.status === 'new') return;
    wx.showActionSheet({ itemList: ['刷新消息', '屏蔽会话'], success: ({ tapIndex }) => {
      if (tapIndex === 1) this.respond('blocked'); else this.load();
    } });
  },
  async respond(status) {
    if (this.data.busy) return;
    this.setData({ busy: true, error: '' });
    try {
      await C.callWall('directRespond', { ...this.target, status });
      wx.navigateBack();
    } catch (error) { this.setData({ error: error.message }); }
    finally { this.setData({ busy: false }); }
  },
});
