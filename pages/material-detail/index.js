const V = require('../../utils/trade-view');
const C = require('../../utils/campus');
const T = require('../../utils/trade');
const sampleCovers = require('../../utils/sample-material-covers');
Page({
  data: { material: null, loading: true, error: '', busy: '', matching: null, modes: T.LEARNING_MODES, selectedMode: '', paidEnabled: false, reducedMotion: false, reducedTransparency: false },
  onLoad(query = {}) { this.materialId = query.id; },
  onShow() { V.show(this); this.setData({ busy: '' }); this.setData({ reducedMotion: C.getReducedMotion(), reducedTransparency: C.getReducedTransparency() }); this.load(this._loaded === true); },
  onHide() { V.hide(this); },
  onUnload() { V.unload(this); },
  clearAccess(message) { V.invalidate(this); this._loaded = false; this.setData({ material: null, matching: null, paidEnabled: false, error: message, busy: '', loading: false }); },
  async load(quiet = false) {
    if (this._loading) return;
    const view = V.token(this);
    const mode = this.data.selectedMode;
    const seq = this._seq = (this._seq || 0) + 1;
    this._loading = true; this.setData({ loading: quiet !== true, error: '' });
    try {
      const result = await T.call('getMaterial', { materialId: this.materialId, learningMode: mode });
      if (!V.current(this, view) || seq !== this._seq) return;
      this._loaded = true;
      const material = T.material(result.material);
      if (material.status === 'published' && sampleCovers[material._id]) material.sampleCover = sampleCovers[material._id];
      this.setData({ material, matching: result.matching, paidEnabled: result.paidEnabled === true });
    }
    catch (error) { if (seq === this._seq && V.current(this, view)) { if (T.invalidAccess(error)) this.clearAccess(error.message); else this.setData({ error: error.message }); } }
    finally { if (seq === this._seq && V.current(this, view)) { this._loading = false; this.setData({ loading: false }); if (this.data.selectedMode !== mode) this.load(true); } }
  },
  scrollTo(selector) { wx.pageScrollTo({ selector, offsetTop: -16, duration: this.data.reducedMotion ? 0 : 220, fail: () => this.setData({ error: '无法自动定位，请向下滑动查看。' }) }); },
  contents() { this.scrollTo('#contents'); },
  mode(e) { this.setData({ selectedMode: this.data.modes[Number(e.detail.value)] }); this.load(); },
  async preview() {
    if (this.data.busy) return; const view = V.token(this); this.setData({ busy: 'preview', error: '' });
    try { const result = await T.call('previewMaterial', { materialId: this.materialId }); if (!V.current(this, view)) return; await T.openDocument(result.url); }
    catch (error) { if (V.current(this, view)) { if (T.invalidAccess(error)) this.clearAccess(error.message); else this.setData({ error: error.message }); } } finally { if (V.current(this, view)) this.setData({ busy: '' }); }
  },
  async acquire() {
    if (this.data.busy || !this.data.material || this.data.material.isOwner) return;
    if (this.data.material.priceCents > 0 && !this.data.paidEnabled) { this.setData({ error: '付费尚未启用，请先查看目录与独立试读。' }); return; }
    const view = V.token(this);
    this.setData({ busy: 'acquire', error: '' });
    try {
      const session = await T.call('session'); if (!V.current(this, view)) return;
      if (!session.adultConfirmed) {
        const yes = await C.confirm({ title: '交易资格确认', content: '请确认你已满18岁。平台不采集身份证；站外付款可能显示双方身份，平台不代收、不退款或裁决钱款。', confirmText: '已满18岁并同意' });
        if (!yes || !V.current(this, view)) return; await T.call('confirmAdult', { adultConfirmed: true, termsAccepted: true }); if (!V.current(this, view)) return;
      }
      this._requestId = this._requestId || C.requestId();
      const result = await T.call('createOrder', { materialId: this.materialId, requestId: this._requestId });
      if (!V.current(this, view)) return;
      const orderId = result.orderId || result.order && result.order._id;
      if (!orderId) throw new Error('未取得订单编号，请重试。');
      wx.navigateTo({ url: '/pages/trade-order/index?id=' + orderId });
    } catch (error) { if (V.current(this, view)) { if (T.invalidAccess(error)) this.clearAccess(error.message); else this.setData({ error: error.message }); } } finally { if (V.current(this, view)) this.setData({ busy: '' }); }
  },
  contactSeller() { wx.navigateTo({ url: '/pages/direct-chat/index?material=' + encodeURIComponent(this.materialId) }); },
  edit() { wx.navigateTo({ url: '/pages/material-submit/index?id=' + this.materialId }); },
  report() { wx.navigateTo({ url: '/pages/trade-support/index?mode=complaint&materialId=' + this.materialId }); },
  back() { wx.switchTab({ url: '/pages/materials/index' }); }
});
