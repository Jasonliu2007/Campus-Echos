'use strict';

const https = require('https');
const { createHmac } = require('crypto');

function hmac(key, body) {
  return createHmac('sha256', key).update(body).digest('hex');
}

function request(url, data) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data);
    const req = https.request(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, res => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        response += chunk;
        if (response.length > 65536) req.destroy(new Error('Wechat response too large'));
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error('Wechat payment endpoint unavailable');
          const parsed = JSON.parse(response);
          if (parsed.errcode) throw new Error('Wechat payment request failed');
          resolve(parsed);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('Wechat payment request timed out')));
    req.end(body);
  });
}

function createSellerFeePayment(env, appid, send = request) {
  if (env.SELLER_FEE_PAYMENT_ENABLED !== 'true' || !env.SELLER_FEE_OFFER_ID || !env.SELLER_FEE_APP_KEY || !env.SELLER_FEE_APP_SECRET) return null;
  let products;
  try { products = new Map(Object.entries(JSON.parse(env.SELLER_FEE_PRODUCTS))); } catch (_) { return null; }
  if (!products.size || [...products].some(([cents, id]) => !/^[1-9]\d{0,7}$/.test(cents) || typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id))) return null;
  const api = path => new URL(path, 'https://api.weixin.qq.com');
  return {
    product: feeCents => products.get(String(feeCents)),
    async checkout(order, code, openid) {
      const url = api('/sns/jscode2session');
      url.search = new URLSearchParams({ appid, secret: env.SELLER_FEE_APP_SECRET, js_code: code, grant_type: 'authorization_code' }).toString();
      const session = await send(url);
      if (session.openid !== openid || typeof session.session_key !== 'string' || !session.session_key) throw new Error('Wechat identity mismatch');
      const signData = JSON.stringify({ offerId: env.SELLER_FEE_OFFER_ID, buyQuantity: 1, env: 0, currencyType: 'CNY', productId: order.productId, goodsPrice: order.feeCents, outTradeNo: order._id, attach: order._id });
      return { signData, mode: 'short_series_goods', paySig: hmac(env.SELLER_FEE_APP_KEY, 'requestVirtualPayment&' + signData), signature: hmac(session.session_key, signData) };
    },
    async query(orderId, openid) {
      const { access_token: token } = await send(api('/cgi-bin/stable_token'), {
        grant_type: 'client_credential', appid, secret: env.SELLER_FEE_APP_SECRET, force_refresh: false,
      });
      if (typeof token !== 'string' || !token) throw new Error('Wechat token unavailable');
      const data = { openid, env: 0, order_id: orderId };
      const path = '/xpay/query_order';
      const url = api(path);
      url.search = new URLSearchParams({ access_token: token, pay_sig: hmac(env.SELLER_FEE_APP_KEY, path + '&' + JSON.stringify(data)) }).toString();
      const result = await send(url, data);
      if (result.order?.order_id !== orderId) throw new Error('Wechat order mismatch');
      return result.order;
    },
  };
}

module.exports = { createSellerFeePayment };
