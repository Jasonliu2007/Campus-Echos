'use strict';

// A previous run may have removed the file before its database commit failed.
// Missing files count as removed; permission, transport and partial responses do not.
function createMediaDelete(cloud) {
  return async function deleteMedia(fileIds) {
    const expected = new Set(fileIds);
    if (expected.size !== fileIds.length) throw new Error('Duplicate media deletion request');
    if (!fileIds.length) return;
    const result = await cloud.deleteFile({ fileList: fileIds });
    const rows = result && result.fileList;
    const returned = new Set(rows && rows.map(row => row.fileID));
    if (!Array.isArray(rows) || rows.length !== fileIds.length || returned.size !== expected.size ||
        rows.some(row => !expected.has(row.fileID) || ![0, -503003].includes(row.status))) {
      throw new Error('Private media deletion incomplete');
    }
  };
}
module.exports = { createMediaDelete };
