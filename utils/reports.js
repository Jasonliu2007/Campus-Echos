const C = require('./campus');
const Media = require('./forum-media');

const reasons = [
  { value: 'illegal', label: '违法违规' },
  { value: 'scam', label: '诈骗广告' },
  { value: 'privacy', label: '侵犯隐私' },
  { value: 'academic', label: '学术不端' },
  { value: 'abuse', label: '人身攻击' },
  { value: 'other', label: '其他' }
];
const states = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待处理' },
  { value: 'hidden', label: '已下架' },
  { value: 'dismissed', label: '未认定违规' },
  { value: 'unavailable', label: '内容已不可见' }
];
const results = {
  pending: '管理员将核对相关内容，请等待处理结果。',
  hidden: '已完成人工核实，相关内容已下架。',
  dismissed: '已完成人工核实，暂未认定违规。',
  unavailable: '相关内容已不可见，本次举报已结案。'
};
const postStates = {
  published: '已公开', hidden: '已下架', deleted: '已删除',
  pending: '待审核', rejected: '未通过'
};
const length = (value) => Array.from(value || '').length;

function format(report) {
  const item = {
    ...report,
    number: String(report._id || '').slice(-8).toUpperCase(),
    reasonLabel: (reasons.find((reason) => reason.value === report.reasonCode) || {}).label || '举报记录',
    statusLabel: (states.find((state) => state.value === report.status) || {}).label || '处理中',
    displayTime: C.formatTime(report.createdAt),
    resolvedTime: report.resolvedAt ? C.formatTime(report.resolvedAt) : '',
    expiresTime: report.evidenceExpiresAt ? C.formatTime(report.evidenceExpiresAt) : '',
    resultCopy: results[report.status] || '',
    postState: (report.targetType === 'comment' ? report.currentComment : report.currentPost) ? postStates[(report.targetType === 'comment' ? report.currentComment : report.currentPost).status] || '状态已变化' : '内容已不可见'
  };
  // Server retention is authoritative. Also remove already rendered text at expiry.
  if (item.evidenceExpired || (item.evidenceExpiresAt && item.evidenceExpiresAt <= Date.now())) {
    item.evidenceExpired = true;
    item.detail = '';
    item.snapshot = null;
    item.resolveReason = '';
  }
  return item;
}

function preferences() {
  return { reducedMotion: C.getReducedMotion(), reducedTransparency: C.getReducedTransparency() };
}

function denied(error) {
  return ['ACCESS_DENIED', 'FORBIDDEN', 'UNAUTHENTICATED', 'ACCOUNT_BANNED'].includes(error.code);
}

function leaveAlert(page, dirty, message) {
  if (dirty && wx.enableAlertBeforeUnload) {
    wx.enableAlertBeforeUnload({ message });
    page._leaveAlert = true;
  } else if (page._leaveAlert && wx.disableAlertBeforeUnload) {
    wx.disableAlertBeforeUnload();
    page._leaveAlert = false;
  }
}

function dispose(page) {
  page._visible = false;
  page._epoch = (page._epoch || 0) + 1;
  clearTimeout(page._expiry);
}

function makeList(admin = false) {
  return {
    data: {
      loading: true, loadingMore: false, error: '', pageError: '', items: [],
      allowed: false, accessError: false, filter: admin ? 'pending' : '', filters: states,
      hasMore: false, nextCursor: null, admin,
      reducedMotion: false, reducedTransparency: false
    },
    onShow() {
      this._visible = true;
      this.setData(preferences());
      return this.refresh();
    },
    onHide() {
      dispose(this);
      this.setData({ loadingMore: false, loading: false, items: [], hasMore: false, nextCursor: null });
    },
    onUnload() { dispose(this); },
    async refresh() {
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ loading: true, error: '', pageError: '', loadingMore: false, accessError: false });
      try {
        const session = await C.callWall('session');
        if (!this._visible || epoch !== this._epoch) return;
        const allowed = session.access === 'approved' && (!admin || session.member && session.member.role === 'admin');
        this.setData({ allowed, accessError: !allowed });
        if (!allowed) {
          this.setData({ items: [], hasMore: false, nextCursor: null, loading: false });
          return;
        }
        await this.load(true, epoch);
      } catch (error) {
        if (this._visible && epoch === this._epoch) {
          this.setData({ error: error.message, loading: false, allowed: false, accessError: denied(error), items: [], hasMore: false, nextCursor: null });
        }
      }
    },
    async load(reset = false, existingEpoch) {
      if (!this._visible || !this.data.allowed || (!reset && (this.data.loading || this.data.loadingMore || !this.data.hasMore))) return;
      const epoch = reset ? existingEpoch || ++this._epoch : this._epoch;
      const filter = this.data.filter;
      this.setData(reset ? { loading: true, error: '', pageError: '', loadingMore: false } : { loadingMore: true, pageError: '' });
      try {
        const response = await C.callWall(admin ? 'reviewReports' : 'listMyReports', {
          ...(filter ? { status: filter } : {}),
          ...(!reset && this.data.nextCursor ? { cursor: this.data.nextCursor } : {})
        });
        if (!this._visible || epoch !== this._epoch) return;
        const rows = (response.reports || []).map(format);
        const items = reset ? rows : this.data.items.concat(rows.filter((row) => !this.data.items.some((item) => item._id === row._id)));
        this.setData({ items, hasMore: !!response.hasMore, nextCursor: response.nextCursor || null, loading: false, loadingMore: false });
      } catch (error) {
        if (!this._visible || epoch !== this._epoch) return;
        this.setData(reset ? { error: error.message, loading: false } : { pageError: error.message, loadingMore: false });
        if (denied(error)) this.setData({ allowed: false, accessError: true, items: [], hasMore: false, nextCursor: null });
      }
    },
    changeFilter(event) {
      const filter = event.currentTarget.dataset.value || '';
      if (filter === this.data.filter || !states.some((state) => state.value === filter)) return;
      this.setData({ filter, items: [], nextCursor: null, hasMore: false });
      return this.load(true);
    },
    loadMore() { return this.load(false); },
    retry() { return this.refresh(); },
    async onPullDownRefresh() {
      try { await this.refresh(); } finally { wx.stopPullDownRefresh(); }
    },
    onReachBottom() { return this.load(false); },
    open(event) {
      const section = admin ? 'admin-reports' : 'my-reports';
      wx.navigateTo({ url: '/pages/' + section + '/detail?id=' + event.currentTarget.dataset.id });
    },
    wall() { wx.switchTab({ url: '/pages/campus-wall/index' }); },
    goAccess: C.goAccess
  };
}

function makeDetail(admin = false) {
  return {
    data: {
      loading: true, error: '', allowed: false, accessError: false, report: null, admin,
      reason: '', reasonCount: 0, reasonError: '', decision: 'hide',
      processing: false, conflict: false, info: '',
      reducedMotion: false, reducedTransparency: false, evidenceImages: []
    },
    onLoad(query) { this.reportId = query.id; },
    onShow() {
      this._visible = true;
      this.setData(preferences());
      return this.load();
    },
    onHide() {
      dispose(this);
      this.setData({ report: null, evidenceImages: [], loading: false, processing: false });
    },
    onUnload() {
      dispose(this);
      leaveAlert(this, false);
      this.data.reason = ''; this.data.evidenceImages = [];
    },
    async load() {
      if (this.data.processing) return;
      const epoch = this._epoch = (this._epoch || 0) + 1;
      this.setData({ loading: true, error: '', accessError: false });
      clearTimeout(this._expiry);
      try {
        const session = await C.callWall('session');
        if (!this._visible || epoch !== this._epoch) return;
        const allowed = session.access === 'approved' && (!admin || session.member && session.member.role === 'admin');
        this.setData({ allowed, accessError: !allowed });
        if (!allowed) {
          this.setData({ report: null, evidenceImages: [], loading: false });
          return;
        }
        const response = await C.callWall('getReport', { reportId: this.reportId });
        if (!this._visible || epoch !== this._epoch) return;
        const report = format(response.report);
        this.setData({ report, loading: false, conflict: false, evidenceImages: [] });
        this.armExpiry();
        if (admin && report.snapshot?.mediaIds?.length && !report.evidenceExpired) {
          const images = await Media.hydrate({ _id: report.postId, mediaIds: report.snapshot.mediaIds }, this.reportId);
          if (!this._visible || epoch !== this._epoch) return;
          const current = format(this.data.report);
          this.setData({ report: current, evidenceImages: current.evidenceExpired ? [] : images });
        }
        if (report.status !== 'pending') {
          this.setData({ reason: '', reasonCount: 0, reasonError: '' });
          leaveAlert(this, false);
        }
        this.armExpiry();
      } catch (error) {
        if (!this._visible || epoch !== this._epoch) return;
        this.setData({ error: error.message, report: null, evidenceImages: [], loading: false, accessError: denied(error) });
        if (denied(error)) this.setData({ allowed: false });
      }
    },
    armExpiry() {
      clearTimeout(this._expiry);
      const report = this.data.report;
      if (!report || !report.evidenceExpiresAt || report.evidenceExpired) return;
      const epoch = this._epoch;
      // Browser timers cap delays at 2^31-1 ms, shorter than the 30-day period.
      const wait = Math.min(2147483647, Math.max(0, report.evidenceExpiresAt - Date.now()));
      this._expiry = setTimeout(() => {
        if (!this._visible || epoch !== this._epoch || !this.data.report) return;
        const report = format(this.data.report);
        this.setData({ report, ...(report.evidenceExpired ? { evidenceImages: [] } : {}) });
        this.armExpiry();
      }, wait);
    },
    input(event) {
      if (this.data.processing || this._confirming) return;
      const reason = event.detail.value;
      this.setData({ reason, reasonCount: length(reason), reasonError: '', focusReason: false, error: this.data.conflict ? this.data.error : '' });
      leaveAlert(this, !!reason.trim(), '处理说明尚未提交，离开会丢失本次输入。');
      return reason;
    },
    choose(event) {
      if (this.data.processing || this._confirming) return;
      const decision = event.currentTarget.dataset.value;
      if (['hide', 'dismiss'].includes(decision)) this.setData({ decision });
    },
    async decide() {
      const report = this.data.report;
      if (!admin || !this.data.allowed || !report || report.status !== 'pending' || this.data.loading || this.data.processing || this._confirming || this.data.conflict || report.evidenceExpired) return;
      const reason = this.data.reason.trim();
      if (length(reason) < 2 || length(reason) > 200) {
        this.setData({ reasonError: '请填写2–200字处理说明。', focusReason: true });
        return;
      }
      const currentTarget = report.targetType === 'comment' ? report.currentComment : report.currentPost;
      const unavailable = !currentTarget || currentTarget.status !== 'published' || !report.currentPost || report.currentPost.status !== 'published';
      const label = unavailable ? '内容已不可见并结案' : this.data.decision === 'hide' ? '认定违规并下架' : '未认定违规并结案';
      const epoch = this._epoch;
      const decision = this.data.decision;
      this._confirming = true;
      const yes = await C.confirm({
        title: '确认本次处理？',
        content: '处置结果：' + label + '。本次操作会留下记录，处理说明仅管理员可见。',
        confirmText: '确认处理'
      });
      this._confirming = false;
      if (!yes || !this._visible || epoch !== this._epoch) return;
      this.setData({ processing: true, error: '', info: '' });
      try {
        await C.callWall('resolveReport', {
          reportId: this.reportId,
          revision: report.revision,
          postRevision: report.currentPost ? report.currentPost.revision : 0,
          ...(report.targetType === 'comment' ? { commentRevision: report.currentComment ? report.currentComment.revision : 0 } : {}),
          decision,
          reason
        });
        if (!this._visible || epoch !== this._epoch) return;
        this.setData({ reason: '', reasonCount: 0, processing: false, info: '处理已完成。' });
        leaveAlert(this, false);
        await this.load();
      } catch (error) {
        if (!this._visible || epoch !== this._epoch) return;
        this.setData({ error: error.message, processing: false, conflict: error.code === 'CONFLICT' });
        if (denied(error)) this.setData({ allowed: false, accessError: true, report: null });
      }
    },
    previewEvidence(event) { if (!this.data.report || format(this.data.report).evidenceExpired) { this.setData({ evidenceImages: [] }); return; } const row = this.data.evidenceImages.find(x => x.mediaId === event.currentTarget.dataset.id); if (row?.url) wx.previewImage({ current: row.url, urls: this.data.evidenceImages.map(x => x.url).filter(Boolean) }); },
    async refreshConflict() {
      this.setData({ info: '刷新后请重新核对内容，并再次确认。' });
      return this.load();
    },
    async back() {
      if (this.data.processing || this._confirming) return;
      const epoch = this._epoch;
      if (admin && this.data.reason.trim()) {
        this._confirming = true;
        const yes = await C.confirm({
          title: '放弃未提交的处理说明？', content: '离开后本次输入会丢失。',
          confirmText: '放弃并离开', cancelText: '继续核对'
        });
        this._confirming = false;
        if (!yes || !this._visible || epoch !== this._epoch) return;
      }
      leaveAlert(this, false);
      C.goBack();
    },
    wall() { wx.switchTab({ url: '/pages/campus-wall/index' }); },
    goAccess: C.goAccess
  };
}

module.exports = { reasons, states, results, length, format, preferences, denied, leaveAlert, dispose, makeList, makeDetail };
