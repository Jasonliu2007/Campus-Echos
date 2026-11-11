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
    showToast() {},
    stopPullDownRefresh() {},
    navigateBack: options => navigation.push({ kind: 'back', options }),
    navigateTo: options => navigation.push({ kind: 'to', options }),
    switchTab: options => switches.push(options),
  };
  const context = vm.createContext({
    wx,
    Page(value) { definition = value; },
    Component(value) { definition = value; },
    getCurrentPages: () => [{}, {}],
    console,
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
      setData(patch) { Object.assign(this.data, patch); },
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
    return { ...instance(definition), ...definition.methods };
  }
  return { wx, state, storage, requests, modals, alerts, navigation, switches, load, page, list, tab };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const input = (key, value) => ({ currentTarget: { dataset: { key } }, detail: { value } });
const event = dataset => ({ currentTarget: { dataset } });

module.exports = { runtime, deferred, tick, input, event };
