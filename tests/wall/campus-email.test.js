'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./forum-fixture');

const ADDRESS = 'tester@mail.bnbu.edu.cn';
const POST = { requestId: 'campus-email-01', category: '校园生活墙', title: '校园自习', content: '图书馆自习交流。' };
const setup = () => {
  const mail = [];
  const instance = fixture({ campusEmailConfig: {
    required: true, secret: 'local-test-key-with-32-bytes-minimum',
    sendCode: async (email, code) => mail.push({ email, code })
  } });
  return { ...instance, mail, send: (email = ADDRESS, who) => instance.call('campusEmailSend', { email }, who),
    verify: (code, email = ADDRESS, who) => instance.call('campusEmailVerify', { email, code }, who) };
};

test('学校邮件验证由服务端强制，实名和匿名同样检查；公开响应不返回绑定标识', async () => {
  const f = setup();
  for (const isAnonymous of [false, true]) {
    const blocked = await f.call('publish', { ...POST, isAnonymous, campusEmailVerified: true });
    assert.equal(blocked.code, 'EMAIL_VERIFICATION_REQUIRED');
  }
  assert.equal((await f.send(' TESTER@MAIL.BNBU.EDU.CN ')).ok, true);
  assert.equal(f.mail[0].email, ADDRESS);
  assert.equal((await f.verify(f.mail[0].code)).campusEmailVerified, true);
  assert.equal((await f.verify(f.mail[0].code)).ok, true);
  const session = await f.call('session');
  assert.equal(session.campusEmailVerified, true);
  assert.equal('campusEmailId' in session.member, false);
  const normal = await f.call('publish', POST);
  assert.equal(normal.status, 'published');
  const anonymous = await f.call('publish', { ...POST, isAnonymous: true, requestId: 'campus-email-02' });
  assert.equal(anonymous.status, 'pending');
  const post = (await f.call('getPost', { postId: normal.postId }, 'other')).post;
  assert.equal(post.authorName, '真实昵称-author');
  assert.equal('campusEmailId' in post, false);
  const records = JSON.stringify([...f.repo.tables.campusEmail.values()]);
  assert.equal(records.includes(ADDRESS), false);
  assert.equal([...f.repo.tables.campusEmail.values()].some(r => r.code === f.mail[0].code || r.codeDigest), false);
});

test('严格匹配域名，验证码限定邮箱、微信账号和时效，同一邮箱只能绑定一个账号', async () => {
  const f = setup();
  assert.equal((await f.send(ADDRESS + '.example')).code, 'INVALID_EMAIL');
  assert.equal((await f.send('tester@bnbu.edu.cn')).code, 'INVALID_EMAIL');
  assert.equal((await f.send()).ok, true);
  const code = f.mail[0].code;
  assert.equal((await f.send(ADDRESS, 'other')).code, 'EMAIL_RATE_LIMIT');
  assert.equal((await f.verify(code, ADDRESS, 'other')).code, 'EMAIL_CODE_EXPIRED');
  assert.equal((await f.verify(code, 'wrong@mail.bnbu.edu.cn')).code, 'INVALID_EMAIL_CODE');
  assert.equal((await f.verify(code)).ok, true);
  f.advance(60_000);
  await f.send(ADDRESS, 'other');
  assert.equal((await f.verify(f.mail[1].code, ADDRESS, 'other')).code, 'EMAIL_IN_USE');
  f.advance(10 * 60_000);
  assert.equal((await f.verify(f.mail[1].code, ADDRESS, 'other')).code, 'EMAIL_CODE_EXPIRED');
});

test('错误次数持久计数，下次发送前限制频率，未配置发送服务时不能完成验证', async () => {
  const f = setup();
  await f.send();
  const wrong = f.mail[0].code === '000000' ? '111111' : '000000';
  for (let n = 0; n < 5; n++) assert.equal((await f.verify(wrong)).code, 'INVALID_EMAIL_CODE');
  assert.equal((await f.verify(f.mail[0].code)).code, 'EMAIL_CODE_LOCKED');
  assert.equal((await f.send('another@mail.bnbu.edu.cn')).code, 'EMAIL_RATE_LIMIT');
  const missing = fixture({ campusEmailConfig: { required: true } });
  assert.equal((await missing.call('campusEmailSend', { email: ADDRESS })).code, 'EMAIL_UNAVAILABLE');
  assert.equal((await missing.call('publish', POST)).code, 'EMAIL_VERIFICATION_REQUIRED');
});
