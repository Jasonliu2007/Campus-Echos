'use strict';
const { Worker } = require('worker_threads');
const path = require('path');
function runIsolated(task, bytes, { timeoutMs = 15000, memoryMb = 192 } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'pdf-thread.js'), { workerData: { task, bytes }, resourceLimits: { maxOldGenerationSizeMb: memoryMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => { const error = new Error('PDF_TIME_LIMIT'); error.code = 'PDF_TIME_LIMIT'; finish(error); }, timeoutMs);
    worker.on('message', value => {
      if (!value.ok) { const error = new Error(value.code); error.code = value.code; finish(error); }
      else { if (value.result.bytes) value.result.bytes = Buffer.from(value.result.bytes); finish(null, value.result); }
    });
    worker.on('error', () => { const error = new Error('PDF_MEMORY_OR_RUNTIME_LIMIT'); error.code = error.message; finish(error); });
    worker.on('exit', code => { if (!settled) { const error = new Error(`PDF_WORKER_EXIT_${code}`); error.code = 'PDF_WORKER_EXIT'; finish(error); } });
  });
}
module.exports = { runIsolated };
