const C = require('./campus');
const LABELS = { local: '待上传', uploading: '上传中', checking: '微信审核中', approved: '审核通过', review: '需复核，请更换图片', rejected: '未通过，请更换图片', failed: '上传失败，可重试', deleted: '图片已清除' };
function api(name, options) { return new Promise((resolve, reject) => wx[name]({ ...options, success: resolve, fail: reject })); }
async function choose(count, sourceType = ['album', 'camera']) {
  let result;
  try { result = await api('chooseMedia', { count, mediaType: ['image'], sizeType: ['compressed'], sourceType }); }
  catch (error) { if (/cancel/i.test(error.errMsg || '')) return []; throw new Error('暂时无法选择图片，请重试，正文已保留。'); }
  const rows = [];
  for (const image of result.tempFiles || []) {
    let path = image.tempFilePath, bytes = image.size;
    let error = '';
    try {
      if (bytes > 600 * 1024) {
        const compressed = await api('compressImage', { src: path, quality: 65 }); path = compressed.tempFilePath;
        bytes = (await api('getFileInfo', { filePath: path })).size;
      }
      if (!Number.isSafeInteger(bytes) || bytes <= 0) error = '图片大小无法核对，请重新选择。';
      else if (bytes > 600 * 1024) error = '压缩后仍超过600KiB，请裁剪后重选。';
    } catch (_) { error = '这张图片压缩失败，请裁剪后重新选择；其他图片与正文已保留。'; }
    rows.push({ key: C.requestId(), requestId: C.requestId(), path, bytes, status: error ? 'failed' : 'local', error });
  }
  return rows;
}
function base64(path) { return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath: path, encoding: 'base64', success: r => resolve(r.data), fail: () => reject(new Error('本机图片已失效，请重选；正文已保留。')) })); }
async function upload(row) {
  if (row.bytes > 600 * 1024) throw new Error('压缩后仍超过600KiB，请裁剪后重新选择。');
  return C.callWall('uploadMedia', { requestId: row.requestId, base64: await base64(row.path) });
}
async function hydrate(post, reportId) {
  const rows = [];
  for (const mediaId of post.mediaIds || []) {
    try { const row = await C.callWall('getMedia', { mediaId, postId: post._id, ...(reportId ? { reportId } : {}) }); rows.push({ ...row, key: mediaId, label: LABELS[row.status] || '暂不可用' }); }
    catch (error) { rows.push({ mediaId, key: mediaId, status: 'failed', label: error.message }); }
  }
  return rows;
}
function present(row) { return { ...row, label: LABELS[row.status] || '等待确认' }; }
module.exports = { api, choose, base64, upload, hydrate, present, LABELS };
