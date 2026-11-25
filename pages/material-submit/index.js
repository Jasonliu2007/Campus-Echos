const C = require('../../utils/campus');
const T = require('../../utils/trade');
const DRAFT_PREFIX = 'campusMaterialDraftV24:';
const EDITABLE = ['draft', 'rejected', 'offline'];
const count = value => Array.from(value || '').length;
const catalogText = rows => (rows || []).map(row => `${row.title} | ${row.page}`).join('\n');

function priceCents(value) {
  const text = String(value).trim();
  if (!/^\d{1,5}(?:\.\d{1,2})?$/.test(text)) throw new Error('价格请填写0–10000元，最多两位小数。');
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (result > 1000000) throw new Error('价格最多10000元。');
  return result;
}
function parseCatalog(value, pageCount) {
  const lines = String(value).split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > 80) throw new Error('请填写1–80项目录，每行“章节标题 | 页码”。');
  return lines.map(line => {
    const match = line.match(/^(.+?)\s*[|｜]\s*(\d+)$/);
    if (!match || count(match[1].trim()) > 80 || Number(match[2]) < 1 || Number(match[2]) > pageCount) throw new Error('目录每行需为“章节标题 | 页码”，页码不能超出文件页数。');
    return { title: match[1].trim(), page: Number(match[2]) };
  });
}
function parsePreview(value, pageCount) {
  const parts = String(value).trim().split(/[,，、\s]+/).filter(Boolean);
  if (parts.length < 1 || parts.length > 2 || parts.some(part => !/^\d+$/.test(part))) throw new Error('请填写1–2个试读页码，用逗号分隔。');
  const pages = parts.map(Number);
  if (new Set(pages).size !== pages.length || pages.some(page => page < 1 || page > pageCount)) throw new Error('试读页码不能重复或超出文件页数。');
  return pages;
}

Page({
  toggleMaterialPreview() {
    if (this.data.previewMaterial) {
      this.setData({ previewMaterial: null });
      return;
    }
    if (this.data.access !== 'approved' || this.data.busy) return;
    const { title, course, type, description, pageCount, catalogInput, price } = this.data;
    let displayPrice = '免费';
    try {
      const cents = priceCents(price);
      if (cents > 0) displayPrice = '¥' + (cents / 100).toFixed(2);
    } catch (error) {
      this.setData({ error: error.message });
      return;
    }
    let catalog = [];
    try { if (pageCount && catalogInput.trim()) catalog = parseCatalog(catalogInput, pageCount); } catch (error) {
      this.setData({ error: error.message });
      return;
    }
    this.setData({ previewMaterial: {
      title: title.trim() || '未填写资料标题', course: course.trim() || '未填写课程',
      type, description, pageCount: pageCount || '待确认', displayPrice, catalog
    } });
  },
  data: {
    previewMaterial: null,
    title: '', course: '', description: '', price: '0', type: T.MATERIAL_TYPES[0], types: T.MATERIAL_TYPES,
    learningModes: [], modeOptions: T.LEARNING_MODES.map(value => ({ value, selected: false })),
    catalogInput: '', previewInput: '1', originalConfirmed: false,
    titleCount: 0, descriptionCount: 0, material: null, materialId: '', expectedRevision: null,
    uploadId: '', versionId: '', uploadStatus: '', fileName: '', fileSize: 0, pageCount: 0, sha256: '', percent: 0,
    loading: true, busy: '', error: '', notice: '', fieldErrors: {}, conflict: false, access: 'loading', adultConfirmed: false,
    canEdit: true, canSubmit: false, reducedMotion: false, reducedTransparency: false
  },
  onLoad(query = {}) {
    this._active = true; this._materialId = query.id || ''; this._draftKey = DRAFT_PREFIX + (query.id || 'new');
    try {
      const saved = wx.getStorageSync(this._draftKey);
      if (saved && typeof saved === 'object') {
        this._materialId = this._materialId || saved.materialId || '';
        this._file = saved.file || null;
        this._draftRequest = saved.draftRequest || ''; this._draftFingerprint = saved.draftFingerprint || '';
        this._uploadRequest = saved.uploadRequest || '';
        this._dirty = saved.dirty === true;
        const fields = ['title','course','description','price','type','learningModes','catalogInput','previewInput','originalConfirmed','expectedRevision','uploadId','versionId','uploadStatus','fileName','fileSize','pageCount','sha256','percent'];
        const patch = {}; for (const key of fields) if (saved[key] !== undefined) patch[key] = saved[key];
        patch.materialId = this._materialId; this.setData(patch); this.syncCounts(); this.syncModes();
      }
    } catch (_) { this.setData({ notice: '本机草稿暂时无法读取，云端已保存资料仍可重新加载。' }); }
    this.leaveAlert();
  },
  async onShow() {
    this._active = true;
    this.setData({ reducedMotion: C.getReducedMotion(), reducedTransparency: C.getReducedTransparency() });
    if (this._choosingFile) return;
    const returning = this._initialized === true; this._initialized = true;
    this._epoch = (this._epoch || 0) + 1; this._loading = false; this._checkingUpload = false;
    this.setData({ canEdit: false, canSubmit: false, busy: '' });
    await this.load({ preserveFields: returning });
  },
  onHide() { this.saveLocal(); if (this._choosingFile) return; this._active = false; this._epoch = (this._epoch || 0) + 1; this._loadSeq = (this._loadSeq || 0) + 1; this._loading = false; },
  onUnload() { this._choosingFile = false; this._active = false; this._epoch = (this._epoch || 0) + 1; this._loadSeq = (this._loadSeq || 0) + 1; this.saveLocal(); },
  isCurrent(epoch) { return this._active && (this._epoch || 0) === epoch; },
  clearAccess(message) { this._epoch = (this._epoch || 0) + 1; this._loadSeq = (this._loadSeq || 0) + 1; this._loading = false; this._checkingUpload = false; this.setData({ material: null, access: 'revoked', canEdit: false, canSubmit: false, adultConfirmed: false, busy: '', loading: false, notice: '', error: message }); },
  async verifySession(epoch = this._epoch || 0) {
    const session = await T.call('session'); if (!this.isCurrent(epoch)) return false;
    if (session.access !== 'approved') { this.clearAccess('请先取得内测资格，资料草稿仍保留在本机。'); return false; }
    this.setData({ access: 'approved', adultConfirmed: session.adultConfirmed === true }); return true;
  },
  syncCounts() { this.setData({ titleCount: count(this.data.title), descriptionCount: count(this.data.description) }); },
  syncModes() { this.setData({ modeOptions: T.LEARNING_MODES.map(value => ({ value, selected: this.data.learningModes.includes(value) })) }); },
  statePatch(material) {
    return { material: T.material(material), materialId: material._id, canEdit: EDITABLE.includes(material.status),
      canSubmit: EDITABLE.includes(material.status) && this.data.uploadStatus === 'ready' && !!this.data.versionId && material.pendingVersionId !== this.data.versionId };
  },
  async load({ replace = false, preserveFields = false } = {}) {
    if (this._loading) return;
    this._loading = true; const seq = this._loadSeq = (this._loadSeq || 0) + 1;
    this.setData({ loading: true, error: '' });
    try {
      const session = await T.call('session');
      if (!this._active || seq !== this._loadSeq) return;
      this.setData({ access: session.access, adultConfirmed: session.adultConfirmed === true });
      if (session.access !== 'approved') { this.clearAccess('请先取得内测资格，资料草稿仍保留在本机。'); return; }
      if (this._materialId) {
        const result = await T.call('getMaterial', { materialId: this._materialId });
        if (!this._active || seq !== this._loadSeq) return;
        if (!result.material.isOwner) { this.clearAccess('只能管理本人上传的资料。'); return; }
        const row = result.material;
        const stale = (this._dirty || preserveFields) && this.data.expectedRevision && this.data.expectedRevision !== row.revision;
        const patch = this.statePatch(row);
        if (replace || (!this._dirty && !preserveFields)) Object.assign(patch, { title: row.title, course: row.course, description: row.description, type: row.type, learningModes: row.learningModes || [], price: (row.priceCents / 100).toFixed(2), catalogInput: catalogText(row.catalog), expectedRevision: row.revision, conflict: false });
        else if (stale) Object.assign(patch, { conflict: true, notice: '云端资料版本已变化，本机输入仍保留。请核对后重新载入最新资料。' });
        this.setData(patch); this.syncCounts(); this.syncModes();
        if (replace) this._dirty = false;
      }
      if (!this._materialId) this.setData({ canEdit: true, canSubmit: false });
      if (this.data.uploadId) await this.refreshUpload({ quiet: true });
      this.saveLocal();
    } catch (error) { if (this._active && seq === this._loadSeq) this.handleError(error); }
    finally { if (this._active && seq === this._loadSeq) { this._loading = false; this.setData({ loading: false }); } }
  },
  input(event) {
    const key = event.currentTarget.dataset.key;
    if (!['title','course','description','price','catalogInput','previewInput'].includes(key) || this.data.busy) return;
    this._dirty = true; this.setData({ [key]: event.detail.value, fieldErrors: { ...this.data.fieldErrors, [key]: '' }, error: '' });
    this.syncCounts(); this.saveLocal(); this.leaveAlert();
  },
  type(event) { if (this.data.busy) return; const type = this.data.types[Number(event.detail.value)]; if (!type) return; this._dirty = true; this.setData({ type }); this.saveLocal(); },
  mode(event) {
    if (this.data.busy) return; const value = event.currentTarget.dataset.value;
    if (!T.LEARNING_MODES.includes(value)) return;
    const modes = new Set(this.data.learningModes); if (modes.has(value)) modes.delete(value); else modes.add(value);
    this._dirty = true; this.setData({ learningModes: [...modes] }); this.syncModes(); this.saveLocal(); this.leaveAlert();
  },
  original(event) { if (this.data.busy || !this.data.canEdit) return; this._dirty = true; this.setData({ originalConfirmed: (event.detail.value || []).includes('confirmed') }); this.saveLocal(); this.leaveAlert(); },
  saveLocal() {
    if (!this._draftKey) return true;
    const value = { materialId: this._materialId || '', file: this._file || null, draftRequest: this._draftRequest || '', draftFingerprint: this._draftFingerprint || '', uploadRequest: this._uploadRequest || '', dirty: !!this._dirty };
    for (const key of ['title','course','description','price','type','learningModes','catalogInput','previewInput','originalConfirmed','expectedRevision','uploadId','versionId','uploadStatus','fileName','fileSize','pageCount','sha256','percent']) value[key] = this.data[key];
    try {
      wx.setStorageSync(this._draftKey, value);
      // The new-draft entry and My materials must resume the same local upload.
      if (this._materialId && this._draftKey !== DRAFT_PREFIX + this._materialId) wx.setStorageSync(DRAFT_PREFIX + this._materialId, value);
      this._localSaved = true; return true;
    }
    catch (_) { this._localSaved = false; this.setData({ error: '本机草稿未保存成功，请勿关闭页面；输入仍在当前页。' }); return false; }
  },
  leaveAlert() {
    const dirty = this._dirty || !!this.data.uploadId || this.data.title.trim() || this.data.description.trim();
    if (dirty && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: this._localSaved === false ? '本机草稿未保存成功，离开会丢失当前输入。' : '资料尚未完成提交，确认保留本机草稿并离开？' });
    else if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
  },
  handleError(error) {
    const patch = { error: error.message || '操作暂不可用，输入仍保留。' };
    if (['CONFLICT','REQUEST_CONFLICT'].includes(error.code)) patch.conflict = true;
    if (T.invalidAccess(error)) { this.clearAccess(error.message); return; }
    this.setData(patch);
  },
  async ensureAdult() {
    const epoch = this._epoch || 0;
    if (this.data.access !== 'approved') throw new Error('请先核对内测资格。');
    if (this.data.adultConfirmed) return true;
    const yes = await C.confirm({ title: '资料交易资格确认', content: '请确认你已满18岁并理解交易说明。内测资格不是学生实名认证；不采集身份证。付费暂未启用，站外付款可能显示双方身份，平台不代收、不退款或裁决钱款。', confirmText: '已满18岁并同意' });
    if (!yes || !this.isCurrent(epoch)) return false;
    await T.call('confirmAdult', { adultConfirmed: true, termsAccepted: true });
    if (!this.isCurrent(epoch)) return false; this.setData({ adultConfirmed: true }); return true;
  },
  metadata() {
    const fields = {}, title = this.data.title.trim(), course = this.data.course.trim(), description = this.data.description.trim();
    if (!title || count(title) > 60) fields.title = '标题请填写1–60字。';
    if (!course || count(course) > 60) fields.course = '课程请填写1–60字。';
    if (count(description) < 2 || count(description) > 2000) fields.description = '描述请填写2–2000字。';
    if (!this.data.learningModes.length) fields.learningModes = '至少选择一个适合的学习模式。';
    let cents; try { cents = priceCents(this.data.price); } catch (error) { fields.price = error.message; }
    if (Object.keys(fields).length) { this.setData({ fieldErrors: fields }); throw new Error('请检查标出的资料信息，输入已保留。'); }
    return { title, course, description, type: this.data.type, learningModes: this.data.learningModes, priceCents: cents };
  },
  async saveDraftNow() {
    const epoch = this._epoch || 0;
    if (this.data.conflict) throw new Error('云端版本有冲突，请先核对并载入最新资料。');
    if (this.data.material && !EDITABLE.includes(this.data.material.status)) throw new Error('请等待当前审核结束，或先下架已发布资料再修改。');
    const fields = this.metadata();
    if (!await this.ensureAdult() || !this.isCurrent(epoch)) return false;
    const fingerprint = JSON.stringify(fields);
    if (!this._draftRequest || fingerprint !== this._draftFingerprint) { this._draftRequest = C.requestId(); this._draftFingerprint = fingerprint; }
    this.saveLocal();
    const response = await T.call('saveMaterialDraft', { ...fields, requestId: this._draftRequest, ...(this._materialId ? { materialId: this._materialId, revision: this.data.expectedRevision } : {}) });
    if (!this.isCurrent(epoch)) return false;
    this._materialId = response.material._id; this._dirty = false;
    this.setData({ ...this.statePatch(response.material), expectedRevision: response.material.revision, notice: '资料信息已保存，尚未公开。' });
    this.saveLocal(); return true;
  },
  async saveDraft() {
    const epoch = this._epoch || 0;
    if (this.data.busy || !this.data.canEdit) return;
    this.setData({ busy: 'save', error: '' });
    try { await this.saveDraftNow(); } catch (error) { if (this.isCurrent(epoch)) this.handleError(error); }
    finally { if (this.isCurrent(epoch)) this.setData({ busy: '' }); }
  },
  async choose() {
    const epoch = this._epoch || 0;
    if (this.data.busy || !this.data.canEdit) return;
    this.setData({ busy: 'choose', error: '' });
    try {
      if (this._dirty || !this._materialId) { if (!await this.saveDraftNow()) return; }
      else if (!await this.ensureAdult()) return;
      if (!this.isCurrent(epoch)) return;
      this._choosingFile = true;
      let file; try { file = await T.choosePdf(); } finally { this._choosingFile = false; }
      if (!file || !this.isCurrent(epoch)) return;
      this._file = file; this.saveLocal();
      if (!await this.verifySession(epoch)) return;
      // Persisting the temp file is best-effort. A missing local file always asks
      // for a new upload session rather than mixing bytes into an old session.
      if (wx.getFileSystemManager) {
        const fs = wx.getFileSystemManager();
        if (typeof fs.saveFile === 'function') {
          try { const saved = await new Promise((resolve, reject) => fs.saveFile({ tempFilePath: file.path, success: resolve, fail: reject })); this._file = { ...file, path: saved.savedFilePath }; }
          catch (_) { this.setData({ notice: '文件仅暂存在本次会话，离开后可能需要重新选择；表单仍会保存。' }); }
        }
      }
      if (!this.isCurrent(epoch)) return;
      this._uploadRequest = C.requestId();
      this.setData({ fileName: file.name, fileSize: file.size, uploadId: '', versionId: '', uploadStatus: '', pageCount: 0, sha256: '', percent: 0, canSubmit: false });
      this.saveLocal(); await this.uploadNow();
    } catch (error) { if (this.isCurrent(epoch)) this.handleError(error); }
    finally { if (this.isCurrent(epoch)) this.setData({ busy: '' }); }
  },
  async uploadNow() {
    const epoch = this._epoch || 0;
    if (!this._file) throw new Error('本机PDF已不可用，请重新选择；新的上传不会混入旧文件分块。');
    this.setData({ busy: 'upload', error: '' });
    const result = await T.uploadPdf({ materialId: this._materialId, file: this._file, requestId: this._uploadRequest, uploadId: this.data.uploadId || undefined,
      onProgress: progress => { if (!this.isCurrent(epoch)) return; this.setData({ uploadId: progress.uploadId, percent: progress.percent, uploadStatus: 'uploading' }); this.saveLocal(); }
    });
    if (!this.isCurrent(epoch)) return;
    this.setData({ uploadId: result.uploadId, versionId: result.versionId || '', uploadStatus: result.status, percent: 100, notice: '上传已提交服务端处理；这还不是文件审核成功。请稍后刷新处理状态。' });
    this.saveLocal(); await this.refreshUpload({ quiet: true });
  },
  async retryUpload() {
    const epoch = this._epoch || 0;
    if (this.data.busy || !this.data.canEdit) return;
    this.setData({ busy: 'upload', error: '' });
    try {
      if (!this._file) throw new Error('本机PDF已不可用，请重新选择，表单内容会保留。');
      if (wx.getFileSystemManager) { const fs = wx.getFileSystemManager(); if (typeof fs.access === 'function') await new Promise((resolve, reject) => fs.access({ path: this._file.path, success: resolve, fail: () => reject(new Error('本机PDF已不可用，请重新选择，表单内容会保留。')) })); }
      if (!this.isCurrent(epoch)) return;
      await this.uploadNow();
    } catch (error) { if (this.isCurrent(epoch)) this.handleError(error); }
    finally { if (this.isCurrent(epoch)) this.setData({ busy: '' }); }
  },
  async refreshUpload({ quiet = false } = {}) {
    const epoch = this._epoch || 0;
    if (!this.data.uploadId || this._checkingUpload) return;
    if (!quiet && this.data.busy) return;
    this._checkingUpload = true; if (!quiet) this.setData({ busy: 'status', error: '' });
    try {
      const response = await T.call('getUpload', { uploadId: this.data.uploadId });
      if (!this.isCurrent(epoch)) return;
      const submitted = this.data.material && this.data.material.pendingVersionId === (response.versionId || this.data.versionId);
      const patch = { uploadStatus: response.status, versionId: response.versionId || this.data.versionId, pageCount: response.pageCount || 0, sha256: response.sha256 || '', canSubmit: response.status === 'ready' && this.data.canEdit && !submitted };
      if (response.status === 'ready' && !this.data.catalogInput.trim()) patch.catalogInput = catalogText(response.suggestedCatalog);
      if (['failed','expired'].includes(response.status)) patch.error = `文件处理未完成（${response.errorCode || response.status}），请重新选择PDF；资料信息仍保留。`;
      else if (response.status === 'ready') patch.notice = submitted ? '当前封存版本已经提交过审核。若需修改重提，请选择PDF生成新文件版本；旧订单版本保持。' : 'PDF封存完成。请逐项核对目录、选择1–2页试读，再提交人工审核。';
      this.setData(patch); this.saveLocal();
    } catch (error) { if (this.isCurrent(epoch)) this.handleError(error); }
    finally { if (this.isCurrent(epoch)) { this._checkingUpload = false; if (!quiet) this.setData({ busy: '' }); } }
  },
  checkUpload() { return this.refreshUpload(); },
  async submit() {
    const epoch = this._epoch || 0;
    if (this.data.busy || !this.data.canSubmit || this.data.conflict) return;
    this.setData({ busy: 'submit', error: '' });
    try {
      if (!this.data.originalConfirmed) throw new Error('请先确认拥有原创或合法发布权利。');
      const catalog = parseCatalog(this.data.catalogInput, this.data.pageCount), previewPages = parsePreview(this.data.previewInput, this.data.pageCount);
      if (this._dirty) { if (!await this.saveDraftNow()) return; }
      else if (!await this.ensureAdult()) return;
      if (!this.isCurrent(epoch)) return;
      const response = await T.call('submitMaterial', { materialId: this._materialId, versionId: this.data.versionId, revision: this.data.expectedRevision, catalog, previewPages, originalConfirmed: true });
      if (!this.isCurrent(epoch)) return;
      this._dirty = false;
      if (this._draftKey === DRAFT_PREFIX + 'new') {
        try { wx.removeStorageSync(this._draftKey); } catch (_) {}
        this._draftKey = DRAFT_PREFIX + this._materialId;
      }
      this.setData({ material: { ...this.data.material, pendingVersionId: this.data.versionId, status: response.status, statusLabel: T.MATERIAL_LABELS[response.status] || '处理中', revision: response.revision }, expectedRevision: response.revision, canEdit: false, canSubmit: false, notice: '已提交独立试读生成，随后进入人工全量核查。资料仍未公开。' });
      this.saveLocal(); if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    } catch (error) { if (this.isCurrent(epoch)) this.handleError(error); }
    finally { if (this.isCurrent(epoch)) this.setData({ busy: '' }); }
  },
  async reloadLatest() {
    if (this.data.busy || this._confirming) return;
    this._confirming = true;
    const yes = await C.confirm({ title: '载入云端最新资料？', content: '会用云端资料信息替换本页标题、描述、价格和目录。本机未提交输入将被覆盖，请先自行保存需要的文字。上传文件版本不会自动替换。', confirmText: '载入最新版本' });
    this._confirming = false; if (yes && this._active) await this.load({ replace: true });
  },
  async availability() {
    const epoch = this._epoch || 0;
    if (this.data.busy || this.data.loading || this.data.access !== 'approved' || this._confirming || !this.data.material) return;
    const status = this.data.material.status === 'published' ? 'offline' : 'published';
    this._confirming = true;
    const yes = await C.confirm({ title: status === 'offline' ? '下架这份资料？' : '恢复上架这份资料？', content: status === 'offline' ? '关闭新订单，既有订单和购买版本仍保留。替换文件需产生新版本并重新审核。' : '服务端会重新核对当前已审核版本；待审或核查中的资料不能直接上架。', confirmText: status === 'offline' ? '确认下架' : '恢复上架' });
    this._confirming = false; if (!yes || !this.isCurrent(epoch)) return;
    this.setData({ busy: 'availability', error: '' });
    try {
      const result = await T.call('setMaterialAvailability', { materialId: this._materialId, revision: this.data.expectedRevision, status });
      if (!this.isCurrent(epoch)) return;
      const material = { ...this.data.material, status: result.status, revision: result.revision };
      this.setData({ ...this.statePatch(material), expectedRevision: result.revision, notice: result.status === 'offline' ? '已下架。替换资料需重新审核，旧订单版本保持。' : '已恢复上架。' }); this.saveLocal();
    } catch (error) { if (this.isCurrent(epoch)) this.handleError(error); }
    finally { if (this.isCurrent(epoch)) this.setData({ busy: '' }); }
  },
  async changePrice() {
    const epoch = this._epoch || 0;
    if (this.data.busy || this.data.loading || this.data.access !== 'approved' || !this.data.material || this.data.conflict) return;
    let cents; try { cents = priceCents(this.data.price); } catch (error) { this.setData({ fieldErrors: { price: error.message } }); return; }
    this.setData({ busy: 'price', error: '' });
    try { if (!await this.ensureAdult() || !this.isCurrent(epoch)) return; const result = await T.call('setMaterialPrice', { materialId: this._materialId, revision: this.data.expectedRevision, priceCents: cents }); if (!this.isCurrent(epoch)) return; this.setData({ material: T.material({ ...this.data.material, priceCents: result.priceCents, revision: result.revision }), expectedRevision: result.revision, notice: '价格已更新，只影响新订单。付费入口仍未开放。' }); this.saveLocal(); }
    catch (error) { if (this.isCurrent(epoch)) this.handleError(error); }
    finally { if (this.isCurrent(epoch)) this.setData({ busy: '' }); }
  },
  async cancel() {
    if (this.data.busy || this._confirming) return;
    this._confirming = true;
    const yes = await C.confirm({ title: '保留资料草稿并离开？', content: '本机表单和上传会话会保留。未提交的封存文件7天后清理，上传分块24小时后到期，请及时完成。', confirmText: '保留并离开', cancelText: '继续填写' });
    this._confirming = false; if (!yes || !this.saveLocal()) return;
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload(); C.goBack();
  },
  retry() { return this.load(); }
});
