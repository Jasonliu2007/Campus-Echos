const C = require('../../utils/campus');
const T = require('../../utils/trade');
const V = require('../../utils/trade-view');
Page({
  data: { expectedSales: '', feeQuote: null, feeBusy: false, feeError: '', feeOrderId: '', feeStatus: '', items: [], loading: true, error: '', hasMore: false, nextCursor: null, loadingMore: false, reducedMotion: false, reducedTransparency: false },
  onShow() { V.show(this); this.setData({ reducedMotion: C.getReducedMotion(), reducedTransparency: C.getReducedTransparency() }); return this.load(true); },
  onHide() { V.hide(this); this.setData({ feeQuote: null, feeBusy: false, feeError: '' }); },
  updateExpectedSales(event) {
    this.setData({ expectedSales: event.detail.value, feeQuote: null, feeError: '' });
  },
  async quoteFee() {
    if (this.data.feeBusy) return;
    const input = this.data.expectedSales.trim();
    if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(input)) {
      this.setData({ feeError: '请输入预计成交额，最多保留两位小数。' });
      return;
    }
    const [yuan, decimal = ''] = input.split('.');
    const expectedSalesCents = Number(yuan) * 100 + Number(decimal.padEnd(2, '0'));
    const view = V.token(this);
    this.setData({ feeBusy: true, feeQuote: null, feeError: '' });
    try {
      const { quote, sellerFeeCheckoutAvailable } = await T.call('quoteSellerServiceFee', { expectedSalesCents });
      if (V.current(this, view) && this.data.expectedSales.trim() === input) {
        this.setData({ feeQuote: { sales: T.money(quote.expectedSalesCents), fee: T.money(quote.feeCents), cents: quote.expectedSalesCents, checkout: sellerFeeCheckoutAvailable === true } });
      }
    } catch (error) {
      if (V.current(this, view) && this.data.expectedSales.trim() === input) this.setData({ feeError: error.message });
    } finally {
      if (V.current(this, view)) this.setData({ feeBusy: false });
    }
  }, onUnload() { V.unload(this); },
  async load(reset = false) {
    if (this._loading || (!reset && !this.data.hasMore)) return;
    const view = V.token(this); this._loading = true; this.setData({ loading: reset, loadingMore: !reset, error: '' });
    try {
      const r = await T.call('listMyMaterials', reset ? {} : { cursor: this.data.nextCursor });
      if (!V.current(this, view)) return;
      this.setData({ items: reset ? r.items.map(T.material) : this.data.items.concat(r.items.map(T.material)), hasMore: r.hasMore, nextCursor: r.nextCursor });
    } catch (error) {
      if (!V.current(this, view)) return;
      if (T.invalidAccess(error)) { V.invalidate(this); this.setData({ error: error.message, items: [], hasMore: false, nextCursor: null, loading: false, loadingMore: false }); }
      else this.setData({ error: error.message });
    } finally { if (V.current(this, view)) { this._loading = false; this.setData({ loading: false, loadingMore: false }); } }
  },
  retry() { return this.load(true); }, more() { return this.load(false); },
  open(event) { wx.navigateTo({ url: '/pages/material-submit/index?id=' + event.currentTarget.dataset.id }); },
  create() { wx.navigateTo({ url: '/pages/material-submit/index' }); }
});
