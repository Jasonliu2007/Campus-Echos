import config from './config';

App({
  onLaunch() {
    if (wx.cloud) wx.cloud.init({ env: config.cloudEnv, traceUser: true });
    const updateManager = wx.getUpdateManager();
    updateManager.onUpdateReady(() => {
      wx.showModal({
        title: '校园回声有新版本',
        content: '新版本已准备好。请先保存正在填写的内容，再重新打开。',
        confirmText: '重新打开',
        success: ({ confirm }) => { if (confirm) updateManager.applyUpdate(); },
      });
    });
  },
  globalData: { userInfo: null },
});
