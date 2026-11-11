const C = require('../../utils/campus');
const DRAFT = 'campusEchoDraftV1';
Page({
  data: {
    categories: C.categories,
    category: '学习互助',
    title: '',
    content: '',
    titleCount: 0,
    contentCount: 0,
    submitting: false,
    error: '',
    result: null,
    loading: true,
    allowed: false,
    reducedMotion: false,
    reducedTransparency: false
  },
  onLoad() {
    try {
      const draft = wx.getStorageSync(DRAFT);
      if (draft && typeof draft === 'object') this.setData({
        category: C.categories.includes(draft.category) ? draft.category : '学习互助',
        title: draft.title || '',
        content: draft.content || '',
        titleCount: Array.from(draft.title || '').length,
        contentCount: Array.from(draft.content || '').length
      });
      this._draftSaved = !!(draft && typeof draft === 'object');
      this._request = draft && draft.requestId ? draft.requestId : '';
      this._fingerprint = draft && draft.fingerprint || ''
    } catch (e) {}
    this.updateLeaveAlert()
  },
  async onShow() {
    this.setData({
      reducedMotion: C.getReducedMotion(),
      reducedTransparency: C.getReducedTransparency(),
      loading: true,
      allowed: false,
      error: ''
    });
    try {
      const r = await C.callWall('session');
      this.setData({
        allowed: r.access === 'approved',
        access: r.access
      })
    } catch (e) {
      this.setData({
        error: e.message
      })
    } finally {
      this.setData({
        loading: false
      })
    }
  },
  input(e) {
    const key = e.currentTarget.dataset.key,
      max = key === 'title' ? 60 : 2000;
    const value = e.detail.value;
    this.setData({
      [key]: value,
      [key + 'Count']: Array.from(value).length,
      error: '',
      [key + 'Error']: '',
      focusTitle: false,
      focusContent: false
    });
    this.save();
    this.updateLeaveAlert();
    return value
  },
  category(e) {
    this.setData({
      category: this.data.categories[Number(e.detail.value)]
    });
    this.save()
  },
  save() {
    try {
      wx.setStorageSync(DRAFT, {title:this.data.title,content:this.data.content,category:this.data.category,requestId:this._request||'',fingerprint:this._fingerprint||''});
      this._draftSaved = true;
      this.updateLeaveAlert();
      return true;
    } catch (error) {
      this._draftSaved = false;
      this.setData({error:'本机草稿未能保存，请勿关闭页面。你仍可提交，失败时输入会保留。'});
      this.updateLeaveAlert();
      return false;
    }
  },
  updateLeaveAlert() {
    const dirty = this.data.title.trim() || this.data.content.trim();
    if (dirty && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({message:this._draftSaved?'输入已保存在本机草稿，确认离开？':'草稿尚未保存成功，离开会丢失本次输入。'});
    else if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
  },
  async cancel() {
    if (this.data.submitting || this._confirming) return;
    if (this.data.title.trim() || this.data.content.trim()) {
      this._confirming = true;
      const yes = await C.confirm({
        title: '保留这次输入吗？',
        content: this._draftSaved ? '离开后未发布的内容保存在本机草稿中，下次发布可继续填写。' : '本机草稿尚未保存成功。确认后会再试一次；仍失败时将留在本页。',
        confirmText: '保存离开',
        cancelText: '继续编辑'
      });
      this._confirming = false;
      if (!yes) return;
      if (!this.save()) return;
    }
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    C.goBack()
  },
  async submit() {
    if (this.data.submitting || !this.data.allowed) return;
    const title = this.data.title.trim(),
      content = this.data.content.trim();
    const titleError = !title ? '请填写帖子标题。' : Array.from(title).length > 60 ? '标题最多 60 字，请缩短后发布。' : '';
    const contentError = !content ? '请填写帖子正文。' : Array.from(content).length > 2000 ? '正文最多 2000 字，请缩短后发布。' : '';
    if (titleError || contentError) {
      this.setData({titleError, contentError, error:'请检查标出的字段，输入会保留。',focusTitle:!!titleError,focusContent:!titleError && !!contentError});
      return;
    }
    const fingerprint = JSON.stringify([this.data.category, title, content]);
    if (fingerprint !== this._fingerprint || !this._request) {
      this._request = C.requestId();
      this._fingerprint = fingerprint
    }
    this.save();
    this.setData({
      submitting: true,
      error: ''
    });
    try {
      const r = await C.callWall('publish', {
        category: this.data.category,
        title,
        content,
        requestId: this._request
      });
      try { wx.removeStorageSync(DRAFT) } catch (storageError) {}
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      this.setData({
        result: r
      })
    } catch (e) {
      this.setData({
        error: e.message
      });
      if (e.code === 'ACCESS_DENIED') this.setData({
        allowed: false,
        access: 'revoked'
      })
    } finally {
      this.setData({
        submitting: false
      })
    }
  },
  mine() {
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    wx.redirectTo({
      url: '/pages/my-posts/index'
    })
  },
  wall() {
    wx.switchTab({
      url: '/pages/campus-wall/index'
    })
  },
  goAccess: C.goAccess
});
