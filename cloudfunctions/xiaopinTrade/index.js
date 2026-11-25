'use strict';
const cloud = require('wx-server-sdk');
const cloudbase = require('@cloudbase/node-sdk');
const { createRepository } = require('./repository');
const { createTradeService, APPID } = require('./service');
const { createSellerFeePayment } = require('./seller-fee-payment');
const { createStorage } = require('./private-storage');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const storageApp = cloudbase.init({ env: process.env.TCB_ENV || process.env.SCF_NAMESPACE });
const handle = createTradeService({
  repo: createRepository(cloud.database()),
  // Current platform rules disallow this off-platform paid flow; keep it disabled.
  paidEnabled: false,
  sellerFeePayment: createSellerFeePayment(process.env, APPID),
  moderate: (openid, content) => cloud.openapi.security.msgSecCheck({ version: 2, scene: 3, openid, content }),
  storage: createStorage({ cloud, metadata: path => storageApp.getUploadMetadata({ cloudPath: path }) }),
});
exports.main = event => handle(event, cloud.getWXContext());
