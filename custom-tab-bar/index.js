const { getReducedMotion, getReducedTransparency } = require('../utils/campus');
Component({
  data: {
    active: 'pages/campus-wall/index',
    reducedMotion: false,
    reducedTransparency: false,
    items: [
      { path: 'pages/campus-wall/index', label: '校园墙', icon: 'wall' },
      { path: 'pages/materials/index', label: '学习资料', icon: 'book' },
      { path: 'pages/partners/index', label: '找搭子', icon: 'users' },
      { path: 'pages/my/index', label: '我的', icon: 'user' }
    ]
  },
  lifetimes: {
    attached() {
      this.setData({
        reducedMotion: getReducedMotion(),
        reducedTransparency: getReducedTransparency()
      });
    }
  },
  methods: {
    switchTab(event) {
      const path = event.currentTarget.dataset.path;
      if (path === this.data.active || this._switching) return;
      this._switching = true;
      wx.switchTab({
        url: '/' + path,
        success: () => this.setData({
          active: path,
          reducedMotion: getReducedMotion(),
          reducedTransparency: getReducedTransparency()
        }),
        complete: () => { this._switching = false; }
      });
    }
  }
});
