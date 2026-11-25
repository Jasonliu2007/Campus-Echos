const { api, base64 } = require('./forum-media');
const MAX_BYTES = 500 * 1000;

async function chooseAttachment() {
  let result;
  try {
    result = await api('chooseMedia', { count: 1, mediaType: ['image'], sizeType: ['original', 'compressed'], sourceType: ['album', 'camera'] });
  } catch (error) {
    if (/cancel/i.test(error.errMsg || '')) return null;
    throw error;
  }
  const image = result.tempFiles?.[0];
  if (!image) return null;
  if (image.size > 0 && image.size <= MAX_BYTES) return image.tempFilePath;
  for (const [width, quality] of [[1600, 75], [1200, 60], [800, 50], [480, 40]]) {
    const compressed = await api('compressImage', { src: image.tempFilePath, compressedWidth: width, quality });
    const info = await api('getFileInfo', { filePath: compressed.tempFilePath });
    if (info.size > 0 && info.size <= MAX_BYTES) return compressed.tempFilePath;
  }
  throw new Error('压缩后仍超过 500 KB，请换一张图片。');
}

module.exports = { chooseAttachment, base64 };
