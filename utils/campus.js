const categories = ['失物招领', '吐槽树洞', '学习互助', '闲置转让'];
const statusLabels = {
  published: '已发布',
  pending: '待审核',
  rejected: '未通过',
  hidden: '已下架',
  deleted: '已删除'
};
const accessLabels = {
  approved: '内测成员',
  pending: '申请审核中',
  rejected: '申请未通过',
  revoked: '资格已撤销',
  none: '尚未开通内测'
};

async function callWall(action, data = {}) {
  let response;
  try {
    response = await wx.cloud.callFunction({
      name: 'xiaopinWall',
      data: {
        ...data,
        action
      }
    });
  } catch (cause) {
    const error = new Error('暂时连接不上校园回声，请检查网络后重试。');
    error.code = 'NETWORK_ERROR';
    throw error;
  }
  const result = response && response.result;
  if (!result || result.ok !== true) {
    const error = new Error(result && result.message ? result.message : '校园回声暂不可用，请稍后重试。');
    error.code = result && result.code ? result.code : 'SERVICE_ERROR';
    throw error;
  }
  return result;
}

function getReducedMotion() {
  try {
    return wx.getStorageSync('campusReducedMotion') === true;
  } catch (error) {
    return false;
  }
}

function setReducedMotion(value) {
  wx.setStorageSync('campusReducedMotion', value === true);
}

function getReducedTransparency() {
  try {
    return wx.getStorageSync('campusReducedTransparency') === true;
  } catch (error) {
    return false;
  }
}

function setReducedTransparency(value) {
  wx.setStorageSync('campusReducedTransparency', value === true);
}

function syncTab(page, route) {
  if (typeof page.getTabBar === 'function' && page.getTabBar()) page.getTabBar().setData({
    active: route,
    reducedMotion: getReducedMotion(),
    reducedTransparency: getReducedTransparency()
  });
}

function formatTime(value) {
  const date = new Date(value && value.$date ? value.$date : value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatPost(post) {
  return {
    ...post,
    displayTime: formatTime(post.createdAt),
    statusLabel: statusLabels[post.status] || '处理中'
  };
}

function confirm(options) {
  return new Promise((resolve) => wx.showModal({
    confirmColor: '#0878BD',
    cancelText: '取消',
    ...options,
    success: (res) => resolve(res.confirm),
    fail: () => resolve(false)
  }));
}

function showUnavailable(eventOrLabel) {
  const label = typeof eventOrLabel === 'string' ? eventOrLabel : (eventOrLabel.currentTarget.dataset.label || '此功能');
  return wx.showModal({
    title: `${label}尚未开放`,
    content: '当前页面为演示内容。校园墙文字发帖正在封闭内测，其他功能将分批开放。',
    showCancel: false,
    confirmText: '知道了',
    confirmColor: '#0878BD'
  });
}

function goAccess() {
  wx.navigateTo({
    url: '/pages/access/index'
  });
}

function goBack() {
  if (getCurrentPages().length > 1) wx.navigateBack();
  else wx.switchTab({
    url: '/pages/campus-wall/index'
  });
}

function requestId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

module.exports = {
  categories,
  statusLabels,
  accessLabels,
  callWall,
  getReducedMotion,
  setReducedMotion,
  getReducedTransparency,
  setReducedTransparency,
  syncTab,
  formatTime,
  formatPost,
  confirm,
  showUnavailable,
  goAccess,
  goBack,
  requestId
};
