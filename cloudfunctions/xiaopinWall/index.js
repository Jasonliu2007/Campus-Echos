'use strict';

const cloud = require('wx-server-sdk');
const { createRepository } = require('./repository');
const { createWallService } = require('./service');

// Private server deployment configuration is optional and never read from a request.
let deploymentConfig = {};
try { deploymentConfig = require('./deployment-config.json'); }
catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || !String(error.message).includes('deployment-config.json')) throw error;
}
const bootstrapIdentity = process.env.BOOTSTRAP_ADMIN_OPENID || deploymentConfig.bootstrapAdminOpenid || '';
if (typeof bootstrapIdentity !== 'string' || bootstrapIdentity.length > 128) throw new Error('Invalid server bootstrap configuration');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const handle = createWallService({
  repo: createRepository(cloud.database()),
  bootstrapAdminOpenid: bootstrapIdentity,
  moderate: (openid, content) => cloud.openapi.security.msgSecCheck({ version: 2, scene: 3, openid, content }),
});

exports.main = (event) => handle(event, cloud.getWXContext());
