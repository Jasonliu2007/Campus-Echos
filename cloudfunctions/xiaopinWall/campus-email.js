'use strict';

const { createHmac, randomInt, randomUUID, timingSafeEqual } = require('node:crypto');
const DOMAIN = 'mail.bnbu.edu.cn';
const EMAIL_PATTERN = /^[a-z0-9_+-]+(?:\.[a-z0-9_+-]+)*@mail\.bnbu\.edu\.cn$/;
const CODE_TTL = 10 * 60_000;
const SEND_COOLDOWN = 60_000;
const SEND_WINDOW = 60 * 60_000;
const MAX_SENDS = 5;
const MAX_ATTEMPTS = 5;

function createCampusEmail({ repo, now, approved, fail, logger, required = false, secret, sendCode }) {
  const available = typeof secret === 'string' && Buffer.byteLength(secret) >= 32 && typeof sendCode === 'function';
  const digest = (...parts) => createHmac('sha256', secret).update(JSON.stringify(parts)).digest('hex');
  const key = (...parts) => digest(...parts).slice(0, 32);
  const verified = member => member?.kind === 'member' && !!member.campusEmailId;
  const assertVerified = member => {
    if (required && !verified(member)) fail('EMAIL_VERIFICATION_REQUIRED', '发帖前请先验证学校邮箱。');
  };

  function requireService() {
    if (!available) fail('EMAIL_UNAVAILABLE', '学校邮箱验证暂不可用，请稍后再试。');
  }

  function normalize(value) {
    const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!EMAIL_PATTERN.test(email) || email.length > 64 + DOMAIN.length + 1) {
      fail('INVALID_EMAIL', '请输入 @mail.bnbu.edu.cn 学校邮箱。');
    }
    return email;
  }

  function nextSend(record, at) {
    if (record?.lastSentAt + SEND_COOLDOWN > at) fail('EMAIL_RATE_LIMIT', '请等一分钟再获取验证码。');
    const currentWindow = record?.windowStart + SEND_WINDOW > at;
    const sent = currentWindow ? record.sent : 0;
    if (sent >= MAX_SENDS) fail('EMAIL_RATE_LIMIT', '验证码发送过于频繁，请稍后再试。');
    return { windowStart: currentWindow ? record.windowStart : at, sent: sent + 1, lastSentAt: at };
  }

  async function send(event, memberId) {
    requireService();
    const email = normalize(event.email);
    const emailId = digest('email', email);
    const challengeId = randomUUID();
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const codeDigest = digest('code', memberId, emailId, challengeId, code);
    const accountKey = key('challenge', memberId);
    const targetKey = key('target', emailId);
    const alreadyVerified = await repo.transaction(async tx => {
      const member = approved(await tx.get('members', memberId));
      if (verified(member)) return true;
      const previous = await tx.get('campusEmail', accountKey);
      const target = await tx.get('campusEmail', targetKey);
      const at = now();
      const accountRate = nextSend(previous, at);
      const targetRate = nextSend(target, at);
      await tx.set('campusEmail', accountKey, {
        ...accountRate, emailId, challengeId, codeDigest, expiresAt: at + CODE_TTL, attempts: 0
      });
      await tx.set('campusEmail', targetKey, targetRate);
      return false;
    });
    if (alreadyVerified) return { campusEmailVerified: true };

    try {
      await sendCode(email, code);
    } catch {
      logger.error('campus_email_delivery_failed');
      await repo.transaction(async tx => {
        const current = await tx.get('campusEmail', accountKey);
        if (current?.challengeId === challengeId) {
          await tx.set('campusEmail', accountKey, {
            windowStart: current.windowStart, sent: current.sent, lastSentAt: current.lastSentAt
          });
        }
      });
      fail('EMAIL_SEND_FAILED', '验证码暂时无法发送，请稍后重试。');
    }
    return { resendAfter: SEND_COOLDOWN / 1000 };
  }

  async function verify(event, memberId) {
    requireService();
    const emailId = digest('email', normalize(event.email));
    const code = typeof event.code === 'string' ? event.code.trim() : '';
    if (!/^\d{6}$/.test(code)) fail('INVALID_EMAIL_CODE', '请输入 6 位数字验证码。');
    const accountKey = key('challenge', memberId);
    const claimKey = key('claim', emailId);
    const error = await repo.transaction(async tx => {
      const member = approved(await tx.get('members', memberId));
      if (verified(member)) return member.campusEmailId === emailId ? '' : 'EMAIL_ALREADY_BOUND';
      const challenge = await tx.get('campusEmail', accountKey);
      if (!challenge?.codeDigest || challenge.expiresAt <= now()) return 'EMAIL_CODE_EXPIRED';
      if (challenge.attempts >= MAX_ATTEMPTS) return 'EMAIL_CODE_LOCKED';
      const value = digest('code', memberId, emailId, challenge.challengeId, code);
      const matches = timingSafeEqual(Buffer.from(challenge.codeDigest, 'hex'), Buffer.from(value, 'hex'));
      if (!matches) {
        await tx.set('campusEmail', accountKey, { ...challenge, attempts: challenge.attempts + 1 });
        return 'INVALID_EMAIL_CODE';
      }
      const claim = await tx.get('campusEmail', claimKey);
      if (claim && claim.memberId !== memberId) return 'EMAIL_IN_USE';
      const at = now();
      await tx.set('campusEmail', claimKey, { memberId, verifiedAt: at });
      await tx.set('members', memberId, { ...member, campusEmailId: emailId, campusEmailVerifiedAt: at });
      await tx.set('campusEmail', accountKey, {
        windowStart: challenge.windowStart, sent: challenge.sent, lastSentAt: challenge.lastSentAt
      });
      return '';
    });
    const messages = {
      EMAIL_ALREADY_BOUND: '当前微信账号已绑定学校邮箱。',
      EMAIL_CODE_EXPIRED: '验证码已失效，请重新获取。',
      EMAIL_CODE_LOCKED: '验证码错误次数过多，请重新获取。',
      INVALID_EMAIL_CODE: '验证码不正确，请核对邮箱和验证码。',
      EMAIL_IN_USE: '该邮箱已绑定其他微信账号。'
    };
    if (error) fail(error, messages[error]);
    return { campusEmailVerified: true };
  }

  return { required, available, verified, assertVerified, send, verify };
}

module.exports = { createCampusEmail };
