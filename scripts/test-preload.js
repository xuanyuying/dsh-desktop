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
      if (channel === 'ui:get-hud') {
        return { left: null, top: null, collapsed: false, enabled: true, anchored: true };
      }
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
/** 所有创建过的元素，供 querySelectorAll 使用 */
const allElements = [];
/** document.addEventListener 捕获的处理器，便于模拟 resize 等事件 */
const docListeners = {};
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
    _rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    _fontSize: '12px',
    ownerDocument: global.document,
    getBoundingClientRect() {
      return this._rect;
    },
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
      child.parentNode = this;
      if (child.id) elements.set(child.id, child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      if (child.id) elements.delete(child.id);
      child.parentNode = null;
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
  allElements.push(el);
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
  querySelectorAll(selector) {
    const tags = String(selector)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    return allElements.filter((e) => tags.includes(e.tagName));
  },
  addEventListener(evt, fn) {
    docListeners[evt] = fn;
  },
};

/** 页面窗对象：preload 会用它读尺寸/字号并监听 resize */
const winListeners = {};
global.window = {
  innerWidth: 1440,
  innerHeight: 860,
  getComputedStyle: (node) => ({ fontSize: (node && node._fontSize) || '12px' }),
  addEventListener(evt, fn) {
    winListeners[evt] = fn;
  },
  removeEventListener() {},
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

  // 2. 收到主进程状态前不渲染（渲染与否由 payload.floatHud 决定）
  assert(
    !global.document.documentElement.children.some((c) => c.id === HUD),
    '收到状态前不渲染浮动小卡'
  );

  const peakCb = ipcListeners['peak:update'];
  const balCb = ipcListeners['balance:update'];
  assert(typeof peakCb === 'function', '监听 peak:update');
  assert(typeof balCb === 'function', '监听 balance:update');

  // 2.1 造一个「XX模式」徽标，用于验证吸附位置
  const badge = global.document.createElement('span');
  badge.textContent = '创造模式';
  badge._fontSize = '13px';
  badge._rect = { left: 576, top: 70, right: 640, bottom: 90, width: 64, height: 20 };

  // 2.2 打开小卡后应吸附在徽标右侧「2 个字符」处
  const anchoredLeft = Math.round(640 + 2 * 13); // 640 + 26 = 666

  // 3. 默认开启：主进程一推送状态就出现浮层，并吸附在「XX模式」右侧
  //    倒计时按毫秒向下取整，这里多给 30 秒余量，避免断言因几毫秒的渲染耗时抖动
  peakCb(null, {
    isPeak: false,
    nextChangeAt: Date.now() + 2 * 60 * 60 * 1000 + 30 * 1000,
    guardEnabled: true,
    allowed: false,
    guardAlive: true,
    floatHud: true,
  });
  const hud = global.document.documentElement.children.find((c) => c.id === HUD);
  assert(!!hud, 'floatHud=true 时浮层被创建');
  const hudStyle = hud.attrs.style || '';
  assert(hudStyle.includes('position: fixed'), 'HUD 为 fixed 定位');
  assert(hudStyle.includes('opacity: 0.45'), '默认半透明，减少对正文的遮挡');
  assert(hudStyle.includes('z-index'), 'HUD 有 z-index');
  assert(hudStyle.includes('pointer-events: none'), '★ 浮层容器点击穿透（不会挡住下面的按钮）');
  const handle = global.document.getElementById(HUD + '-handle');
  assert(!!handle, '存在拖拽手柄 ⠿');
  // 手柄与折叠按钮的内联样式写在 innerHTML 模板里，直接查模板字符串
  const inlineStyles = String(hud._innerHTML || '');
  assert(
    (inlineStyles.match(/pointer-events:auto/g) || []).length >= 2,
    '手柄与折叠按钮都可交互（pointer-events:auto）'
  );
  assert(typeof handle.listeners.mousedown === 'function', '支持拖动（手柄 mousedown 已绑定）');
  assert(typeof handle.listeners.dblclick === 'function', '支持双击恢复吸附');
  assert(typeof handle.listeners.mouseenter === 'function', '手柄悬停展开详情');

  // 3.1 吸附位置 = 徽标右边缘 + 2 个字符（按徽标字号算）
  assert(
    hud.style.left === anchoredLeft + 'px',
    `吸附在「XX模式」右侧 2 字符处: left=${hud.style.left}（期望 ${anchoredLeft}px）`
  );
  assert(hud.style.top === '70px', '与徽标同一行: top=' + hud.style.top);
  assert(hud.style.right === 'auto', '吸附模式下不再用 right 定位');

  // 3.2 拖动即解除吸附，并记住手动坐标
  hud._rect = { left: anchoredLeft, top: 70, right: anchoredLeft + 200, bottom: 90, width: 200, height: 20 };
  handle.listeners.mousedown({
    button: 0,
    clientX: 700,
    clientY: 80,
    target: { id: '' },
    preventDefault() {},
  });
  docListeners.mousemove({ clientX: 800, clientY: 200 });
  docListeners.mouseup({});
  assert(hud.style.left === '766px', '拖动后按手动坐标摆放: ' + hud.style.left);
  assert(hud.style.top === '190px', '拖动后 top 同步: ' + hud.style.top);

  // 3.3 已解除吸附时，窗口缩放不应把它拽回徽标旁
  if (typeof winListeners.resize === 'function') winListeners.resize();
  assert(hud.style.left === '766px', '解除吸附后缩放窗口不会重算位置: ' + hud.style.left);

  // 3.4 双击恢复吸附
  handle.listeners.dblclick({});
  assert(
    hud.style.left === anchoredLeft + 'px',
    '双击后恢复吸附: left=' + hud.style.left
  );

  // 4. 旧的两个底部浮层必须不复存在（它们会压住输入框并抢点击）
  const legacy = global.document.documentElement.children.filter(
    (c) => c.id === 'dsh-desktop-balance-overlay' || c.id === 'dsh-desktop-peak-overlay'
  );
  assert(legacy.length === 0, '旧的底部浮层已移除（回归：不再遮挡底部对话）');

  // 5. 余额渲染
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

  // 6. 峰谷渲染
  const peakText = () => global.document.getElementById(HUD + '-peak-text').textContent;
  const peakIcon = () => global.document.getElementById(HUD + '-peak-text-icon').textContent;

  assert(peakIcon() === '🟢', '空闲图标为绿');
  assert(peakText().includes('空闲 5 折'), '空闲文案: ' + peakText());
  assert(peakText().includes('2 小时'), '倒计时按本机计算');

  peakCb(null, {
    isPeak: true,
    nextChangeAt: Date.now() + 90 * 60 * 1000,
    guardEnabled: true,
    allowed: false,
    guardAlive: true,
    floatHud: true,
  });
  assert(peakIcon() === '🔴', '高峰守卫运行时图标为红');
  assert(peakText().includes('高峰已暂停'), '高峰守卫运行时文案: ' + peakText());

  peakCb(null, {
    isPeak: true,
    nextChangeAt: Date.now() + 60 * 60 * 1000,
    guardEnabled: true,
    allowed: true,
    guardAlive: true,
    floatHud: true,
  });
  assert(peakIcon() === '🟠' && peakText().includes('已放行'), '临时放行文案: ' + peakText());

  peakCb(null, {
    isPeak: true,
    nextChangeAt: Date.now() + 60 * 60 * 1000,
    guardEnabled: false,
    allowed: false,
    guardAlive: true,
    floatHud: true,
  });
  assert(peakText().includes('守卫已关'), '守卫关闭文案: ' + peakText());

  // 7. 悬停详情
  const tip = hud.children.find((c) => c.id === 'dsh-desktop-hud-tooltip');
  assert(!!tip, 'HUD tooltip 已创建');
  peakCb(null, {
    isPeak: true,
    nextChangeAt: Date.now() + 60 * 60 * 1000,
    guardEnabled: true,
    allowed: false,
    guardAlive: false,
    floatHud: true,
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
  handle.listeners.mouseenter();
  assert(tip.innerHTML.includes('守卫未生效'), '守卫失效时明确告警');
  assert(tip.innerHTML.includes('Flash 输出'), '详情含价目');
  assert(tip.innerHTML.includes('09:00–12:00'), '详情含本机高峰窗口');
  assert(tip.innerHTML.includes('点击穿透'), '详情提示浮层点击穿透 + 手柄交互');

  // 8. 折叠
  const body = global.document.getElementById(HUD + '-body');
  assert(body && body.style.display !== 'none', '默认展开');
  hud.listeners.click({ target: { id: HUD + '-toggle' } });
  assert(body.style.display === 'none', '点击 − 后折叠');
  assert(global.document.getElementById(HUD + '-toggle').textContent === '+', '折叠后按钮变为 +');
  hud.listeners.click({ target: { id: HUD + '-toggle' } });
  assert(body.style.display === 'block', '再次点击展开');

  // 9. 位置来源
  assert(
    ipcInvoked.includes('sync:ui:get-hud'),
    '启动时同步读取主进程保存的 HUD 状态'
  );
  assert(hud.style.left !== '' && hud.style.left !== 'auto', '使用 left 定位（吸附/手动都用它）');
  assert(hud.style.bottom === 'auto', '不使用 bottom 定位');
  assert(
    ipcInvoked.includes('ui:set-hud'),
    '拖动/折叠会写回主进程（端口变化也不丢位置）'
  );

  // 10. 菜单里关闭后浮层被移除
  peakCb(null, {
    isPeak: false,
    nextChangeAt: Date.now() + 60 * 60 * 1000,
    guardEnabled: true,
    allowed: false,
    guardAlive: true,
    floatHud: false,
  });
  assert(
    !global.document.documentElement.children.some((c) => c.id === HUD),
    'floatHud=false 时浮层被移除（不再遮挡页面）'
  );

  // 11. 启动时请求了初始数据
  assert(ipcInvoked.includes('peak:refresh'), '启动时请求峰谷状态');
  assert(ipcInvoked.includes('balance:refresh'), '启动时请求余额');

  console.log(`\n结果: ${testsPassed} passed, ${testsFailed} failed`);
  process.exit(testsFailed > 0 ? 1 : 0);
})();
