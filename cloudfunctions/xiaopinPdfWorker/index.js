'use strict';
const cloud = require('wx-server-sdk');
const cloudbase = require('@cloudbase/node-sdk');
const { createRepository } = require('./repository');
const { createWorker } = require('./worker');
const { runIsolated } = require('./isolation');
const { createStorage } = require('./private-storage');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const storageApp = cloudbase.init({ env: process.env.TCB_ENV || process.env.SCF_NAMESPACE });
exports.main = createWorker({
  repo: createRepository(cloud.database()), context: () => cloud.getWXContext(), runPdf: runIsolated,
  storage: createStorage({ cloud, metadata: path => storageApp.getUploadMetadata({ cloudPath: path }) }),
});
