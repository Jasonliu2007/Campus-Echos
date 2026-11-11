const C = require('../../utils/campus');
const {
  makeList
} = require('../../utils/wall-list');
Page({
  ...makeList({
    action: 'listMembers',
    field: 'members',
    admin: true,
    extra: {
      filter: 'pending',
      filters: [{
        value: 'pending',
        label: '待批准'
      }, {
        value: 'approved',
        label: '已获准'
      }, {
        value: 'rejected',
        label: '未通过'
      }, {
        value: 'revoked',
        label: '已撤销'
      }],
      processing: '',
      reasonFor: '',
      reason: '',
      decision: '',
      formError: ''
    }
  }),
  listParams() {
    return {
      status: this.data.filter
    }
  },
  updateReasonLeaveAlert() {
    const dirty = !!this.data.reason.trim();
    if (dirty && wx.enableAlertBeforeUnload) {
      wx.enableAlertBeforeUnload({ message: '处理原因尚未提交，离开会丢失输入。' });
      this._reasonLeaveAlert = true;
    } else if (this._reasonLeaveAlert && wx.disableAlertBeforeUnload) {
      wx.disableAlertBeforeUnload();
      this._reasonLeaveAlert = false;
    }
  },
  onUnload() {
    if (this._reasonLeaveAlert && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    this._reasonLeaveAlert = false;
  },
  async confirmDiscardReason() {
    if (!this.data.reason.trim()) return true;
    if (this.data.processing || this._confirming) return false;
    this._confirming = true;
    try {
      return await C.confirm({
        title: '放弃未提交的处理原因？',
        content: '这段原因尚未提交。放弃后将清除本次输入。',
        confirmText: '放弃输入',
        cancelText: '继续编辑'
      });
    } finally {
      this._confirming = false;
    }
  },
  clearReason() {
    this.setData({ reasonFor: '', reason: '', decision: '', formError: '' });
    this.updateReasonLeaveAlert();
  },
  async changeFilter(e) {
    if (this.data.processing || this._confirming) return;
    const filter = e.currentTarget.dataset.value;
    if (filter === this.data.filter) return;
    if (!await this.confirmDiscardReason()) return;
    this.clearReason();
    this.setData({ filter, items: [], hasMore: false, nextCursor: null });
    await this.load(true);
  },
  async refreshWithReasonGuard() {
    if (this.data.processing || this._confirming) return;
    if (!await this.confirmDiscardReason()) return;
    this.clearReason();
    await this.refreshSession();
  },
  async onPullDownRefresh() {
    try {
      await this.refreshWithReasonGuard();
    } finally {
      wx.stopPullDownRefresh();
    }
  },
  retry() {
    return this.refreshWithReasonGuard();
  },
  input(e) {
    const reason = e.detail.value;
    this.setData({
      reason,
      focusReason:false,
      formError: ''
    });
    this.updateReasonLeaveAlert();
    return reason
  },
  async choose(e) {
    if (this.data.processing || this._confirming) return;
    const { id, decision } = e.currentTarget.dataset;
    if (this.data.reasonFor === id && this.data.decision === decision) return;
    if (!await this.confirmDiscardReason()) return;
    this.clearReason();
    if (decision !== 'approve') {
      this.setData({ reasonFor: id, decision, reason: '', formError: '' });
      return;
    }
    await this.process(id, decision, '');
  },
  async cancelReason() {
    if (this.data.processing || this._confirming) return;
    if (!await this.confirmDiscardReason()) return;
    this.clearReason();
  },
  submitReason() {
    if (this.data.processing || this._confirming) return;
    if ((Array.from(this.data.reason.trim()).length < 2 || Array.from(this.data.reason.trim()).length > 200)) {
      this.setData({
        formError: '请填写 2–200 字处理原因。',
        focusReason:true
      });
      return
    }
    this.process(this.data.reasonFor, this.data.decision, this.data.reason.trim())
  },
  async process(id, decision, reason) {
    const member = this.data.items.find(x => x.id === id);
    if (!member || this.data.processing || this._confirming) return;
    const label = {
      approve: '批准内测',
      reject: '不批准',
      revoke: '撤销资格'
    } [decision];
    this._confirming = true;
    const yes = await C.confirm({
      title: '确认' + label + '？',
      content: decision === 'approve' ? '该账号随后可以读取和发布真实校园墙内容。' : '该账号将无法读取和发布校园墙内容，处理说明会展示给对方，操作将留存记录。',
      confirmText: label,
      confirmColor: decision === 'approve' ? '#0878BD' : '#B83D49'
    });
    this._confirming = false;
    if (!yes) return;
    this.setData({
      processing: id,
      formError: ''
    });
    try {
      await C.callWall('reviewMember', {
        memberId: id,
        revision: member.revision,
        decision,
        reason
      });
      wx.showToast({
        title: '处理已完成',
        icon: 'success'
      });
      this.clearReason();
      await this.load(true)
    } catch (e) {
      if (e.code === 'CONFLICT') {
        await this.load(true);
        this.setData({
          pageError: '该成员已被处理，列表已刷新，请核对最新状态。'
        })
      } else this.setData({
        pageError: e.message,
        formError: e.message
      })
    } finally {
      this.setData({
        processing: ''
      })
    }
  }
});
