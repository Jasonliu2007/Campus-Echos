const C = require('./campus');

function makeList({
  action = 'list',
  field = 'posts',
  route = '',
  admin = false,
  filters = false,
  extra = {}
} = {}) {
  return {
    data: {
      items: [],
      member: null,
      access: 'loading',
      loading: true,
      loadingMore: false,
      error: '',
      pageError: '',
      hasMore: false,
      nextCursor: null,
      filter: '',
      reducedMotion: false,
      reducedTransparency: false,
      ...extra
    },
    async onShow() {
      if (route) C.syncTab(this, route);
      this.setData({
        reducedMotion: C.getReducedMotion(),
        reducedTransparency: C.getReducedTransparency()
      });
      await this.refreshSession()
    },
    async refreshSession() {
      const seq = (this._sessionSeq || 0) + 1;
      this._sessionSeq = seq;
      this._listSeq = (this._listSeq || 0) + 1;
      this.setData({
        loading: true,
        loadingMore: false,
        error: '',
        pageError: ''
      });
      try {
        const s = await C.callWall('session');
        if (seq !== this._sessionSeq) return;
        this.setData({
          member: s.member,
          access: s.access
        });
        if (s.access !== 'approved' || (admin && s.member.role !== 'admin')) {
          this.setData({
            loading: false,
            loadingMore: false,
            hasMore: false,
            nextCursor: null,
            items: [],
            error: admin && s.access === 'approved' ? '此页面仅向管理员开放。' : ''
          });
          return
        }
        await this.load(true)
      } catch (e) {
        if (seq === this._sessionSeq) this.setData({
          loading: false,
          error: e.message,
          access: this.data.items.length ? this.data.access : 'error'
        })
      }
    },
    async load(reset = false) {
      if (this.data.access !== 'approved' || (admin && this.data.member.role !== 'admin')) return;
      if (!reset && (this.data.loadingMore || this.data.loading || !this.data.hasMore)) return;
      const seq = (this._listSeq || 0) + 1;
      this._listSeq = seq;
      const params = {
        ...(typeof this.listParams === 'function' ? this.listParams() : {}),
        ...(reset ? {} : {
          cursor: this.data.nextCursor
        })
      };
      this.setData(reset ? {
        loading: true,
        loadingMore: false,
        error: '',
        pageError: ''
      } : {
        loadingMore: true,
        pageError: ''
      });
      try {
        const r = await C.callWall(action, params);
        if (seq !== this._listSeq) return;
        const rows = r[field].map(field === 'posts' ? C.formatPost : x => ({
          ...x,
          displayTime: C.formatTime(x.createdAt),
          statusLabel: C.accessLabels[x.status]
        }));
        const all = reset ? rows : this.data.items.concat(rows);
        const seen = new Set();
        this.setData({
          items: all.filter(x => {
            const id = x._id || x.id;
            if (seen.has(id)) return false;
            seen.add(id);
            return true
          }),
          hasMore: r.hasMore,
          nextCursor: r.nextCursor,
          loading: false,
          loadingMore: false
        })
      } catch (e) {
        if (seq !== this._listSeq) return;
        this.setData({
          loading: false,
          loadingMore: false,
          ...(reset ? {
            error: e.message
          } : {
            pageError: e.message
          })
        });
        if (['ACCESS_DENIED', 'FORBIDDEN'].includes(e.code)) this.setData({
          items: [],
          hasMore: false,
          nextCursor: null,
          access: e.code === 'ACCESS_DENIED' ? 'revoked' : this.data.access
        })
      }
    },
    async onPullDownRefresh() {
      try {
        await this.refreshSession()
      } finally {
        wx.stopPullDownRefresh()
      }
    },
    onReachBottom() {
      this.load(false)
    },
    retry() {
      this.refreshSession()
    },
    loadMore() {
      this.load(false)
    },
    changeFilter(e) {
      const filter = e.currentTarget.dataset.value || '';
      if (this.data.filter === filter) return;
      this.setData({
        filter,
        items: [],
        hasMore: false,
        nextCursor: null
      });
      this.load(true)
    },
    listParams() {
      return filters && this.data.filter ? {
        category: this.data.filter
      } : {}
    },
    openPost(e) {
      const id = (e.detail && e.detail.id) || e.currentTarget.dataset.id;
      wx.navigateTo({
        url: '/pages/wall-detail/index?id=' + id
      })
    },
    goAccess: C.goAccess,
    unavailable: C.showUnavailable,
  };
}
module.exports = {
  makeList
};
