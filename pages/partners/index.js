const C = require('../../utils/campus');
const {
  activities
} = require('../../utils/demo-data');
Page({
  data: {
    items: activities,
    filter: '全部',
    filters: ['全部', '比赛', '活动', '课题', '其他'],
    reducedMotion: false,
    reducedTransparency: false
  },
  onShow() {
    C.syncTab(this, 'pages/partners/index');
    this.setData({
      reducedMotion: C.getReducedMotion(),
      reducedTransparency: C.getReducedTransparency()
    })
  },
  filter(e) {
    const filter = e.currentTarget.dataset.value;
    this.setData({
      filter,
      items: activities.filter(x => filter === '全部' || x.type === filter)
    })
  },
  unavailable: C.showUnavailable
});
