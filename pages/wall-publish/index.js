const C = require('../../utils/campus');
const Layout = require('../../utils/post-layout');
const Media = require('../../utils/forum-media');
const DRAFT = 'campusEchoDraftV1';
Page({
  data: {
    categories: C.categories,
    symbols: Layout.symbols,
    tool: '',
    avatarId: '',
    coverId: '',
    stickerId: 0, stickers: Array.from({ length: 30 }, (_, i) => i + 1),
    composerPanel: '', replyScope: 'members', reviewReplies: false,
    poll: [], location: '', keyboardHeight: 0,
    audienceOpen: false,
    topInset: 48,
    presetPicker: '',
    avatarOptions: ['橘猫', '猫头鹰', '白兔', '小鸭', '背包', '绿植', '耳机', '笔记本'],
    coverOptions: ['自习', '校园活动', '比赛', '找搭子', '失物招领', '校园日常'],
    previewing: false,
    previewBlocks: [],
    cursor: -1,
    category: '校园生活墙',
    community: 'forum', editing: false, images: [], uploadedImages: 0, experienceDeclared: false, isAnonymous: false, anonymousLocked: false, imageBusy: false, editExpired: false, conflict: false,
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
  goCampusEmail() {
    wx.navigateTo({ url: '/pages/campus-email/index' });
  },
  onLoad(query = {}) {
    const capsuleBottom = wx.getMenuButtonBoundingClientRect?.()?.bottom;
    this.setData({ topInset: capsuleBottom > 0 ? capsuleBottom + 6 : (wx.getWindowInfo?.()?.statusBarHeight || 0) + 40 });
    this.postId = query.id || '';
    const quotePostId = !this.postId && /^[a-f0-9]{32}$/.test(query.quote || '') ? query.quote : '';
    this.setData({ quotePostId });
    this._draftKey = quotePostId ? DRAFT + ':quote:' + quotePostId : this.postId ? DRAFT + ':edit:' + this.postId : query.community === 'experience' ? DRAFT + ':experience' : DRAFT;
    const community = query.community === 'experience' ? 'experience' : 'forum';
    const defaultCategory = !this.postId && !quotePostId && community === 'forum'
      && typeof query.categoryIndex === 'string' && /^[0-9]$/.test(query.categoryIndex)
      ? C.categories[Number(query.categoryIndex)] : undefined;
    this.setData({ editing: !!this.postId, community, ...(defaultCategory ? { category: defaultCategory } : {}) });
    try {
      const draft = wx.getStorageSync(this._draftKey || DRAFT);
      if (draft && typeof draft === 'object') this.setData({
        avatarId: /^avatar-[1-8]$/.test(draft.avatarId) ? draft.avatarId : '',
        stickerId: Number.isInteger(draft.stickerId) && draft.stickerId >= 1 && draft.stickerId <= 30 ? draft.stickerId : 0,
        replyScope: draft.replyScope === 'author' ? 'author' : 'members', reviewReplies: draft.reviewReplies === true,
        poll: Array.isArray(draft.poll) ? draft.poll.slice(0, 4) : [], location: typeof draft.location === 'string' ? draft.location : '',
        coverId: /^cover-[1-6]$/.test(draft.coverId) ? draft.coverId : '',
        category: defaultCategory || (C.categories.includes(draft.category) ? draft.category : '校园生活墙'),
        title: draft.title || '',
        content: draft.content || '',
        titleCount: Array.from(draft.title || '').length,
        contentCount: Array.from(draft.content || '').length,
        experienceDeclared: draft.experienceDeclared === true, anonymousLocked: draft.anonymousLocked === true || !!this.postId, images: Array.isArray(draft.images) ? draft.images.map(row => Media.present(row.status === 'uploading' ? { ...row, status: 'failed', error: '上次上传中断，可重试或移除。' } : row)) : [], isAnonymous: draft.isAnonymous === true
      });
      if (!this.postId && !quotePostId && /^[a-f0-9]{32}$/.test(draft?.quotePostId || '')) this.setData({ quotePostId: draft.quotePostId });
      this._draftSaved = !!(draft && typeof draft === 'object');
      this._request = draft && draft.requestId ? draft.requestId : '';
      this._fingerprint = draft && draft.fingerprint || '';
      this._revision = draft && draft.revision;
      this._editDeadline = draft && draft.editDeadline;
    } catch (e) {}
    this._hasDraft = !!this.data.title || !!this.data.content || this.data.images.length > 0 || !!this.data.coverId || !!this.data.avatarId;
    this.updateLeaveAlert()
  },
  async onShow() {
    this._visible = true;
    const epoch = this._epoch = (this._epoch || 0) + 1;
    this.setData({
      reducedMotion: C.getReducedMotion(),
      reducedTransparency: C.getReducedTransparency(),
      loading: true,
      allowed: false,
      needsCampusEmail: false,
      error: ''
    });
    try {
      const r = await C.callWall('session');
      if (!this.isActive(epoch)) return;
      this.setData({ authorName: r.member?.nickname || '校园同学', official: r.canManageAdmins === true });
      if (!this.postId && !this.data.avatarId) {
        try {
          const avatarId = wx.getStorageSync('campusPostAvatar:' + r.member?.id);
          if (r.member?.id && /^avatar-[1-8]$/.test(avatarId)) this.setData({ avatarId });
        } catch (error) {}
      }
      this._avatarOwner = r.member?.id;
      this._supportsQuotes = r.supportsForumQuotes === true;
      this._supportsComposerOptions = r.supportsComposerOptions === true;
      if (this.data.quotePostId && r.access === 'approved' && !this.data.quote) {
        try {
          const { post } = await C.callWall('getPost', { postId: this.data.quotePostId });
          if (this.isActive(epoch)) this.setData({ quote: post.status === 'published' ? post : null, quoteUnavailable: post.status !== 'published' });
        } catch (error) {
          if (this.isActive(epoch)) this.setData({ quoteUnavailable: true });
        }
      }
      const eligible = r.access === 'approved' && !r.member?.banned && !(r.member?.mutedUntil > Date.now());
      const needsCampusEmail = eligible && !this.postId && r.campusEmailRequired === true && r.campusEmailVerified !== true;
      this.setData({ allowed: eligible && !needsCampusEmail, needsCampusEmail, access: r.access });
      if (r.member?.banned || r.member?.mutedUntil > Date.now()) this.setData({ error: r.member.sanctionReason || '当前账号暂不能发布或编辑，草稿仍保留。' });
      if (this.postId && !this._loadedEdit && r.access === 'approved') {
        const result = await C.callWall('getPost', { postId: this.postId }); const post = result.post;
        if (!this.isActive(epoch)) return;
        this._loadedEdit = true;
        const staleDraft = this._hasDraft && this._revision !== post.revision;
        if (!this._hasDraft) this._revision = post.revision;
        this._editDeadline = post.editDeadline;
        if (staleDraft) this.setData({ conflict: true, error: '本机草稿与最新版本需要重新核对。草稿保留，请先核对再提交。' });
        const editExpired = !post.isOwner || ['deleted', 'hidden'].includes(post.status) || Date.now() >= post.editDeadline;
        this.setData({ community: post.community || 'forum', isAnonymous: !!post.isAnonymous, anonymousLocked: true, editExpired, allowed: this.data.allowed && !editExpired });
        if (!this._hasDraft) this.setData({ title: post.hideTitle ? '' : post.title, content: post.content, titleCount: post.hideTitle ? 0 : Array.from(post.title).length, contentCount: Array.from(post.content).length, category: post.category, avatarId: /^avatar-[1-8]$/.test(post.avatarId) ? post.avatarId : '', coverId: post.coverId || '', stickerId: post.stickerId || 0, replyScope: post.replyScope || 'members', reviewReplies: post.reviewReplies === true, poll: post.poll?.options || [], location: post.location || '', images: (post.mediaIds || []).map(mediaId => Media.present({ key: mediaId, mediaId, status: 'approved' })) });
      }
      if (this.postId && this._editDeadline && Date.now() >= this._editDeadline) this.setData({ editExpired: true, allowed: false });
      this.armEditDeadline();
      this.checkImages();
    } catch (e) {
      if (!this.isActive(epoch)) return;
      this.setData({
        error: e.message
      })
    } finally {
      if (this.isActive(epoch)) this.setData({
        loading: false
      })
    }
  },
  input(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    if (key === 'content') this._cursor = Layout.safeCursor(value, e.detail.cursor);
    this.setData({
      [key]: value,
      [key + 'Count']: Array.from(value).length,
      error: '',
      [key + 'Error']: '',
    });
    this.save();
    this.updateLeaveAlert();
    return value
  },
  keyboardChange(e) { this.setData({ keyboardHeight: e.detail.height || 0 }); },
  openPanel(e) {
    if (this.data.submitting) return;
    const panel = e.currentTarget.dataset.panel;
    if (panel !== 'more') wx.hideKeyboard?.();
    this.setData({ composerPanel: this.data.composerPanel === panel ? '' : panel, audienceOpen: false, focusContent: false, focusTitle: false });
  },
  closePanel() { this.setData({ composerPanel: '', audienceOpen: false }); },
  noop() {},
  showTitleField() { this.setData({ showTitle: true, composerPanel: '' }); },
  onShareAppMessage() {
    const result = this.data.result;
    return result?.status === 'published'
      ? { title: this.data.title || this.data.content.trim().split('\n')[0], path: '/pages/wall-detail/index?id=' + result.postId }
      : { title: '校园回声', path: '/pages/campus-wall/index' };
  },
  shareAfterPostChange(e) { this.setData({ shareAfterPost: e.detail.value === true }); },
  audience() { this.setData({ audienceOpen: !this.data.audienceOpen }); },
  chooseScope(e) {
    const scope = e.currentTarget.dataset.scope;
    if (!['members', 'author'].includes(scope)) return;
    this.setData({ replyScope: scope, ...(scope === 'author' ? { reviewReplies: false } : {}) }); this.save();
  },
  reviewRepliesChange(e) { this.setData({ reviewReplies: e.detail.value === true }); this.save(); },
  chooseSticker(e) { this.setData({ stickerId: Number(e.currentTarget.dataset.id), composerPanel: '' }); this.save(); },
  editLocation(e) { this.setData({ location: e.detail.value }); this.save(); },
  addPoll() {
    this.setData({ composerPanel: 'poll', poll: this.data.poll.length ? this.data.poll : ['', ''] }); this.save();
  },
  addPollOption() {
    if (this.data.poll.length < 4) { this.setData({ poll: [...this.data.poll, ''] }); this.save(); }
  },
  editPoll(e) {
    const poll = [...this.data.poll];
    poll[e.currentTarget.dataset.index] = e.detail.value;
    this.setData({ poll }); this.save();
  },
  removePoll() { this.setData({ poll: [], composerPanel: '' }); this.save(); },
  openQuotePicker() {
    this.closePanel();
    wx.navigateTo({ url: '/pages/wall-search/index?pickQuote=1', events: { quoteSelected: post => {
      this.setData({ quotePostId: post._id, quote: post, quoteUnavailable: false }); this.save();
    } } });
  },
  removeQuote() { this.setData({ quotePostId: '', quote: null, quoteUnavailable: false }); this.save(); },
  addToThread() { this.insert({ currentTarget: { dataset: { kind: 'paragraph' } } }); },
  rememberCursor(e) {
    if (e.detail && Number.isInteger(e.detail.cursor)) this._cursor = Layout.safeCursor(this.data.content, e.detail.cursor);
  },
  toggleTool(e) {
    if (this.data.submitting) return;
    const tool = e.currentTarget.dataset.tool;
    this.setData({ tool: this.data.tool === tool ? '' : tool, focusContent: false });
  },
  insert(e) {
    if (this.data.submitting) return;
    const { symbol, kind } = e.currentTarget.dataset;
    let insertion = '';
    const cursor = Layout.safeCursor(this.data.content, this._cursor);
    const prefix = cursor > 0 && this.data.content[cursor - 1] !== '\n' ? '\n\n' : '';
    if (Layout.symbols.includes(symbol)) insertion = symbol + ' ';
    else if (kind === 'heading') insertion = prefix + '【小标题】\n';
    else if (kind === 'list') insertion = prefix + '• ';
    else if (kind === 'paragraph') insertion = '\n\n';
    else if (kind === 'divider') insertion = prefix + '———\n';
    else if (kind === 'template') insertion = prefix + Layout.templates[this.data.community === 'experience' ? 'experience' : this.data.category];
    if (!insertion) return;
    const result = Layout.insertText(this.data.content, insertion, cursor);
    if (result.error) { this.setData({ error: result.error }); return; }
    this._cursor = result.cursor;
    this.setData({ ...result, composerPanel: '', error: '', contentError: '', focusContent: false }, () => this.setData({ focusContent: true }));
    this.save();
  },
  preview() {
    if (this.data.submitting) return;
    this.setData({ previewing: !this.data.previewing, composerPanel: '', titlePreview: this._supportsComposerOptions ? this.data.title.trim() : this.data.title.trim() || Array.from(this.data.content.trim().split('\n')[0]).slice(0, 60).join(''), previewBlocks: Layout.blocks(this.data.content), focusContent: false, focusTitle: false });
  },
  category(e) {
    this.setData({
      category: this.data.categories[Number(e.detail.value)]
    });
    this.save()
  },
  save() {
    this.setData({ uploadedImages: this.data.images.filter(row => !!row.mediaId).length });
    try {
      wx.setStorageSync(this._draftKey || DRAFT, {stickerId:this.data.stickerId,replyScope:this.data.replyScope,reviewReplies:this.data.reviewReplies,poll:this.data.poll,location:this.data.location,quotePostId:this.data.quotePostId,title:this.data.title,content:this.data.content,category:this.data.category,avatarId:this.data.avatarId,coverId:this.data.coverId,images:this.data.images.map(({ url, ...row }) => row),isAnonymous:this.data.isAnonymous,experienceDeclared:this.data.experienceDeclared,anonymousLocked:this.data.anonymousLocked,revision:this._revision,editDeadline:this._editDeadline,requestId:this._request||'',fingerprint:this._fingerprint||''});
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
    const dirty = this.data.title.trim() || this.data.content.trim() || this.data.images.length || this.data.coverId || this.data.stickerId || this.data.poll.length || this.data.location || this.data.quotePostId;
    if (dirty && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({message:this._draftSaved?'输入已保存在本机草稿，确认离开？':'草稿尚未保存成功，离开会丢失本次输入。'});
    else if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
  },
  async cancel() {
    const epoch = this._epoch;
    if (this.data.submitting || this._confirming) return;
    if (this.data.title.trim() || this.data.content.trim() || this.data.images.length || this.data.coverId || this.data.stickerId || this.data.poll.length || this.data.location || this.data.quotePostId) {
      this._confirming = true;
      const yes = await C.confirm({
        title: '保留这次输入吗？',
        content: this._draftSaved ? '离开后未发布的内容保存在本机草稿中，下次发布可继续填写。' : '本机草稿尚未保存成功。确认后会再试一次；仍失败时将留在本页。',
        confirmText: '保存离开',
        cancelText: '继续编辑'
      });
      this._confirming = false;
      if (!yes || !this.isActive(epoch)) return;
      if (!this.save()) return;
    }
    if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
    C.goBack()
  },
  experienceDeclaration(e) { if (this.data.submitting) return; this.setData({ experienceDeclared: e.detail.value.includes('confirmed') }); this.save(); },
  async submit() {
    if (this.data.submitting || this.data.imageBusy || !this.data.allowed || this.data.conflict) return;
    if (this.data.community === 'experience' && !this.data.experienceDeclared) { this.setData({ previewing: false, error: '投稿前请确认这是本人真实经历，引用内容已经获得授权。' }); return; }
    if (this.data.images.some(row => row.status !== 'approved')) { this.setData({ error: '图片必须全部审核通过后才能提交，请等待、重试或移除未通过的图片。' }); return; }
    const content = this.data.content.trim();
    const title = this.data.title.trim() || Array.from(content.split('\n')[0].trim()).slice(0, 60).join('');
    const poll = this.data.poll.map(value => value.trim());
    if (poll.length && (poll.some(value => !value) || new Set(poll).size !== poll.length)) {
      this.setData({ error: '请填写不同的投票选项。', composerPanel: 'poll' }); return;
    }
    if (!this._supportsComposerOptions && (this.data.stickerId || this.data.replyScope === 'author' || this.data.reviewReplies || poll.length || this.data.location)) {
      this.setData({ error: '请更新服务后再发布带有贴纸、投票、地点或回复设置的帖子。' }); return;
    }
    const titleError = Array.from(title).length > 60 ? '标题最多 60 字，请缩短后发布。' : '';
    const contentError = !content ? '请填写帖子正文。' : Array.from(content).length > 2000 ? '正文最多 2000 字，请缩短后发布。' : '';
    if (titleError || contentError) {
      this.setData({previewing:false, titleError, contentError, error:'请检查标出的字段，输入会保留。',showTitle:!!titleError || this.data.showTitle,focusTitle:!!titleError,focusContent:!titleError && !!contentError});
      return;
    }
    if (this.data.coverId && this.data.images.length >= 9) {
      this.setData({ previewing: false, error: '配图与上传图片合计最多9张。' });
      return;
    }
    if (this.data.quotePostId && !this._supportsQuotes) {
      this.setData({ error: '当前服务版本暂未开放引用，草稿已保留。' });
      return;
    }
    if (this.data.quotePostId && !this.data.quote) {
      this.setData({ error: '原帖暂不可引用。' });
      return;
    }
    const presets = {
      ...(this.postId || this.data.avatarId ? { avatarId: this.data.isAnonymous || this.data.official ? '' : this.data.avatarId } : {}),
      ...(this.postId || this.data.coverId ? { coverId: this.data.coverId } : {})
    };
    if (this._supportsComposerOptions) {
      if (this.postId || !this.data.title.trim()) presets.hideTitle = !this.data.title.trim();
      if (this.postId || this.data.stickerId) presets.stickerId = this.data.stickerId;
      if (this.postId || this.data.replyScope === 'author') presets.replyScope = this.data.replyScope;
      if (this.postId || this.data.reviewReplies) presets.reviewReplies = this.data.reviewReplies;
      if (this.postId || poll.length) presets.poll = poll.length ? poll : null;
      if (this.postId || this.data.location) presets.location = this.data.location.trim();
    }
    const fingerprint = JSON.stringify([this.postId || '', this._revision || 0, this.data.community, this.data.category, title, content, this.data.isAnonymous, this.data.images.map(x => x.mediaId), ...(Object.keys(presets).length ? [presets] : []), ...(this.data.quotePostId ? [this.data.quotePostId] : [])]);
    if (fingerprint !== this._fingerprint || !this._request) {
      this._request = C.requestId();
      this._fingerprint = fingerprint
    }
    this.save();
    const epoch = this._epoch;
    this.setData({
      submitting: true,
      anonymousLocked: true,
      error: ''
    });
    this.save();
    try {
      const r = await C.callWall(this.postId ? 'editPost' : 'publish', {
        ...(this.postId ? { postId: this.postId, revision: this._revision } : {}),
        community: this.data.community, ...(this.data.community === 'experience' ? { experienceDeclared: this.data.experienceDeclared } : {}), isAnonymous: this.data.isAnonymous, mediaIds: this.data.images.map(x => x.mediaId),
        ...presets,
        ...(this.data.quotePostId ? { quotePostId: this.data.quotePostId } : {}),
        category: this.data.category,
        title,
        content,
        requestId: this._request
      });
      if (!this.isActive(epoch)) return;
      try { wx.removeStorageSync(this._draftKey || DRAFT) } catch (storageError) {}
      if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      this.setData({
        result: r
      })
    } catch (e) {
      if (!this.isActive(epoch)) return;
      this.setData({
        previewing: false,
        error: e.message
      });
      if (e.code === 'EMAIL_VERIFICATION_REQUIRED') this.setData({ needsCampusEmail: true, allowed: false });
      if (e.code === 'CONFLICT') this.setData({ conflict: true, error: '内容已有新版本，本次草稿保留。请查看最新版本后重新确认，未自动覆盖。' });
      if (e.code === 'EDIT_WINDOW_EXPIRED') this.setData({ editExpired: true, allowed: false });
      if (e.code === 'ACCESS_DENIED') this.setData({
        allowed: false,
        access: 'revoked'
      })
    } finally {
      if (this.isActive(epoch)) this.setData({
        submitting: false
      })
    }
  },
  async toggleAnonymous() {
    if (this.data.submitting || this.data.anonymousLocked || this._anonymousConfirming) return;
    const epoch = this._epoch;
    this._anonymousConfirming = true;
    try {
      if (!this.data.isAnonymous) {
        const yes = await C.confirm({ title: '开启前台匿名？', content: '其他同学看到匿名同学；匿名楼主评论与回复也匿名。管理员可在私有入口核查作者并留记录。首次提交后不能更改匿名模式。', confirmText: '开启匿名' });
        if (!yes || !this.isActive(epoch)) return;
      }
      this.setData({ isAnonymous: !this.data.isAnonymous }); this.save();
    } finally { this._anonymousConfirming = false; if (this.isActive(epoch)) this.setData({ isAnonymous: this.data.isAnonymous }); }
  },
  togglePresets(e) {
    if (this.data.submitting || this.data.imageBusy) return;
    const picker = e.currentTarget.dataset.kind;
    this.setData({ presetPicker: this.data.presetPicker === picker ? '' : picker });
  },
  choosePreset(e) {
    if (this.data.submitting || this.data.imageBusy) return;
    const { kind, id } = e.currentTarget.dataset;
    if (kind === 'avatar' && !this.data.isAnonymous && !this.data.official && /^avatar-[1-8]$/.test(id)) {
      this.setData({ avatarId: id, presetPicker: '' });
      if (!this.postId && this._avatarOwner) {
        try { wx.setStorageSync('campusPostAvatar:' + this._avatarOwner, id); } catch (error) {}
      }
    } else if (kind === 'cover' && (id === '' || /^cover-[1-6]$/.test(id))) {
      if (id && this.data.images.length >= 9) {
        this.setData({ error: '图片已满9张，请先移除一张。' });
        return;
      }
      this.setData({ coverId: id, presetPicker: '', composerPanel: '' });
    } else return;
    this.save();
  },
  chooseCamera() { this.closePanel(); return this.chooseImages({ currentTarget: { dataset: { source: 'camera' } } }); },
  async chooseImages(e) {
    const remaining = 9 - this.data.images.length - (this.data.coverId ? 1 : 0);
    if (this.data.imageBusy || this.data.submitting || remaining <= 0) return;
    this.setData({ imageBusy: true, error: '' });
    try {
      const rows = await Media.choose(remaining, e?.currentTarget?.dataset?.source === 'camera' ? ['camera'] : ['album']);
      if (this._disposed) return;
      this.setData({ images: this.data.images.concat(rows.map(Media.present)) }); this.save();
      for (const row of rows) if (!row.error) await this.uploadOne(row.key);
    } catch (error) { if (!this._disposed) this.setData({ error: error.message || '图片选择或压缩失败，正文已保留。' }); }
    finally { if (!this._disposed) this.setData({ imageBusy: false }); }
  },
  async uploadOne(key) {
    const row = this.data.images.find(x => x.key === key); if (!row || row.status === 'uploading') return;
    const patch = values => { if (this._disposed) return; const images = this.data.images.map(x => x.key === key ? Media.present({ ...x, ...values }) : x); this.setData({ images }); this.save(); };
    patch({ status: 'uploading', error: '' });
    try { const result = await Media.upload(row); patch({ mediaId: result.mediaId, status: result.status }); this.armImageCheck(); }
    catch (error) { patch({ status: 'failed', error: error.message }); }
  },
  async retryImage(e) { if (this.data.imageBusy || this.data.submitting) return; this.setData({ imageBusy: true }); try { await this.uploadOne(e.currentTarget.dataset.key); } finally { if (!this._disposed) this.setData({ imageBusy: false }); } },
  removeImage(e) { if (this.data.submitting || this.data.imageBusy) return; this.setData({ images: this.data.images.filter(x => x.key !== e.currentTarget.dataset.key) }); this.save(); },
  async checkImages() {
    if (this._checkingImages || this.data.submitting) return; this._checkingImages = true;
    try {
      for (const row of this.data.images) if (row.mediaId && !['rejected', 'deleted'].includes(row.status)) {
        try { const result = await C.callWall('getMedia', { mediaId: row.mediaId, ...(this.postId ? { postId: this.postId } : {}) }); if (this._disposed) return; this.setData({ images: this.data.images.map(x => x.key === row.key ? Media.present({ ...x, ...result }) : x) }); }
        catch (error) { if (!this._disposed) this.setData({ error: error.message }); }
      }
      this.save();
    } finally { this._checkingImages = false; this.armImageCheck(); }
  },
  previewImage(e) {
    const { key, cover } = e.currentTarget.dataset;
    const coverUrl = this.data.coverId ? '/static/presets/' + this.data.coverId + '.jpg' : '';
    const row = this.data.images.find(image => image.key === key);
    const current = cover ? coverUrl : row?.path || row?.url;
    if (current) wx.previewImage({ current, urls: [coverUrl, ...this.data.images.map(image => image.path || image.url)].filter(Boolean) });
  },
  latest() { if (this.postId) wx.navigateTo({ url: '/pages/wall-detail/index?id=' + this.postId }); },
  async rebaseEdit() {
    const epoch = this._epoch;
    if (!this.postId || this.data.submitting || this._confirming) return;
    this._confirming = true;
    try {
      const result = await C.callWall('getPost', { postId: this.postId }), post = result.post;
      if (!this.isActive(epoch)) return;
      if (!post.isOwner || ['deleted', 'hidden'].includes(post.status) || Date.now() >= post.editDeadline) { this.setData({ editExpired: true, allowed: false, error: '当前版本已不可编辑，草稿仍保留。' }); return; }
      const yes = await C.confirm({ title: '使用最新版本重新核对？', content: '最新标题：' + post.title + '。你的本次输入保持不变；确认后才允许重新提交审核，不自动覆盖。', confirmText: '保留草稿重新核对' });
      if (!yes || !this.isActive(epoch)) return;
      this._revision = post.revision; this._editDeadline = post.editDeadline; this._request = ''; this._fingerprint = ''; this.setData({ conflict: false, allowed: true, error: '已核对最新版本。请检查草稿后重新提交。', isAnonymous: !!post.isAnonymous }); this.save(); this.armEditDeadline();
    } catch (error) { if (this.isActive(epoch)) this.setData({ error: error.message }); }
    finally { this._confirming = false; }
  },
  armEditDeadline() { clearTimeout(this._editTimer); if (!this.postId || !this._editDeadline || this._visible === false) return; this._editTimer = setTimeout(() => { if (this._visible && !this._disposed) this.setData({ editExpired: true, allowed: false, error: '首次提交已满30分钟，草稿保留但不能再编辑。' }); }, Math.max(0, this._editDeadline - Date.now())); },
  armImageCheck() { clearTimeout(this._imageTimer); if (this._visible && !this._disposed && this.data.images.some(x => ['checking', 'uploading'].includes(x.status))) this._imageTimer = setTimeout(() => this.checkImages(), 4000); },
  isActive(epoch) { return !this._disposed && this._visible !== false && epoch === this._epoch; },
  onHide() { clearTimeout(this._imageTimer); clearTimeout(this._editTimer); this._visible = false; this._epoch = (this._epoch || 0) + 1; this.setData({ submitting: false, keyboardHeight: 0 }); },
  onUnload() { this.onHide(); this._disposed = true; if (wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload(); },
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
