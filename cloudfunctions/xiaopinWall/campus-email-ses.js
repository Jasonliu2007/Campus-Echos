'use strict';

const { createHash, createHmac } = require('node:crypto');
const { request } = require('node:https');

const HOST = 'ses.tencentcloudapi.com';
const CONTENT_TYPE = 'application/json; charset=utf-8';
const SIGNED_HEADERS = 'content-type;host';
const ALGORITHM = 'TC3-HMAC-SHA256';

function createSesSender(env) {
  const secretId = env.CAMPUS_SES_SECRET_ID;
  const secretKey = env.CAMPUS_SES_SECRET_KEY;
  const sender = env.CAMPUS_SES_FROM;
  const region = env.CAMPUS_SES_REGION;
  const templateId = Number(env.CAMPUS_SES_TEMPLATE_ID);
  if (!secretId || !secretKey || !sender || !region || !Number.isSafeInteger(templateId) || templateId < 1) return undefined;

  return async (email, code) => {
    const payload = JSON.stringify({
      FromEmailAddress: sender,
      Destination: [email],
      Subject: '校园回声邮箱验证码',
      Template: { TemplateID: templateId, TemplateData: JSON.stringify({ code }) }
    });
    const sha = value => createHash('sha256').update(value).digest('hex');
    const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
    const timestamp = Math.floor(Date.now() / 1000);
    const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
    const scope = `${date}/ses/tc3_request`;
    const canonicalHeaders = `content-type:${CONTENT_TYPE}\nhost:${HOST}\n`;
    const canonical = ['POST', '/', '', canonicalHeaders, SIGNED_HEADERS, sha(payload)].join('\n');
    const signatureKey = hmac(hmac(hmac('TC3' + secretKey, date), 'ses'), 'tc3_request');
    const signature = hmac(signatureKey, [ALGORITHM, timestamp, scope, sha(canonical)].join('\n')).toString('hex');

    await new Promise((resolve, reject) => {
      const failed = () => reject(new Error('SES_DELIVERY_FAILED'));
      const req = request({
        hostname: HOST, path: '/', method: 'POST',
        headers: {
          Authorization: `${ALGORITHM} Credential=${secretId}/${scope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`,
          'Content-Type': CONTENT_TYPE, 'Content-Length': Buffer.byteLength(payload),
          'X-TC-Action': 'SendEmail', 'X-TC-Version': '2020-10-02',
          'X-TC-Region': region, 'X-TC-Timestamp': timestamp
        }
      }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('error', failed);
        res.on('data', chunk => {
          body += chunk;
          if (body.length > 16_384) req.destroy(new Error('SES_RESPONSE_TOO_LARGE'));
        });
        res.on('end', () => {
          let result;
          try { result = JSON.parse(body).Response; } catch { return failed(); }
          if (res.statusCode !== 200 || !result?.MessageId || result.Error) return failed();
          resolve();
        });
      });
      req.setTimeout(4500, () => req.destroy(new Error('SES_TIMEOUT')));
      req.on('error', failed);
      req.end(payload);
    });
  };
}

module.exports = { createSesSender };
