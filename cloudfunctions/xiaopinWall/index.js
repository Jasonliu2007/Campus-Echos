'use strict';

const cloud = require('wx-server-sdk');
const cloudbase = require('@cloudbase/node-sdk');
const { createStorage } = require('./private-storage');
const { createRepository } = require('./repository');
const { createWallService } = require('./service');
const { createSesSender } = require('./campus-email-ses');
const { createEntry } = require('./entry');

// Private server deployment configuration is optional and never read from a request.
let deploymentConfig = {};
try { deploymentConfig = require('./deployment-config.json'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes('deployment-config.json')) throw error;
}
const bootstrapIdentity = process.env.BOOTSTRAP_ADMIN_OPENID || deploymentConfig.bootstrapAdminOpenid || '';
if (typeof bootstrapIdentity !== 'string' || bootstrapIdentity.length > 128) throw new Error('Invalid server bootstrap configuration');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const storageApp = cloudbase.init({ env: process.env.TCB_ENV || process.env.SCF_NAMESPACE });
const handle = createWallService({
  repo: createRepository(cloud.database()),
  bootstrapAdminOpenid: bootstrapIdentity,
  campusEmailConfig: {
    required: process.env.CAMPUS_EMAIL_GATE === 'true',
    secret: process.env.CAMPUS_OTP_SECRET,
    sendCode: createSesSender(process.env),
  },
  storage: createStorage({ cloud, metadata: path => storageApp.getUploadMetadata({ cloudPath: path }) }),
  mediaCheck: (openid, mediaUrl) => cloud.openapi.security.mediaCheckAsync({ version: 2, scene: 2, openid, mediaUrl, mediaType: 2 }),
  moderate: (openid, content) => cloud.openapi.security.msgSecCheck({ version: 2, scene: 3, openid, content }),
});

exports.main = createEntry({
  service: handle,
  context: () => cloud.getWXContext(),
  appid: 'wxa16f2146b48a2c2e',
  environment: 'cloud1-d7gueyve330686b55',
  callbackSources: Array.isArray(deploymentConfig.mediaCallbackSources) ? deploymentConfig.mediaCallbackSources : [],
});
