const C = require('../../utils/campus');
Page({
  data: {
    reducedMotion: false,
    reducedTransparency: false,
    settingsError: ''
  },
  onShow() {
    this.setData({
      reducedMotion: C.getReducedMotion(),
      reducedTransparency: C.getReducedTransparency()
    });
  },
  motion(e) {
    this.savePreference('reducedMotion', e.detail.value, C.setReducedMotion);
  },
  transparency(e) {
    this.savePreference('reducedTransparency', e.detail.value, C.setReducedTransparency);
  },
  savePreference(key, value, save) {
    const enabled = value === true;
    try {
      save(enabled);
      this.setData({ [key]: enabled, settingsError: '' });
    } catch (error) {
      this.setData({
        [key]: key === 'reducedMotion' ? C.getReducedMotion() : C.getReducedTransparency(),
        settingsError: '设置未能保存，请检查本机存储后重试。'
      });
    }
  }
});
