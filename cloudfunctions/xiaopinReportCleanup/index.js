'use strict';
const cloud = require('wx-server-sdk');
const { createRepository } = require('./repository');
const { createCleanupHandler } = require('./handler');
const { createMediaDelete } = require('./storage-delete');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = createCleanupHandler({ repo: createRepository(cloud.database()), context: () => cloud.getWXContext(), storage: { delete: createMediaDelete(cloud) } });
