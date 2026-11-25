const V = require('../../utils/trade-view');
const C = require('../../utils/campus');
const T = require('../../utils/trade');
const { materials: demos } = require('../../utils/demo-data');
const sampleCovers = require('../../utils/sample-material-covers');

const coverByType = {
  课程笔记: '/static/material-covers/notes.jpg',
  知识总结: '/static/material-covers/summary.jpg',
  学习指南: '/static/material-covers/guide.jpg',
  经验整理: '/static/material-covers/experience.jpg'
};

const normalize = value => String(value || '').normalize('NFKC').trim().toLowerCase();

function matchingRows(rows, query, type) {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return rows.filter(row => {
    if (type && row.type !== type) return false;
    const searchable = normalize([row.title, row.course, row.type, row.description, ...(row.learningModes || [])].join(' '));
    return terms.every(term => searchable.includes(term));
  });
}

Page({
  data: {
    materials: [], leftCards: [], rightCards: [], categories: ['', ...T.MATERIAL_TYPES],
    query: '', submittedQuery: '', selectedType: '', demos, demo: false,
    loading: true, loadingMore: false, error: '', pageError: '', sessionNotice: '',
    hasMore: false, nextCursor: null, reducedMotion: false, reducedTransparency: false
  },
  onShow() {
    V.show(this);
    C.syncTab(this, 'pages/materials/index');
    this.setData({ reducedMotion: C.getReducedMotion(), reducedTransparency: C.getReducedTransparency() });
    if (!this._loaded) this.load(true);
    else {
      this.setData({ loading: false, loadingMore: false });
      this.checkSession();
    }
  },
  onHide() { V.hide(this); },
  onUnload() { V.unload(this); },
  clearAccess(message) {
    V.invalidate(this);
    this._loaded = false;
    this.setData({
      materials: [], leftCards: [], rightCards: [], hasMore: false, nextCursor: null,
      error: message, pageError: '', sessionNotice: '', loading: false, loadingMore: false
    });
  },
  async checkSession() {
    const view = V.token(this);
    try {
      const session = await T.call('session');
      if (!V.current(this, view)) return;
      if (session.access !== 'approved') this.clearAccess('请先核对内测资格。');
      else this.setData({ sessionNotice: '' });
    } catch (error) {
      if (!V.current(this, view)) return;
      if (T.invalidAccess(error)) this.clearAccess(error.message);
      else this.setData({ sessionNotice: '暂未能核对内测资格，请下拉重试。' });
    }
  },
  showMatches(patch = {}) {
    const state = { ...this.data, ...patch };
    const matches = matchingRows(state.materials, state.submittedQuery, state.selectedType);
    const leftCards = [], rightCards = [];
    matches.forEach((row, index) => (index % 2 ? rightCards : leftCards).push(row));
    this.setData({ ...patch, leftCards, rightCards });
  },
  async load(reset = false) {
    if (this._loading || (!reset && !this.data.hasMore)) return;
    const view = V.token(this);
    this._loading = true;
    this.setData({ loading: reset, loadingMore: !reset, error: '', pageError: '' });
    let rows = reset ? [] : this.data.materials.slice();
    const seen = new Set(rows.map(row => row._id));
    let cursor = reset ? null : this.data.nextCursor;
    const matchCount = matchingRows(rows, this.data.submittedQuery, this.data.selectedType).length;
    const cursors = new Set(cursor ? [cursor] : []);
    let pages = 0;
    try {
      do {
        pages += 1;
        const result = await T.call('listMaterials', cursor ? { cursor } : {});
        if (!V.current(this, view)) return;
        for (const record of result.items) {
          if (seen.has(record._id)) continue;
          seen.add(record._id);
          rows.push({ ...T.material(record), cover: sampleCovers[record._id] || coverByType[record.type] || coverByType.学习指南 });
        }
        if (result.hasMore && (!result.nextCursor || cursors.has(result.nextCursor))) {
          throw new Error('资料列表已变化，请下拉刷新。');
        }
        cursor = result.nextCursor;
        if (cursor) cursors.add(cursor);
        this._loaded = true;
        this.showMatches({ materials: rows.slice(), hasMore: result.hasMore, nextCursor: cursor, sessionNotice: '' });
      } while (pages < 5 && this.data.hasMore && matchingRows(rows, this.data.submittedQuery, this.data.selectedType).length === matchCount);
    } catch (error) {
      if (!V.current(this, view)) return;
      if (T.invalidAccess(error)) this.clearAccess(error.message);
      else this.setData(this.data.leftCards.length || this.data.hasMore ? { pageError: error.message } : { error: error.message });
    } finally {
      if (V.current(this, view)) {
        this._loading = false;
        this.setData({ loading: false, loadingMore: false });
      }
    }
  },
  applyFilters(patch) {
    this.showMatches({ ...patch, pageError: '' });
    if (!this.data.leftCards.length && this.data.hasMore) return this.load(false);
  },
  inputQuery(event) {
    const query = event.detail.value;
    if (!query) return this.clearSearch();
    this.setData({ query });
  },
  search() {
    const submittedQuery = this.data.query.trim();
    if (wx.hideKeyboard) wx.hideKeyboard();
    return this.applyFilters({ query: submittedQuery, submittedQuery });
  },
  clearSearch() { return this.applyFilters({ query: '', submittedQuery: '' }); },
  selectType(event) {
    const type = event.currentTarget.dataset.type || '';
    if (type !== this.data.selectedType && this.data.categories.includes(type)) return this.applyFilters({ selectedType: type });
  },
  resetFilters() { return this.applyFilters({ query: '', submittedQuery: '', selectedType: '' }); },
  retry() { return this.load(true); },
  loadMore() { return this.load(false); },
  onReachBottom() { if (!this.data.pageError) this.load(false); },
  async onPullDownRefresh() { try { await this.load(true); } finally { wx.stopPullDownRefresh(); } },
  toggleDemo() { this.setData({ demo: !this.data.demo }); },
  openMaterial(event) { wx.navigateTo({ url: '/pages/material-detail/index?id=' + encodeURIComponent(event.currentTarget.dataset.id) }); },
  openDemo(event) { wx.navigateTo({ url: '/pages/material-demo/index?id=' + encodeURIComponent(event.currentTarget.dataset.id) }); },
  upload() { wx.navigateTo({ url: '/pages/material-submit/index' }); },
  orders() { wx.navigateTo({ url: '/pages/trade-orders/index' }); },
  goAI() { wx.navigateTo({ url: '/pages/notes-ai/index' }); }
});
