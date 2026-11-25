const C = require('../../utils/campus');
const T = require('../../utils/trade');
const count = value => Array.from(value || '').length;
Page({
  data: { material: null, loading: true, allowed: false, error: '', notice: '', busy: '', reason: '', reasonCount: 0,
    copyrightChecked: false, descriptionChecked: false, fullDocumentChecked: false, documentOpened: false, result: null,
    conflict: false, reducedMotion: false, reducedTransparency: false },
  onLoad(query = {}) {
    this.materialId = query.id || ''; this._active = true;
    try { const saved = wx.getStorageSync('campusMaterialReview:' + this.materialId); if (saved && typeof saved.reason === 'string') this.setData({ reason: saved.reason, reasonCount: count(saved.reason) }); } catch (_) {}
  },
  onShow() { this._active = true; this.setData({ reducedMotion: C.getReducedMotion(), reducedTransparency: C.getReducedTransparency() }); if (this._openingDocument) return this.verifyRole(); this._epoch = (this._epoch || 0) + 1; this._loading = false; this._confirming = false; this.setData({ allowed: false, busy: '' }); return this.load(); },
  onHide() { if (this._openingDocument) return; this._active = false; this._epoch = (this._epoch || 0) + 1; this._seq = (this._seq || 0) + 1; this._loading = false; this.setData({ allowed: false }); },
  onUnload() { this._active = false; this._openingDocument = false; this._epoch = (this._epoch || 0) + 1; this._seq = (this._seq || 0) + 1; },
  isCurrent(epoch) { return this._active && (this._epoch || 0) === epoch; },
  clearAccess(message) { this._epoch = (this._epoch || 0) + 1; this._seq = (this._seq || 0) + 1; this._loading = false; this.setData({ material: null, allowed: false, result: null, documentOpened: false, copyrightChecked: false, descriptionChecked: false, fullDocumentChecked: false, loading: false, busy: '', notice: '', error: message }); },
  async verifyRole() {
    const epoch = this._epoch || 0; this.setData({ allowed: false });
    try { const session = await C.callWall('session'); if (!this.isCurrent(epoch)) return; if (session.access !== 'approved' || !session.member || session.member.role !== 'admin') this.clearAccess('当前页面仅供获授权管理员全量核查。'); else this.setData({ allowed: true }); }
    catch (error) { if (!this.isCurrent(epoch)) return; if (T.invalidAccess(error)) this.clearAccess(error.message); else this.setData({ allowed: false, error: '暂时无法核对管理员资格，请重新加载后操作。' }); }
  },
  async load({ conflict = false } = {}) {
    if (this._loading) return;
    this._loading = true; const seq = this._seq = (this._seq || 0) + 1;
    this.setData({ loading: !this.data.material, error: '', allowed: false });
    try {
      const session = await C.callWall('session');
      if (!this._active || seq !== this._seq) return;
      if (session.access !== 'approved' || !session.member || session.member.role !== 'admin') { this.clearAccess('当前页面仅供获授权管理员全量核查。'); return; }
      const response = await T.call('getMaterial', { materialId: this.materialId });
      if (!this._active || seq !== this._seq) return;
      const changed = this.data.material && this.data.material.revision !== response.material.revision;
      this.setData({ material: T.material(response.material), allowed: true, conflict: conflict || !!changed,
        ...(changed || conflict ? { copyrightChecked: false, descriptionChecked: false, fullDocumentChecked: false, documentOpened: false,
          notice: '已刷新最新资料。处理说明保留，请重新核查当前版本并确认；没有覆盖新结果。' } : {}) });
    } catch (error) {
      if (!this._active || seq !== this._seq) return;
      if (T.invalidAccess(error)) this.clearAccess(error.message); else this.setData({ error: error.message });
    } finally { if (this._active && seq === this._seq) { this._loading = false; this.setData({ loading: false }); } }
  },
  input(event) {
    if (this.data.busy) return;
    this.setData({ reason: event.detail.value, reasonCount: count(event.detail.value), error: '' });
    try { wx.setStorageSync('campusMaterialReview:' + this.materialId, { reason: event.detail.value }); }
    catch (_) { this.setData({ error: '审核说明未保存到本机，请勿关闭页面。' }); }
    if (event.detail.value && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '核查说明尚未提交，确认离开？' });
  },
  check(event) {
    if (this.data.busy) return;
    const values = event.detail.value || [];
    this.setData({ copyrightChecked: values.includes('copyright'), descriptionChecked: values.includes('description'), fullDocumentChecked: values.includes('document'), error: '', conflict: false });
  },
  async document() {
    const epoch = this._epoch || 0;
    if (this.data.busy || !this.data.allowed || !this.data.material) return;
    const versionId = this.data.material.pendingVersionId || this.data.material.currentVersionId;
    if (!versionId) { this.setData({ error: '资料文件尚未封存，不能核查完整PDF。' }); return; }
    this.setData({ busy: 'document', error: '' });
    try {
      const response = await T.call('getPrivatePdf', { versionId });
      if (!this.isCurrent(epoch)) return;
      this._openingDocument = true;
      try { await T.openDocument(response.url); } finally { this._openingDocument = false; }
      if (this.isCurrent(epoch)) this.setData({ documentOpened: true, notice: '已由微信打开完整PDF。请逐页核对；打开成功不等于已完成核查。' });
    } catch (error) { if (this.isCurrent(epoch)) { if (T.invalidAccess(error)) this.clearAccess(error.message); else this.setData({ error: error.message }); } }
    finally { if (this.isCurrent(epoch)) this.setData({ busy: '' }); }
  },
  async review(event) {
    const epoch = this._epoch || 0;
    const decision = event.currentTarget.dataset.decision;
    if (!['approve','reject'].includes(decision) || this.data.busy || this._confirming || !this.data.allowed || !this.data.material || this.data.material.status !== 'pending') return;
    const reason = this.data.reason.trim();
    if (count(reason) < 2 || count(reason) > 200) { this.setData({ error: '处理说明请填写2–200字，输入已保留。' }); return; }
    if (decision === 'approve' && (!this.data.documentOpened || !this.data.copyrightChecked || !this.data.descriptionChecked || !this.data.fullDocumentChecked)) { this.setData({ error: '请实际打开完整PDF并完成三项核查，才能批准上架。' }); return; }
    this._confirming = true;
    const revision = this.data.material.revision;
    const yes = await C.confirm({ title: decision === 'approve' ? '确认核查后上架？' : '确认驳回这份资料？', content: `当前资料版本${revision}。${decision === 'approve' ? '请确认已逐页检查完整PDF、版权来源和描述一致性。服务端会重新执行微信审核，违规结论不能人工绕过。' : '资料将保持不公开，发布者可根据说明修改后重新提交。'}`, confirmText: decision === 'approve' ? '核查后上架' : '确认驳回' });
    this._confirming = false;
    if (!yes || !this.isCurrent(epoch)) return;
    this.setData({ busy: 'review', error: '' });
    try {
      const response = await T.call('reviewMaterial', { materialId: this.materialId, revision, decision, reason,
        copyrightChecked: this.data.copyrightChecked, descriptionChecked: this.data.descriptionChecked, fullDocumentChecked: this.data.fullDocumentChecked });
      if (!this.isCurrent(epoch)) return;
      this.setData({ result: response, material: T.material({ ...this.data.material, status: response.status, revision: response.revision }), conflict: false,
        notice: response.status === 'published' ? '服务端已确认资料上架。' : '资料已驳回，未公开。' });
      try { wx.removeStorageSync('campusMaterialReview:' + this.materialId); } catch (_) {}
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    } catch (error) {
      if (!this.isCurrent(epoch)) return;
      if (['CONFLICT','CONTENT_REJECTED'].includes(error.code)) {
        const message = error.message;
        await this.load({ conflict: true });
        if (this.isCurrent(epoch)) this.setData({ error: message + ' 说明已保留，请核对最新结果。' });
      } else if (T.invalidAccess(error)) this.clearAccess(error.message);
      else this.setData({ error: error.message });
    } finally { if (this.isCurrent(epoch)) this.setData({ busy: '' }); }
  },
  retry() { this.load(); },
  back() { C.goBack(); }
});
