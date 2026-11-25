const { getReducedMotion, getReducedTransparency, getTabHaptics } = require('../utils/campus');
const SLIDE_MS = 260;
const tabInstances = new Map();
Component({
  data: {
    active: '',
    selected: '',
    indicatorIndex: 0,
    motionReady: false,
    reducedMotion: false,
    reducedTransparency: false,
    items: [
      { path: 'pages/campus-wall/index', label: '论坛', icon: 'wall' },
      { path: 'pages/direct-inbox/index', label: '私信', icon: 'direct' },
      { path: 'pages/materials/index', label: '学习资料', icon: 'book' },
      { path: 'pages/partners/index', label: '找搭子', icon: 'users' },
      { path: 'pages/my/index', label: '我的', icon: 'user' }
    ]
  },
  lifetimes: {
    attached() {
      this._disposed = false;
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      const route = pages[pages.length - 1]?.route;
      if (!this.data.active && route) this.syncRoute(route);
    },
    detached() {
      this._disposed = true;
      if (tabInstances.get(this._route) === this) tabInstances.delete(this._route);
      clearTimeout(this._slideTimer);
      clearTimeout(this._readyTimer);
    }
  },
  pageLifetimes: {
    hide() {
      clearTimeout(this._slideTimer);
      clearTimeout(this._readyTimer);
      this._pendingPath = null;
      // Keep the outgoing frame at its current position. The next onShow aligns the tab.
    }
  },
  methods: {
    indexOf(path) {
      return this.data.items.findIndex(item => item.path === path);
    },
    syncRoute(path) {
      const index = this.indexOf(path);
      if (index < 0 || this._disposed) return;
      if (this._route && this._route !== path && tabInstances.get(this._route) === this) {
        tabInstances.delete(this._route);
      }
      this._route = path;
      tabInstances.set(path, this);
      clearTimeout(this._slideTimer);
      clearTimeout(this._readyTimer);
      this._pendingPath = null;
      // Every WeChat tab owns a component instance. Align its first frame without replay.
      this.setData({
        active: path, selected: path, indicatorIndex: index, motionReady: false,
        reducedMotion: getReducedMotion(), reducedTransparency: getReducedTransparency()
      }, () => {
        this._readyTimer = setTimeout(() => {
          if (!this._disposed) this.setData({ motionReady: true });
        }, 0);
      });
    },
    switchTab(event) {
      const path = event.currentTarget.dataset.path;
      const index = this.indexOf(path);
      if (index < 0 || !this.data.active || this._disposed || this._switching) return;
      clearTimeout(this._slideTimer);
      this._pendingPath = path;
      const reducedMotion = getReducedMotion();
      this.setData({ selected: path, indicatorIndex: index, reducedMotion, reducedTransparency: getReducedTransparency() });
      if (path === this.data.active) { this._pendingPath = null; return; }
      const commit = () => {
        if (this._disposed || this._pendingPath !== path) return;
        this._pendingPath = null;
        this._switching = true;
        // A cached destination must already be aligned when its first frame is shown.
        const destination = tabInstances.get(path);
        if (destination && destination !== this) destination.syncRoute(path);
        let navigationFinished = false;
        wx.switchTab({
          url: '/' + path,
          success: () => {
            if (navigationFinished) return;
            navigationFinished = true;
            // Navigation success is the single feedback point; cancelled slides stay quiet.
            if (getTabHaptics() && typeof wx.vibrateShort === 'function') {
              try { wx.vibrateShort({ type: 'light', fail() {} }); } catch (error) {}
            }
          },
          fail: () => {
            if (navigationFinished) return;
            navigationFinished = true;
            if (!this._disposed) this.syncRoute(this.data.active);
            wx.showToast({ title: '页面未能切换，请重试', icon: 'none' });
          },
          complete: () => { this._switching = false; }
        });
      };
      // The same rendered lens retargets via CSS; navigate only after its latest slide.
      if (reducedMotion) commit();
      else this._slideTimer = setTimeout(commit, SLIDE_MS);
    }
  }
});
