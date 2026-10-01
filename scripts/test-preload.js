/**
 * preload.js 逻辑测试：mock electron 模块 + 最小 DOM，验证 HUD 渲染。
 * 用法: node scripts/test-preload.js
 */
'use strict';

// ---- Mock Electron ----
const ipcListeners = {};
const ipcInvoked = [];
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
      ipcInvoked.push(channel);
      if (channel === 'balance:refresh') return Promise.resolve();
      return Promise.resolve({});
    },
    // HUD 位置的主存储：主进程同步返回（证明不再依赖 localStorage）
    sendSync: (channel) => {
      ipcInvoked.push('sync:' + channel);
      if (channel === 'ui:get-hud') return { right: 40, top: 60, collapsed: false };
      return undefined;
    },
    send: () => {},
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
    attrs: {},
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
      const idRe = /id="([^"]+)"/g;
      let m;
      while ((m = idRe.exec(v))) {
        const child = makeElement('span');
        child.id = m[1];
        this.children.push(child);
      }
      const textMatch = v.replace(/<[^>]+>/g, '');
      if (textMatch) this.textContent = textMatch;
    },
    get innerHTML() {
      return this._innerHTML;
    },
    appendChild(child) {
      this.children.push(child);
      if (child.id) elements.set(child.id, child);
      return child;
    },
    addEventListener(evt, fn) {
      this.listeners[evt] = fn;
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
      if (k === 'id') this.id = v;
    },
    getAttribute(k) {
      return this.attrs[k];
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

const HUD = 'dsh-desktop-hud';

(async () => {
  console.log('=== preload.js 逻辑测试 ===');

  require('../src/preload.js');

  // 1. API
  assert(exposed && exposed.key === 'dshDesktop', 'contextBridge 暴露 dshDesktop');
  const api = exposed.val;
  for (const m of [
    'onBalanceUpdate',
    'onPeakUpdate',
    'refreshPeak',
    'allowPeakTemporarily',
    'setPeakGuard',
    'getAppInfo',
    'refreshBalance',
    'quit',
  ]) {
    assert(typeof api[m] === 'function', `api.${m} 存在`);
  }

  // 2. HUD 注入（合并成单一小卡）
  const hud = global.document.documentElement.children.find((c) => c.id === HUD);
  assert(!!hud, 'HUD 小卡已注入');
  const hudStyle = hud.attrs.style || '';
  assert(hudStyle.includes('position: fixed'), 'HUD 为 fixed 定位');
  assert(hudStyle.includes('top: 12px'), '默认贴顶（离开底部输入区）');
  assert(hudStyle.includes('opacity: 0.45'), '默认半透明，减少对正文的遮挡');
  assert(hudStyle.includes('z-index'), 'HUD 有 z-index');
  assert(typeof hud.listeners.mousedown === 'function', '支持拖动（mousedown 已绑定）');
  assert(typeof hud.listeners.dblclick === 'function', '支持双击复位');
  assert(typeof hud.listeners.mouseenter === 'function', '悬停展开详情');

  // 3. 旧的两个底部浮层必须不复存在（它们会压住输入框并抢点击）
  const legacy = global.document.documentElement.children.filter(
    (c) => c.id === 'dsh-desktop-balance-overlay' || c.id === 'dsh-desktop-peak-overlay'
  );
  assert(legacy.length === 0, '旧的底部浮层已移除（回归：不再遮挡底部对话）');

  // 4. 余额渲染
  const balCb = ipcListeners['balance:update'];
  assert(typeof balCb === 'function', '监听 balance:update');
  balCb(null, {
    ok: true,
    isAvailable: true,
    balances: [
      { currency: 'CNY', total_balance: '7.33', granted_balance: '0.00', topped_up_balance: '7.33' },
    ],
    fetchedAt: Date.now(),
  });
  const balText = global.document.getElementById(HUD + '-bal-text');
  assert(balText && balText.textContent.includes('7.33'), '余额数值渲染: ' + (balText ? balText.textContent : 'N/A'));
  const balIcon = global.document.getElementById(HUD + '-bal-text-icon');
  assert(balIcon && balIcon.textContent === '💰', '余额图标正常');

  balCb(null, { ok: false, error: '未配置 DEEPSEEK_API_KEY' });
  assert(
    global.document.getElementById(HUD + '-bal-text').textContent.includes('余额不可用'),
    '失败状态渲染'
  );

  // 5. 峰谷渲染
  const peakCb = ipcListeners['peak:update'];
  assert(typeof peakCb === 'function', '监听 peak:update');
  const peakText = () => global.document.getElementById(HUD + '-peak-text').textContent;
  const peakIcon = () => global.document.getElementById(HUD + '-peak-text-icon').textContent;

  peakCb(null, {
    isPeak: false,
    nextChangeAt: Date.now() + 2 * 60 * 60 * 1000,
    guardEnabled: true,
    allowed: false,
    guardAlive: true,
  });
  assert(peakIcon() === '🟢', '空闲图标为绿');
  assert(peakText().includes('空闲 5 折'), '空闲文案: ' + peakText());
  assert(peakText().includes('2 小时'), '倒计时按本机计算');

  peakCb(null, {
    isPeak: true,
    nextChangeAt: Date.now() + 90 * 60 * 1000,
    guardEnabled: true,
    allowed: false,
    guardAlive: true,
  });
  assert(peakIcon() === '🔴', '高峰守卫运行时图标为红');
  assert(peakText().includes('高峰已暂停'), '高峰守卫运行时文案: ' + peakText());

  peakCb(null, {
    isPeak: true,
    nextChangeAt: Date.now() + 60 * 60 * 1000,
    guardEnabled: true,
    allowed: true,
    guardAlive: true,
  });
  assert(peakIcon() === '🟠' && peakText().includes('已放行'), '临时放行文案: ' + peakText());

  peakCb(null, {
    isPeak: true,
    nextChangeAt: Date.now() + 60 * 60 * 1000,
    guardEnabled: false,
    allowed: false,
    guardAlive: true,
  });
  assert(peakText().includes('守卫已关'), '守卫关闭文案: ' + peakText());

  // 6. 悬停详情
  const tip = hud.children.find((c) => c.id === 'dsh-desktop-hud-tooltip');
  assert(!!tip, 'HUD tooltip 已创建');
  peakCb(null, {
    isPeak: true,
    nextChangeAt: Date.now() + 60 * 60 * 1000,
    guardEnabled: true,
    allowed: false,
    guardAlive: false,
    countdownText: '距离进入空闲时段（5 折）还有 1 小时',
    localPeakWindows: ['09:00–12:00', '14:00–18:00'],
    prices: [{ label: 'Flash 输出', value: '$1.2 / 1M（空闲 $0.6）' }],
  });
  balCb(null, {
    ok: true,
    balances: [
      { currency: 'CNY', total_balance: '7.33', granted_balance: '0', topped_up_balance: '7.33' },
    ],
    fetchedAt: Date.now(),
  });
  hud.listeners.mouseenter();
  assert(tip.innerHTML.includes('守卫未生效'), '守卫失效时明确告警');
  assert(tip.innerHTML.includes('Flash 输出'), '详情含价目');
  assert(tip.innerHTML.includes('09:00–12:00'), '详情含本机高峰窗口');
  assert(tip.innerHTML.includes('拖动可移动'), '详情提示拖动/复位交互');

  // 7. 折叠
  const body = global.document.getElementById(HUD + '-body');
  assert(body && body.style.display !== 'none', '默认展开');
  hud.listeners.click({ target: { id: HUD + '-toggle' } });
  assert(body.style.display === 'none', '点击 − 后折叠');
  assert(global.document.getElementById(HUD + '-toggle').textContent === '+', '折叠后按钮变为 +');
  hud.listeners.click({ target: { id: HUD + '-toggle' } });
  assert(body.style.display === 'block', '再次点击展开');

  // 8. 位置应用（来自主进程，而非 localStorage）
  assert(
    ipcInvoked.includes('sync:ui:get-hud'),
    '启动时同步读取主进程保存的 HUD 位置'
  );
  assert(hud.style.right === '40px', '应用主进程返回的 right（而非本地默认）: ' + hud.style.right);
  assert(hud.style.top === '60px', '应用主进程返回的 top: ' + hud.style.top);
  assert(hud.style.left === 'auto' && hud.style.bottom === 'auto', '不使用 bottom/left 定位');
  assert(
    ipcInvoked.includes('ui:set-hud'),
    '折叠/拖动会写回主进程（端口变化也不丢位置）'
  );

  // 9. 启动时请求了初始数据
  assert(ipcInvoked.includes('peak:refresh'), '启动时请求峰谷状态');
  assert(ipcInvoked.includes('balance:refresh'), '启动时请求余额');

  console.log(`\n结果: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
})();
