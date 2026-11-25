const C = require('./campus');

function makeList({
  action = 'list',
  field = 'posts',
  route = '',
  admin = false,
  filters = false,
  extra = {}
} = {}) {
  const retainTab = ['pages/campus-wall/index', 'pages/experience/index'].includes(route) && action === 'list';
  return {
    data: {
      items: [],
      member: null,
      canManageAdmins: false,
      access: 'loading',
      loading: true,
      loadingMore: false,
      error: '',
      pageError: '',
      sessionNotice: '',
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
      // Native tabs retain their page instance and scroll position for this run.
      // Recheck permissions without replacing the feed on a return visit.
      if (retainTab && this._hasLoadedList) await this.checkCachedSession();
      else if (retainTab) {
        if (this._firstShowRun) return this._firstShowRun;
        const pending = this.refreshSession();
        this._firstShowRun = pending;
        try { await pending; } finally {
          if (this._firstShowRun === pending) this._firstShowRun = null;
        }
      } else await this.refreshSession();
    },
    clearProtectedList(access, error = '') {
      this._sessionSeq = (this._sessionSeq || 0) + 1;
      this._listSeq = (this._listSeq || 0) + 1;
      this._hasLoadedList = false;
      this._filterCache = {};
      this.setData({
        access, canManageAdmins: false, items: [], hasMore: false, nextCursor: null,
        loading: false, loadingMore: false, error, pageError: '', sessionNotice: '', wallNotice: ''
      });
    },
    async checkCachedSession() {
      const seq = (this._sessionSeq || 0) + 1;
      this._sessionSeq = seq;
      try {
        const session = await C.callWall('session');
        if (seq !== this._sessionSeq) return;
        const previousId = this.data.member && this.data.member.id;
        const nextId = session.member && session.member.id;
        this.setData({ member: session.member, access: session.access, canManageAdmins: session.canManageAdmins === true, sessionNotice: '' });
        if (session.access !== 'approved' || session.member?.banned || (admin && (!session.member || session.member.role !== 'admin'))) {
          this.clearProtectedList(session.access, admin && session.access === 'approved' ? '此页面仅向管理员开放。' : '');
          return;
        }
        if (previousId && nextId && previousId !== nextId) {
          // Never reuse another account's protected feed after an identity change.
          this.clearProtectedList('approved');
          this.setData({ canManageAdmins: session.canManageAdmins === true });
          await this.load(true);
        }
      } catch (error) {
        if (seq !== this._sessionSeq) return;
        if (['ACCESS_DENIED', 'FORBIDDEN', 'UNAUTHENTICATED', 'ACCOUNT_BANNED'].includes(error.code)) {
          this.clearProtectedList('revoked', error.message);
        } else {
          this.setData({ sessionNotice: '暂时未能核对内测资格，已保留当前内容。可下拉重试。' });
        }
      }
    },
    async refreshSession() {
      if (retainTab) this._filterCache = {};
      const seq = (this._sessionSeq || 0) + 1;
      this._sessionSeq = seq;
      this._listSeq = (this._listSeq || 0) + 1;
      this.setData({
        loading: true,
        loadingMore: false,
        error: '',
        pageError: '',
        sessionNotice: ''
      });
      try {
        const s = await C.callWall('session');
        if (seq !== this._sessionSeq) return;
        this.setData({
          member: s.member,
          access: s.access,
          canManageAdmins: s.canManageAdmins === true
        });
        if (s.access !== 'approved' || s.member?.banned || (admin && (!s.member || s.member.role !== 'admin'))) {
          this.clearProtectedList(s.access, admin && s.access === 'approved' ? '此页面仅向管理员开放。' : '');
          return
        }
        await this.load(true)
      } catch (e) {
        if (seq !== this._sessionSeq) return;
        if (['ACCESS_DENIED', 'FORBIDDEN', 'UNAUTHENTICATED', 'ACCOUNT_BANNED'].includes(e.code)) {
          this.clearProtectedList('revoked', e.message);
          return;
        }
        this.setData({
          loading: false,
          error: e.message,
          access: this.data.items.length ? this.data.access : 'error'
        })
      }
    },
    async load(reset = false) {
      if (this.data.access !== 'approved' || (admin && (!this.data.member || this.data.member.role !== 'admin'))) return;
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
        this._hasLoadedList = true;
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
          loadingMore: false,
          wallNotice: ''
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
        if (['ACCESS_DENIED', 'FORBIDDEN', 'UNAUTHENTICATED', 'ACCOUNT_BANNED'].includes(e.code)) {
          this.clearProtectedList(e.code === 'ACCESS_DENIED' ? 'revoked' : this.data.access, e.message);
        }
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
    onPageScroll(event) { this._scrollTop = event.scrollTop || 0; },
    changeFilter(e) {
      const filter = e.currentTarget.dataset.value || '';
      if (this.data.filter === filter) return;
      if (retainTab && this._hasLoadedList && !this.data.loading) {
        this._filterCache = this._filterCache || {};
        this._filterCache[this.data.filter] = { items: this.data.items, hasMore: this.data.hasMore, nextCursor: this.data.nextCursor, scrollTop: this._scrollTop || 0 };
        const cached = this._filterCache[filter];
        if (cached) {
          this._listSeq = (this._listSeq || 0) + 1;
          this.setData({ ...cached, filter, loading: false, loadingMore: false, error: '', pageError: '' });
          if (wx.pageScrollTo) wx.pageScrollTo({ scrollTop: cached.scrollTop, duration: 0 });
          return;
        }
      }
      this.setData({
        filter,
        items: [],
        hasMore: false,
        nextCursor: null
      });
      this.load(true)
    },
    listParams() { return { ...(this.data.community ? { community: this.data.community } : {}), ...(filters && this.data.filter ? { category: this.data.filter } : {}) }; },
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
