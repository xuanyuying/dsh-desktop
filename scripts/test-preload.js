/**
 * preload.js 逻辑测试：mock electron 模块 + 最小 DOM，验证浮层渲染。
 * 用法: node scripts/test-preload.js
 */
'use strict';

// ---- Mock Electron ----
const ipcListeners = {};
let exposed = null;
const mockElectron = {
  contextBridge: {
    exposeInMainWorld(key, val) {
      exposed = { key, val };
    },
  },
  ipcRenderer: {
    on(channel, cb) {
      ipcListeners[channel] = cb;
    },
    invoke: (channel) => {
      if (channel === 'balance:refresh') return Promise.resolve();
      return Promise.resolve({});
    },
  },
};

const Module = require('node:module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return mockElectron;
  return origLoad.apply(this, arguments);
};

// ---- 最小 DOM ----
const elements = new Map();
function makeElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    _id: '',
    style: {},
    children: [],
    textContent: '',
    _innerHTML: '',
    listeners: {},
    ownerDocument: global.document,
    set id(v) {
      this._id = v;
      if (v) elements.set(v, this);
    },
    get id() {
      return this._id;
    },
    set innerHTML(v) {
      this._innerHTML = v;
      // 解析 HTML 中的 id="..." 子元素并注册，便于 getElementById
      const idRe = /id="([^"]+)"/g;
      let m;
      while ((m = idRe.exec(v))) {
        const child = makeElement('span');
        child.id = m[1];
        this.children.push(child);
      }
      // 提取纯文本（无标签）
      const textMatch = v.replace(/<[^>]+>/g, '');
      if (textMatch) this.textContent = textMatch;
    },
    get innerHTML() {
      return this._innerHTML;
    },
    appendChild(child) {
      this.children.push(child);
      if (child.id) elements.set(child.id, child);
    },
    addEventListener(evt, fn) {
      this.listeners[evt] = fn;
    },
    setAttribute(k, v) {
      if (k === 'id') this.id = v;
    },
  };
  return el;
}
global.document = {
  readyState: 'complete',
  documentElement: makeElement('html'),
  getElementById(id) {
    return elements.get(id) || null;
  },
  createElement(tag) {
    const el = makeElement(tag);
    el.ownerDocument = global.document;
    return el;
  },
  addEventListener() {},
};

let testsPassed = 0;
let testsFailed = 0;
function assert(cond, name) {
  if (cond) {
    testsPassed++;
    console.log(`  PASS: ${name}`);
  } else {
    testsFailed++;
    console.log(`  FAIL: ${name}`);
  }
}

(async () => {
  console.log('=== preload.js 逻辑测试 ===');

  // 加载 preload（会立即挂载浮层并请求初始余额）
  require('../src/preload.js');

  // 1. contextBridge 暴露了 dshDesktop API
  assert(exposed && exposed.key === 'dshDesktop', 'contextBridge 暴露 dshDesktop');
  const api = exposed.val;
  assert(typeof api.onBalanceUpdate === 'function', 'onBalanceUpdate 存在');
  assert(typeof api.getAppInfo === 'function', 'getAppInfo 存在');
  assert(typeof api.quit === 'function', 'quit 存在');

  // 2. 浮层已注入 documentElement
  const overlay = global.document.documentElement.children.find(
    (c) => c.id === 'dsh-desktop-balance-overlay'
  );
  assert(!!overlay, '余额浮层已注入');
  assert(!!overlay.listeners.click, '浮层点击刷新已绑定');

  // 3. 推送余额数据 → 浮层文字更新
  const updateCb = ipcListeners['balance:update'];
  assert(typeof updateCb === 'function', '监听 balance:update');

  // 触发一次余额更新
  updateCb(null, {
    ok: true,
    isAvailable: true,
    balances: [
      { currency: 'CNY', total_balance: '8.52', granted_balance: '0.00', topped_up_balance: '8.52' },
    ],
    fetchedAt: Date.now(),
  });
  const textEl = global.document.getElementById('dsh-desktop-balance-overlay-text');
  assert(textEl && textEl.textContent.includes('8.52'), '余额数值渲染: ' + (textEl ? textEl.textContent : 'N/A'));

  // 4. 失败状态渲染
  updateCb(null, { ok: false, error: '未配置 DEEPSEEK_API_KEY' });
  const textEl2 = global.document.getElementById('dsh-desktop-balance-overlay-text');
  assert(textEl2 && textEl2.textContent.includes('余额不可用'), '失败状态渲染: ' + (textEl2 ? textEl2.textContent : 'N/A'));

  // 5. 悬停 tooltip 生成
  const overlay2 = global.document.documentElement.children.find(
    (c) => c.id === 'dsh-desktop-balance-overlay'
  );
  const tooltip = overlay2.children.find((c) => c.id === 'dsh-desktop-balance-tooltip');
  assert(!!tooltip, 'tooltip 元素已创建');
  assert(!!overlay2.listeners.mouseenter, '悬停事件已绑定');

  console.log(`\n结果: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
})();
