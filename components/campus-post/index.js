const C = require('../../utils/campus');

Component({
  properties: {
    post: Object,
    interactive: Boolean,
    showStatus: Boolean,
    reducedMotion: Boolean
  },
  observers: {
    async post(post) {
      const request = this.thumbnailRequest = (this.thumbnailRequest || 0) + 1;
      this.setData({ thumbnail: '', liked: post?.liked, likeCount: post?.likeCount || 0, likeBusy: false });
      const mediaId = post?.mediaIds?.[0];
      if (this.data.showStatus || post?.status !== 'published' || post.coverId || !mediaId) return;
      try {
        const media = await C.callWall('getMedia', { mediaId, postId: post._id });
        if (request === this.thumbnailRequest) this.setData({ thumbnail: media.url || '' });
      } catch (error) {}
    }
  },
  lifetimes: {
    detached() { this.thumbnailRequest = (this.thumbnailRequest || 0) + 1; }
  },
  methods: {
    previewPhoto() {
      const { post, thumbnail } = this.data;
      const current = post.coverId ? '/static/presets/' + post.coverId + '.jpg' : thumbnail;
      if (current) wx.previewImage({ current, urls: [current] });
    },
    quote() {
      wx.navigateTo({ url: '/pages/wall-publish/index?quote=' + encodeURIComponent(this.data.post._id) });
    },
    openQuote() {
      const id = this.data.post.quote?.id;
      if (id) wx.navigateTo({ url: '/pages/wall-detail/index?id=' + encodeURIComponent(id) });
    },
    reply() {
      wx.navigateTo({ url: '/pages/wall-detail/index?reply=1&id=' + encodeURIComponent(this.data.post._id) });
    },
    async toggleLike() {
      const { post, likeBusy } = this.data;
      if (!this.data.interactive || likeBusy || post.status !== 'published') return;
      const request = this.thumbnailRequest;
      this.setData({ likeBusy: true });
      try {
        const current = typeof this.data.liked === 'boolean'
          ? { liked: this.data.liked, likeCount: this.data.likeCount }
          : await C.callWall('getLikeState', { postId: post._id });
        if (request !== this.thumbnailRequest) return;
        this.setData({ liked: !current.liked, likeCount: Math.max(0, current.likeCount + (current.liked ? -1 : 1)) });
        try {
          const result = await C.callWall('setLiked', { postId: post._id, liked: !current.liked });
          if (request === this.thumbnailRequest) this.setData({ liked: result.liked, likeCount: result.likeCount });
        } catch (error) {
          if (request === this.thumbnailRequest) this.setData({ liked: current.liked, likeCount: current.likeCount });
          throw error;
        }
      } catch (error) {
        if (request === this.thumbnailRequest) wx.showToast({ title: error.message, icon: 'none' });
      } finally {
        if (request === this.thumbnailRequest) this.setData({ likeBusy: false });
      }
    },
    more() {
      const post = this.data.post;
      const actions = post.isOwner
        ? [{ label: '打开帖子', run: () => this.open() }]
        : [{ label: '举报', run: () => wx.navigateTo({ url: '/pages/report-post/index?id=' + encodeURIComponent(post._id) }) }];
      if (post.canEdit) actions.unshift({ label: '编辑', run: () => wx.navigateTo({ url: '/pages/wall-publish/index?id=' + encodeURIComponent(post._id) }) });
      wx.showActionSheet({ itemList: actions.map(action => action.label), success: ({ tapIndex }) => actions[tapIndex]?.run() });
    },
    open() {
      this.triggerEvent('open', {
        id: this.data.post._id
      })
    }
  }
});
