const C = require('../../utils/campus');
const {
  makeList
} = require('../../utils/wall-list');
const memberList = makeList({
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
      roleConflict: false,
      checkingRoles: false,
      roleCheckError: '',
      reasonFor: '',
      reason: '',
      decision: '',
      formError: '', sanctionFor: '', sanctionDecision: 'mute', sanctionReason: ''
    }
});
Page({
  ...memberList,
  sanctionInput(e) { if (this.data.processing || this._confirming) return this.data.sanctionReason; this.setData({ sanctionReason: e.detail.value, formError: '' }); this.updateReasonLeaveAlert(); return e.detail.value; },
  async chooseSanction(e) {
    if (this.data.processing || this._confirming || this._roleBusy || this.data.roleConflict) return;
    const { id, decision } = e.currentTarget.dataset, target = this.data.items.find(x => x.id === id);
    if (!target || target.status !== 'approved' || target.role === 'admin' || !['mute','ban','clear'].includes(decision)) return;
    if (this.data.sanctionFor === id && this.data.sanctionDecision === decision) return;
    const epoch = this._roleEpoch || 0;
    if (!await this.confirmDiscardReason() || !this.roleActive(epoch)) return;
    this.clearReason(); this.setData({ sanctionFor: id, sanctionDecision: decision, sanctionReason: '', formError: '' });
  },
  async submitSanction() {
    if (this.data.processing || this._confirming) return;
    const target = this.data.items.find(x => x.id === this.data.sanctionFor), reason = this.data.sanctionReason.trim(); if (!target) return;
    if (Array.from(reason).length < 2 || Array.from(reason).length > 200) { this.setData({ formError: '处罚原因请填写2–200字。' }); return; }
    const epoch = this._roleEpoch || 0;
    const decision = this.data.sanctionDecision, labels = { mute: '禁言7天', ban: '封禁新活动', clear: '解除处罚' };
    this._confirming = true; const yes = await C.confirm({ title: '确认' + labels[decision] + '？', content: '对象：' + target.nickname + '。原因：' + reason + '。已有购买权益、订单与售后保留必要访问，不代替钱款处理。', confirmText: '确认' + labels[decision] }); this._confirming = false; if (!yes || !this.roleActive(epoch)) return;
    this.setData({ processing: target.id, formError: '' });
    try { await C.callWall('setMemberSanction', { memberId: target.id, revision: target.revision, decision, reason, confirmed: true }); if (!this.roleActive(epoch)) return; this.setData({ sanctionFor: '', sanctionReason: '' }); if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload(); await this.load(true); }
    catch (error) { if (!this.roleActive(epoch)) return; this.setData({ formError: error.code === 'CONFLICT' ? '成员状态已变化，原因已保留，请刷新核对后再次确认。' : error.message }); }
    finally { if (this.roleActive(epoch)) this.setData({ processing: '' }); }
  },
  roleReadLocked() {
    return this._roleBusy || this._confirming || this.data.checkingRoles || this.data.roleConflict;
  },
  invalidateMemberReads() {
    this._sessionSeq = (this._sessionSeq || 0) + 1;
    this._listSeq = (this._listSeq || 0) + 1;
    this.setData({ loading: false, loadingMore: false });
  },
  async load(reset = false) {
    if (this.roleReadLocked()) return;
    return memberList.load.call(this, reset);
  },
  async refreshSession() {
    if (this.roleReadLocked()) return;
    return memberList.refreshSession.call(this);
  },
  roleActive(epoch) {
    return !this._roleDisposed && epoch === (this._roleEpoch || 0);
  },
  async role(e) {
    if (this._roleBusy || this.data.processing || this._confirming || this.data.roleConflict || this.data.checkingRoles || !this.data.canManageAdmins) return;
    const id = e.currentTarget.dataset.id;
    const target = this.data.items.find(item => item.id === id);
    if (!target || target.status !== 'approved' || !this.data.member || id === this.data.member.id) return;
    const epoch = this._roleEpoch || 0;
    // Lock before the first await, including the no-draft confirmation path.
    this._roleBusy = true;
    this.invalidateMemberReads();
    try {
      if (!await this.confirmDiscardReason() || !this.roleActive(epoch)) return;
      if (this.data.processing || this._confirming || !this.data.canManageAdmins) return;
      this.clearReason();
      const role = target.role === 'admin' ? 'member' : 'admin';
      this._confirming = true;
      let yes;
      try {
        yes = await C.confirm({ title: role === 'admin' ? '授予管理员权限？' : '取消管理员权限？',
          content: role === 'admin' ? '确认将为“' + target.nickname + '”开放内容审核、举报处理和内测审批。对方使用同一微信账号即可管理，操作会留存记录。' : '确认后“' + target.nickname + '”的管理操作会被拒绝，普通内测资格保留。操作会留存记录。',
          confirmText: role === 'admin' ? '确认授权' : '取消管理员', confirmColor: role === 'admin' ? '#0878BD' : '#A93546' });
      } finally { this._confirming = false; }
      if (!yes || !this.roleActive(epoch) || !this.data.canManageAdmins) return;
      // If the response is lost or the page leaves, the next action must verify it.
      this.setData({ processing: id, roleConflict: true, roleCheckError: '', pageError: '', formError: '' });
      try {
        const result = await C.callWall('setMemberRole', { memberId: id, revision: target.revision, role });
        if (!this.roleActive(epoch)) return;
        this.setData({ items: this.data.items.map(item => item.id === id ? { ...item, ...result.member } : item), roleConflict: false });
        wx.showToast({ title: role === 'admin' ? '管理员已授权' : '管理员已取消', icon: 'success' });
      } catch (error) {
        if (!this.roleActive(epoch)) return;
        await this.verifyRoleState(epoch);
      }
    } finally {
      this._roleBusy = false;
      this._confirming = false;
      if (!this._roleDisposed) this.setData({ processing: '' });
    }
  },
  async verifyRoleState(epoch) {
    if (!this.roleActive(epoch)) return false;
    // Invalidate earlier generic session/list reads before checking this outcome.
    this.invalidateMemberReads();
    this.setData({ roleConflict: true, checkingRoles: true, roleCheckError: '' });
    try {
      const session = await C.callWall('session');
      if (!this.roleActive(epoch)) return false;
      this.setData({ member: session.member, access: session.access, canManageAdmins: session.canManageAdmins === true });
      if (session.access !== 'approved' || !session.member || session.member.role !== 'admin' || session.canManageAdmins !== true) {
        this.clearProtectedList(session.access, '当前账号无法核对管理员授权，请确认最新资格。');
        this.setData({ roleConflict: true, roleCheckError: '当前账号没有管理员授权权限，不能继续本次操作。' });
        return false;
      }
      const result = await C.callWall('listMembers', { status: this.data.filter });
      if (!this.roleActive(epoch)) return false;
      if (!Array.isArray(result.members)) throw new Error('成员列表未能完整读取');
      this.setData({ items: result.members.map(item => ({ ...item, displayTime: C.formatTime(item.createdAt), statusLabel: C.accessLabels[item.status] })),
        hasMore: result.hasMore, nextCursor: result.nextCursor, loading: false, loadingMore: false,
        error: '', roleConflict: false, roleCheckError: '',
        pageError: '已重新核对成员角色，请检查最新状态后再操作。' });
      return true;
    } catch (error) {
      if (!this.roleActive(epoch)) return false;
      const message = '本次授权结果仍无法确认，请联网后重新核对。核对完成前不能再次授权或取消管理员。';
      this.setData({ roleConflict: true, roleCheckError: message, pageError: message });
      return false;
    } finally {
      if (!this._roleDisposed) this.setData({ checkingRoles: false });
    }
  },
  async verifyRoles() {
    if (this._roleBusy || this.data.processing || this._confirming || this.data.checkingRoles) return;
    this._roleBusy = true;
    try { await this.verifyRoleState(this._roleEpoch || 0); }
    finally { this._roleBusy = false; }
  },
  onHide() { this._roleEpoch = (this._roleEpoch || 0) + 1; this.setData({ processing: '' }); },
  listParams() {
    return {
      status: this.data.filter
    }
  },
  updateReasonLeaveAlert() {
    const dirty = !!this.data.reason.trim() || !!this.data.sanctionReason.trim();
    if (dirty && wx.enableAlertBeforeUnload) {
      wx.enableAlertBeforeUnload({ message: '处理原因尚未提交，离开会丢失输入。' });
      this._reasonLeaveAlert = true;
    } else if (this._reasonLeaveAlert && wx.disableAlertBeforeUnload) {
      wx.disableAlertBeforeUnload();
      this._reasonLeaveAlert = false;
    }
  },
  onUnload() {
    this._roleEpoch = (this._roleEpoch || 0) + 1;
    this._roleDisposed = true;
    if (this._reasonLeaveAlert && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    this._reasonLeaveAlert = false;
  },
  async confirmDiscardReason() {
    if (!this.data.reason.trim() && !this.data.sanctionReason.trim()) return true;
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
    this.setData({ reasonFor: '', reason: '', decision: '', sanctionFor: '', sanctionReason: '', formError: '' });
    this.updateReasonLeaveAlert();
  },
  async changeFilter(e) {
    if (this._roleBusy || this.data.processing || this._confirming || this.data.checkingRoles || this.data.roleConflict) return;
    const filter = e.currentTarget.dataset.value;
    if (filter === this.data.filter) return;
    if (!await this.confirmDiscardReason()) return;
    this.clearReason();
    this.setData({ filter, items: [], hasMore: false, nextCursor: null });
    await this.load(true);
  },
  async refreshWithReasonGuard() {
    if (this.data.roleConflict) return this.verifyRoles();
    if (this._roleBusy || this.data.processing || this._confirming || this.data.checkingRoles || this.data.roleConflict) return;
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
    if (this._roleBusy || this.data.processing || this._confirming || this.data.checkingRoles || this.data.roleConflict) return;
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
    if (this._roleBusy || this.data.processing || this._confirming || this.data.checkingRoles || this.data.roleConflict) return;
    if (!await this.confirmDiscardReason()) return;
    this.clearReason();
  },
  submitReason() {
    if (this._roleBusy || this.data.processing || this._confirming || this.data.checkingRoles || this.data.roleConflict) return;
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
      content: decision === 'approve' ? '该账号随后可以读取和发布论坛内容。' : '该账号将无法读取和发布论坛内容，处理说明会展示给对方，操作将留存记录。',
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
