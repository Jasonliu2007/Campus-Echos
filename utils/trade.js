const C = require('./campus');

const ORDER_LABELS = {
  awaitingPayment: '待付款', awaitingSeller: '待卖家确认', deliverable: '可领取',
  completed: '已完成', cancelled: '已取消'
};
const DELIVERY_LABELS = { none: '尚未交付', queued: '等待生成', processing: '正在生成', failed: '生成失败', ready: '专属文件已就绪' };
const MATERIAL_LABELS = { draft: '草稿', processing: '正在生成试读', pending: '待人工审核', published: '已上架', rejected: '未通过', offline: '已下架', held: '核查中' };
const MATERIAL_TYPES = ['课程笔记', '知识总结', '学习指南', '经验整理'];
const LEARNING_MODES = ['考前补漏', '系统复习', '基础入门', '进阶拓展'];
const AFTER_SALE_TYPES = ['文件损坏', '缺页', '所列章节缺失', '描述不符', '其他', '技术交付问题', '迟到付款'];

async function call(action, data = {}) {
  let response;
  try { response = await wx.cloud.callFunction({ name: 'xiaopinTrade', data: { ...data, action } }); }
  catch (_) { const error = new Error('资料服务暂时连接不上，输入已保留，请重试。'); error.code = 'NETWORK_ERROR'; throw error; }
  const result = response && response.result;
  if (!result || result.ok !== true) {
    const error = new Error(result && result.message || '资料服务暂不可用，请稍后重试。');
    error.code = result && result.code || 'SERVICE_ERROR';
    throw error;
  }
  return result;
}

function money(cents) { return Number.isSafeInteger(cents) ? (cents === 0 ? '免费' : '¥' + (cents / 100).toFixed(2)) : ''; }
function invalidAccess(error) { return ['ACCESS_DENIED', 'FORBIDDEN', 'UNAUTHENTICATED', 'NOT_FOUND', 'ACCOUNT_BANNED', 'COMMUNITY_BANNED'].includes(error && error.code); }
function material(row) {
  return { ...row, displayPrice: money(row.priceCents), displayTime: C.formatTime(row.createdAt), statusLabel: MATERIAL_LABELS[row.status] || '处理中' };
}
function order(row) {
  return { ...row, displayPrice: money(row.priceCents), displayTime: C.formatTime(row.createdAt),
    statusLabel: ORDER_LABELS[row.status] || '处理中', deliveryLabel: DELIVERY_LABELS[row.deliveryStatus] || '',
    claimTime: C.formatTime(row.firstClaimAt), completedTime: C.formatTime(row.completedAt) };
}

function api(name, options) {
  return new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject }));
}

async function openDocument(url) {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new Error('文件链接无效，请重新申请。');
  let downloaded;
  try { downloaded = await api('downloadFile', { url }); }
  catch (_) { throw new Error('文件下载失败，请检查网络后重新领取。'); }
  if (downloaded.statusCode !== 200 || !downloaded.tempFilePath) throw new Error('文件链接可能已过期，请重新申请。');
  try { await api('openDocument', { filePath: downloaded.tempFilePath, fileType: 'pdf', showMenu: true }); }
  catch (_) { throw new Error('文件暂时无法打开，请重试或在订单中申请技术报修。'); }
  return { opened: true };
}

function readFile(filePath, position, length) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({
    filePath, encoding: 'base64', position, length,
    success: result => resolve(result.data), fail: reject
  }));
}

async function choosePdf() {
  let response;
  try { response = await api('chooseMessageFile', { count: 1, type: 'file', extension: ['pdf'] }); }
  catch (error) { if (/cancel/i.test(error.errMsg || '')) return null; throw new Error('无法选择文件，请重试。'); }
  const file = response.tempFiles && response.tempFiles[0];
  if (!file) return null;
  if (!/\.pdf$/i.test(file.name || '')) throw new Error('首轮只支持未加密PDF，请重新选择。');
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 20 * 1024 * 1024) throw new Error('PDF需小于等于20MiB，且不能是空文件。');
  return { path: file.path, name: file.name, size: file.size };
}

// Every block goes through the authenticated function. Client storage is private.
async function uploadPdf({ materialId, file, requestId, uploadId, onProgress = () => {} }) {
  const upload = uploadId ? await call('getUpload', { uploadId }) : await call('startPdfUpload', { materialId, requestId, name: file.name, size: file.size });
  const key = uploadId || upload.uploadId;
  if (!key) throw new Error('上传会话未建立，请重试。');
  const chunkBytes = upload.chunkBytes || 262144, count = upload.totalChunks || Math.ceil(file.size / chunkBytes);
  const uploaded = new Set(upload.uploadedIndices || []);
  for (let index = 0; index < count; index += 1) {
    if (!uploaded.has(index)) {
      const base64 = await readFile(file.path, index * chunkBytes, Math.min(chunkBytes, file.size - index * chunkBytes));
      await call('uploadPdfChunk', { uploadId: key, index, base64 });
    }
    onProgress({ uploadId: key, done: index + 1, total: count, percent: Math.round((index + 1) / count * 100) });
  }
  return { ...await call('finalizePdfUpload', { uploadId: key }), uploadId: key };
}

async function choosePrivateImage(purpose, orderId, requestId) {
  let response;
  try { response = await api('chooseMedia', { count: 1, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'] }); }
  catch (error) { if (/cancel/i.test(error.errMsg || '')) return null; throw new Error('无法选择图片，请重试。'); }
  const selected = response.tempFiles && response.tempFiles[0];
  if (!selected) return null;
  let filePath = selected.tempFilePath;
  let size = selected.size;
  if (size > 600 * 1024) {
    try {
      const compressed = await api('compressImage', { src: filePath, quality: 65 });
      filePath = compressed.tempFilePath;
      size = (await api('getFileInfo', { filePath })).size;
    } catch (_) { throw new Error('图片压缩失败，输入已保留，请换一张图片重试。'); }
  }
  if (size > 600 * 1024) throw new Error('图片压缩后仍超过600KiB，请裁剪后重试。');
  const base64 = await readFile(filePath, 0, size);
  return call('uploadPrivateImage', { purpose, orderId, requestId, base64 });
}

module.exports = { call, api, money, invalidAccess, material, order, openDocument, choosePdf, uploadPdf, choosePrivateImage,
  MATERIAL_TYPES, LEARNING_MODES, AFTER_SALE_TYPES, ORDER_LABELS, DELIVERY_LABELS, MATERIAL_LABELS };
