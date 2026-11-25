const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Isolate every test's mini-program globals and module cache. No cloud request is sent.
function runtime() {
  const storage = new Map();
  const requests = [];
  const modals = [];
  const alerts = [];
  const navigation = [];
  const switches = [];
  const toasts = [];
  let now = 0, timerId = 0;
  const wallClock = Date.now();
  class RuntimeDate extends Date {
    static now() { return wallClock + now; }
  }
  const timers = new Map();
  const schedule = (fn, delay = 0) => { const id = ++timerId; timers.set(id, { at: now + delay, fn }); return id; };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    now = end;
  }
  let definition;
  const state = { storageFails: false, alertsDisabled: 0 };
  const wx = {
    cloud: {
      callFunction({ data }) {
        const pending = deferred();
        requests.push({
          data,
          resolve(result) { pending.resolve({ result: { ok: true, ...result } }); },
          reject: pending.reject,
        });
        return pending.promise;
      },
    },
    getStorageSync: key => storage.get(key),
    setStorageSync(key, value) {
      if (state.storageFails) throw new Error('storage quota exceeded');
      storage.set(key, structuredClone(value));
    },
    removeStorageSync: key => storage.delete(key),
    enableAlertBeforeUnload: options => alerts.push(options.message),
    disableAlertBeforeUnload() { state.alertsDisabled += 1; },
    showModal: options => modals.push(options),
    showToast(options) { toasts.push(options); },
    stopPullDownRefresh() {},
    navigateBack: options => navigation.push({ kind: 'back', options }),
    navigateTo: options => navigation.push({ kind: 'to', options }),
    switchTab: options => switches.push(options),
  };
  const context = vm.createContext({
    wx,
    Page(value) { definition = value; },
    Component(value) { definition = value; },
    getCurrentPages: () => state.pages || [{}, {}],
    console,
    Date: RuntimeDate,
    setTimeout: schedule,
    clearTimeout: id => timers.delete(id),
  });
  const cache = new Map();
  function load(relative) {
    const file = path.resolve(ROOT, relative);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const source = fs.readFileSync(file, 'utf8');
    const wrapper = vm.runInContext(`(function(require,module,exports){\n${source}\n})`, context, { filename: file });
    wrapper(name => {
      if (!name.startsWith('.')) throw new Error(`Unexpected runtime dependency: ${name}`);
      let dependency = path.resolve(path.dirname(file), name);
      if (!path.extname(dependency)) dependency += '.js';
      return load(dependency);
    }, module, module.exports);
    return module.exports;
  }
  function instance(value) {
    return {
      ...value,
      data: structuredClone(value.data),
      setData(patch, done) { Object.assign(this.data, patch); if (done) done(); },
    };
  }
  function page(route) {
    load(`pages/${route}.js`);
    return instance(definition);
  }
  function list(options = {}) {
    return instance(load('utils/wall-list.js').makeList(options));
  }
  function tab() {
    load('custom-tab-bar/index.js');
    const bar = { ...instance(definition), ...definition.methods };
    bar.syncRoute('pages/campus-wall/index');
    return bar;
  }
  return { wx, state, storage, requests, modals, alerts, navigation, switches, toasts, advance, now: () => RuntimeDate.now(), load, page, list, tab };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const input = (key, value) => ({ currentTarget: { dataset: { key } }, detail: { value } });
const event = dataset => ({ currentTarget: { dataset } });

module.exports = { runtime, deferred, tick, input, event };
