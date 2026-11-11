const C = require('../../utils/campus');
Page({
  data: {
    loading: true,
    error: '',
    post: null,
    deleting: false,
    reducedMotion: false,
    reducedTransparency: false
  },
  onLoad(q) {
    this.postId = q.id
  },
  onShow() {
    this.setData({
      reducedMotion: C.getReducedMotion(),
      reducedTransparency: C.getReducedTransparency()
    });
    this.load()
  },
  async load() {
    if (this._loading) return;
    this._loading = true;
    this.setData({
      loading: true,
      error: ''
    });
    try {
      const r = await C.callWall('getPost', {
        postId: this.postId
      });
      this.setData({
        post: C.formatPost(r.post)
      })
    } catch (e) {
      this.setData({
        error: e.message,
        post: null
      })
    } finally {
      this._loading = false;
      this.setData({
        loading: false
      })
    }
  },
  async remove() {
    if (this.data.deleting || this._confirming || !this.data.post) return;
    this._confirming = true;
    const yes = await C.confirm({
      title: '删除这条帖子？',
      content: '删除后内容不再展示，此操作不可撤销。请确认这是你想删除的帖子。',
      confirmText: '确认删除',
      confirmColor: '#B83D49'
    });
    this._confirming = false;
    if (!yes) return;
    this.setData({
      deleting: true,
      error: ''
    });
    try {
      await C.callWall('deletePost', {
        postId: this.postId,
        revision: this.data.post.revision
      });
      await this.load()
    } catch (e) {
      this.setData({
        error: e.message
      });
      if (e.code === 'CONFLICT') {
        await this.load();
        this.setData({error:'帖子状态已更新，已刷新为最新结果。请核对后再操作。'});
      }
    } finally {
      this.setData({
        deleting: false
      })
    }
  },
  wall() {
    wx.switchTab({
      url: '/pages/campus-wall/index'
    })
  }
});
