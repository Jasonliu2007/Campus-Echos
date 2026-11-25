const test = require('node:test');
const assert = require('node:assert/strict');
const { runtime, tick } = require('./runtime');

test('trade transport preserves server rejection and never invents a paid success', async () => {
  const r = runtime(), trade = r.load('utils/trade.js');
  const pending = trade.call('createOrder', { materialId: 'sample', requestId: 'same-request' });
  r.requests[0].resolve({ ok: false, code: 'PAID_DISABLED', message: '付费尚未启用' });
  await assert.rejects(pending, error => error.code === 'PAID_DISABLED' && error.message === '付费尚未启用');
  assert.equal(r.requests.length, 1);
});

test('PDF open only succeeds after download status and native reader both succeed', async () => {
  const r = runtime(), trade = r.load('utils/trade.js');
  let opened = 0;
  r.wx.downloadFile = options => options.success({ statusCode: 403, tempFilePath: '/private/temp.pdf' });
  r.wx.openDocument = options => { opened += 1; options.success({}); };
  await assert.rejects(trade.openDocument('https://example.test/expired'), /过期/);
  assert.equal(opened, 0);
  r.wx.downloadFile = options => options.success({ statusCode: 200, tempFilePath: '/private/temp.pdf' });
  r.wx.openDocument = options => { opened += 1; assert.equal(options.fileType, 'pdf'); options.fail({ errMsg: 'open failed' }); };
  await assert.rejects(trade.openDocument('https://example.test/pdf'), /技术报修/);
  r.wx.openDocument = options => { opened += 1; options.success({}); };
  assert.equal((await trade.openDocument('https://example.test/pdf')).opened, true);
  assert.equal(opened, 2);
});

test('PDF selection rejects oversize files before creating any cloud upload', async () => {
  const r = runtime(), trade = r.load('utils/trade.js');
  r.wx.chooseMessageFile = options => options.success({ tempFiles: [{ name: 'sample.pdf', size: 20 * 1024 * 1024 + 1, path: '/tmp/a' }] });
  await assert.rejects(trade.choosePdf(), /20MiB/);
  assert.equal(r.requests.length, 0);
  r.wx.chooseMessageFile = options => options.fail({ errMsg: 'chooseMessageFile:fail cancel' });
  assert.equal(await trade.choosePdf(), null);
});

test('resumed PDF upload skips completed blocks and finalizes only after every missing block', async () => {
  const r = runtime(), trade = r.load('utils/trade.js'), positions = [], progress = [];
  r.wx.getFileSystemManager = () => ({ readFile(options) { positions.push([options.position, options.length]); options.success({ data: 'Yg==' }); } });
  const pending = trade.uploadPdf({ materialId: 'm', file: { path: '/tmp/a', size: 262145 }, uploadId: 'u', onProgress: value => progress.push(value) });
  r.requests[0].resolve({ uploadId: 'u', totalChunks: 2, uploadedIndices: [0] });
  await tick();
  assert.equal(r.requests[1].data.action, 'uploadPdfChunk');
  assert.equal(r.requests[1].data.index, 1);
  assert.deepEqual(positions, [[262144, 1]]);
  r.requests[1].resolve({ status: 'ready' });
  await tick();
  assert.equal(r.requests[2].data.action, 'finalizePdfUpload');
  r.requests[2].resolve({ status: 'queued', versionId: 'v' });
  assert.equal((await pending).versionId, 'v');
  assert.equal(progress.at(-1).percent, 100);
});

test('failed PDF block never finalizes upload and can be retried with the same session', async () => {
  const r = runtime(), trade = r.load('utils/trade.js');
  r.wx.getFileSystemManager = () => ({ readFile(options) { options.success({ data: 'Yg==' }); } });
  const pending = trade.uploadPdf({ materialId: 'm', file: { path: '/tmp/a', size: 1 }, uploadId: 'u' });
  r.requests[0].resolve({ uploadId: 'u', totalChunks: 1, uploadedIndices: [] });
  await tick();
  r.requests[1].reject(new Error('network'));
  await assert.rejects(pending, error => error.code === 'NETWORK_ERROR');
  assert.equal(r.requests.length, 2);
});
