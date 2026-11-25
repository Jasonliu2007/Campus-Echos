const C = require('../../utils/campus');
const EXPERIENCE_TAB = 'experience';
const {
  makeList
} = require('../../utils/wall-list');
Page({
  ...makeList({
    route: 'pages/campus-wall/index',
    filters: true,
    extra: {
      sections: [
        { label: '学长学姐', value: EXPERIENCE_TAB },
        { label: '全部', value: '' },
        ...C.categories.map(category => ({ label: category, value: category }))
      ]
    }
  }),
  listParams() {
    const filter = this.data.filter;
    if (filter === EXPERIENCE_TAB) return { community: 'experience', includeLikeState: true };
    return { community: 'forum', includeLikeState: true, ...(filter ? { category: filter } : {}) };
  },
  onShareAppMessage(event) {
    const id = event?.target?.dataset?.id;
    const post = this.data.items.find(item => item._id === id && item.status === 'published');
    return post ? { title: post.title, path: '/pages/wall-detail/index?id=' + encodeURIComponent(post._id) }
      : { title: '校园回声', path: '/pages/campus-wall/index' };
  },
  search() {
    wx.navigateTo({ url: '/pages/wall-search/index' + (this.data.filter === EXPERIENCE_TAB ? '?community=experience' : '') });
  },
  publish() {
    if (this.data.access !== 'approved') return C.goAccess();
    const filter = this.data.filter;
    const categoryIndex = C.categories.indexOf(filter);
    const query = filter === EXPERIENCE_TAB ? '?community=experience'
      : categoryIndex >= 0 ? '?categoryIndex=' + categoryIndex : '';
    wx.navigateTo({ url: '/pages/wall-publish/index' + query });
  }
});
