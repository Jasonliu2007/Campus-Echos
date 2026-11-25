'use strict';
const { parentPort, workerData } = require('worker_threads');
const { processTask } = require('./pdf-task');
processTask(workerData.task, Buffer.from(workerData.bytes)).then(result => parentPort.postMessage({ ok: true, result })).catch(error => parentPort.postMessage({ ok: false, code: error.code || 'PDF_PROCESSING_FAILED' }));
