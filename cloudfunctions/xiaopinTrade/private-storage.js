'use strict';

// Reserve the provider's final ID before uploading any bytes. Callers persist
// that ID first, so a platform kill cannot leave an untraceable private object.
function createStorage({ cloud, metadata }) {
  return {
    async reserve(path) {
      const response = await metadata(path), fileId = response && response.data && response.data.fileId;
      if (!response || response.code || typeof fileId !== 'string' || !fileId.startsWith('cloud://')) throw new Error('PRIVATE_RESERVATION_FAILED');
      return fileId;
    },
    async put(path, bytes, expectedFileId) {
      if (!expectedFileId) throw new Error('PRIVATE_RESERVATION_REQUIRED');
      const result = await cloud.uploadFile({ cloudPath: path, fileContent: bytes });
      if (result.fileID !== expectedFileId) {
        // A mismatch means this provider contract is not usable. Never publish
        // or return the unexpected object; retain the reservation for cleanup.
        if (result.fileID) await this.remove(result.fileID);
        throw new Error('PRIVATE_RESERVATION_MISMATCH');
      }
      return result.fileID;
    },
    async get(fileId) { return (await cloud.downloadFile({ fileID: fileId })).fileContent; },
    async sign(fileId, maxAge = 600) {
      const row = (await cloud.getTempFileURL({ fileList: [{ fileID: fileId, maxAge }] })).fileList[0];
      if (!row || row.status !== 0 || !row.tempFileURL) throw new Error('PRIVATE_LINK_UNAVAILABLE');
      return row.tempFileURL;
    },
    async remove(fileId) {
      const row = (await cloud.deleteFile({ fileList: [fileId] })).fileList[0];
      if (!row || ![0, -503003].includes(row.status)) throw new Error('PRIVATE_DELETE_FAILED');
    },
  };
}
module.exports = { createStorage };
