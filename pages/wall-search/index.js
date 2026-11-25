const C = require('../../utils/campus');
const { segments } = require('../../utils/forum-search');

const HISTORY_KEY = 'campusSearchHistory:v1';
const MAX_HISTORY = 10;
const DENIED = ['ACCESS_DENIED', 'UNAUTHENTICATED', 'FORBIDDEN', 'ACCOUNT_BANNED'];
const normalizeQuery = value => value.trim().normalize('NFKC').toLowerCase();

function historyRows(community) {
  try {
    const stored = wx.getStorageSync(HISTORY_KEY + ':' + community);
    return Array.isArray(stored) ? stored.filter(value => typeof value === 'string' && value.trim() && Array.from(value).length <= 60).slice(0, MAX_HISTORY) : [];
  } catch (error) { return []; }
}


Page({
  data: {
    query: '', category: '', categories: ['全部', ...C.categories], ranges: ['全部时间', '近7天', '近30天'],
    range: 0, community: 'forum', items: [], loading: false, loadingMore: false, searched: false,
    error: '', pageError: '', hasMore: false, nextCursor: null, needsSearch: false,
    history: [], trends: [], recommended: [], discoveryLoading: false, discoveryError: '', trendsAvailable: true,
    focused: false, reducedMotion: false, reducedTransparency: false
  },
  onLoad(q = {}) {
    this._pickQuote = q.pickQuote === '1';
    this.setData({ pickQuote: this._pickQuote });
    const community = q.community === 'experience' ? 'experience' : 'forum';
    this.setData({ history: historyRows(community), community, category: C.categories.includes(q.category) ? q.category : '' });
  },
  onReady() { this._ready = true; this.loadDiscovery(); },
  onShow() {
    this._visible = true;
    this.setData({ reducedMotion: C.getReducedMotion(), reducedTransparency: C.getReducedTransparency() });
    if (this._ready) this.loadDiscovery();
  },
  onHide() {
    this._visible = false;
    this._discoverySeq = (this._discoverySeq || 0) + 1;
    this.setData({ discoveryLoading: false });
    this._seq = (this._seq || 0) + 1;
    this.setData({ loading: false, loadingMore: false });
  },
  onUnload() { this.onHide(); },
  writeHistory(rows) {
    this.setData({ history: rows });
    try { wx.setStorageSync(HISTORY_KEY + ':' + this.data.community, rows); } catch (error) {}
  },
  removeHistory(e) {
    const target = e.currentTarget.dataset.query;
    this.writeHistory(this.data.history.filter(value => value !== target));
    this.rankRecommendations();
  },
  clearHistory() {
    this.writeHistory([]);
    this.rankRecommendations();
  },
  rankRecommendations() {
    const recent = this.data.history.slice(0, 5).map(normalizeQuery);
    const posts = this._discoveryPosts || [];
    const ranked = posts.map(post => {
      const searchable = normalizeQuery([post.title, post.discoveryExcerpt, post.category].filter(Boolean).join(' '));
      const matches = recent.reduce((score, query, index) => score + (searchable.includes(query) ? 5 - index : 0), 0);
      return { post, matches };
    }).sort((a, b) => b.matches - a.matches);
    this.setData({ recommended: ranked.slice(0, 5).map(row => row.post) });
  },
  async loadDiscovery() {
    if (this.data.discoveryLoading) return;
    const seq = this._discoverySeq = (this._discoverySeq || 0) + 1;
    this.setData({ discoveryLoading: true, discoveryError: '' });
    try {
      let data;
      try { data = await C.callWall('searchDiscovery', { community: this.data.community }); }
      catch (error) {
        if (error.code !== 'INVALID_ACTION') throw error;
        const fallback = await C.callWall('list', { community: this.data.community });
        data = { trends: [], recommendations: fallback.posts, legacy: true };
      }
      if (seq !== this._discoverySeq || this._visible === false) return;
      this._discoveryPosts = data.recommendations.map(post => C.formatPost({
        ...post, discoveryExcerpt: post.discoveryExcerpt || Array.from(post.content || '').slice(0, 120).join('')
      }));
      this.setData({ trends: data.trends, trendsAvailable: !data.legacy });
      this.rankRecommendations();
    } catch (error) {
      if (seq !== this._discoverySeq || this._visible === false) return;
      if (DENIED.includes(error.code)) {
        this._discoveryPosts = [];
        this.setData({ trends: [], recommended: [] });
      }
      this.setData({ discoveryError: error.message });
    } finally {
      if (seq === this._discoverySeq && this._visible !== false) this.setData({ discoveryLoading: false });
    }
  },
  focus() { this.setData({ focused: true }); },
  blur() { this.setData({ focused: false }); },
  clearQuery() {
    this._completedScope = '';
    this.changed({ query: '', items: [], range: 0, searched: false, hasMore: false, nextCursor: null });
  },
  chooseQuery(e) {
    const { query, today } = e.currentTarget.dataset;
    this.changed({ query, category: '', range: today ? 3 : 0 });
    return this.search();
  },
  queryScope() { return JSON.stringify([this.data.query.trim(), this.data.category, this.data.community, this.data.range]); },
  changed(patch) {
    this._seq = (this._seq || 0) + 1;
    this.setData({ ...patch, loading: false, loadingMore: false, error: '', pageError: '' });
    this.setData({ needsSearch: !!this._completedScope && this.queryScope() !== this._completedScope });
  },
  input(e) { if (!e.detail.value) this.clearQuery();
    else this.changed({ query: e.detail.value, ...(this.data.range === 3 ? { range: 0 } : {}) }); return e.detail.value; },
  category(e) {
    const selected = this.data.categories[Number(e.detail.value)];
    if (selected) this.changed({ category: selected === '全部' ? '' : selected });
  },
  range(e) {
    const range = Number(e.detail.value);
    if ([0, 1, 2].includes(range)) this.changed({ range });
  },
  search() { return this.load(true); },
  async load(reset = false) {
    if (this.data.loading || this.data.loadingMore || (!reset && !this.data.hasMore)) return;
    const scope = this.queryScope();
    if (!reset && scope !== this._completedScope) {
      this.setData({ needsSearch: true, pageError: '条件已修改，请点击搜索。当前结果保留，未混用旧分页。' });
      return;
    }
    const query = this.data.query.trim();
    if (!query || Array.from(query).length > 60) { this.setData({ error: '请输入1–60字关键词。' }); return; }
    const seq = this._seq = (this._seq || 0) + 1;
    this.setData({ loading: reset, loadingMore: !reset, error: '', pageError: '' });
    try {
      const r = await C.callWall('searchPosts', {
        query, category: this.data.category, community: this.data.community,
        timeRange: ['all', '7d', '30d', 'today'][this.data.range], ...(!reset ? { cursor: this.data.nextCursor } : {})
      });
      if (this._visible === false || seq !== this._seq || scope !== this.queryScope()) return;
      if (reset) {
        const normalized = normalizeQuery(query);
        this.writeHistory([query, ...this.data.history.filter(value => normalizeQuery(value) !== normalized)].slice(0, MAX_HISTORY));
        this.rankRecommendations();
      }
      const rows = r.posts.map(row => ({ ...C.formatPost(row), titleSegments: segments(row.title, row.highlights), summarySegments: segments(row.summary, row.highlights) }));
      const seen = new Set();
      this._completedScope = scope;
      this.setData({
        items: (reset ? rows : this.data.items.concat(rows)).filter(row => !seen.has(row._id) && seen.add(row._id)),
        searched: true, needsSearch: false, hasMore: r.hasMore, nextCursor: r.nextCursor, loading: false, loadingMore: false
      });
    } catch (e) {
      if (this._visible === false || seq !== this._seq) return;
      this.setData({ loading: false, loadingMore: false, ...(reset ? { error: e.message } : { pageError: e.message }) });
      if (DENIED.includes(e.code)) {
        this._completedScope = '';
        this._discoveryPosts = [];
        this._discoverySeq = (this._discoverySeq || 0) + 1;
        this.setData({ items: [], trends: [], recommended: [], discoveryLoading: false, hasMore: false, nextCursor: null, needsSearch: false });
      }
    }
  },
  loadMore() { return this.load(false); },
  onReachBottom() { return this.load(false); },
  async onPullDownRefresh() { try { await (this.data.query.trim() ? this.search() : this.loadDiscovery()); } finally { wx.stopPullDownRefresh(); } },
  open(e) {
    const id = e.currentTarget.dataset.id;
    if (this._pickQuote) {
      const post = [...(this.data.recommended || []), ...this.data.items].find(row => row._id === id);
      if (!post || post.canReply === false) { wx.showToast({ title: '这条帖子不可引用', icon: 'none' }); return; }
      this.getOpenerEventChannel().emit('quoteSelected', post);
      wx.navigateBack();
      return;
    }
    wx.navigateTo({ url: '/pages/wall-detail/index?id=' + encodeURIComponent(id) });
  },
  latest() {
    if (this.data.community === 'experience') { wx.navigateTo({ url: '/pages/experience/index' }); return; }
    const category = this.data.category;
    wx.switchTab({ url: '/pages/campus-wall/index', success() {
      const pages = getCurrentPages(), page = pages[pages.length - 1];
      if (page && page.route === 'pages/campus-wall/index' && typeof page.changeFilter === 'function') page.changeFilter({ currentTarget: { dataset: { value: category } } });
    } });
  }
});
