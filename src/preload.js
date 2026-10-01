/**
 * DSH Desktop - preload 脚本
 *
 * 在 Harness Web UI 上注入一个紧凑的 HUD 小卡，实时显示：
 *   - DeepSeek 峰谷计价时段（空闲 / 高峰 + 倒计时 + 折扣）
 *   - 账户余额
 *
 * 设计要点（针对"遮挡内容 / 挡住点击"的反馈）：
 *   - 两个信息合并成一张小卡，占用面积最小
 *   - 可拖动，位置存 localStorage，拖一次永久生效
 *   - 平时半透明，悬停才完全不透明，不干扰正文阅读
 *   - 双击复位到默认位置
 *   - 真正的零 token 保证在 harness 侧守卫插件；这里只做显示与输入拦截
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

const DEFAULT_POS = { right: 12, top: 12 };
const POS_KEY = 'dshDesktop.hudPos';
const COLLAPSE_KEY = 'dshDesktop.hudCollapsed';
const IDLE_OPACITY = '0.45';

/**
 * HUD 位置的主存储是主进程的 ui-state.json。
 *
 * 以前只用 localStorage，而它按 origin 隔离 —— 端口一变（现在端口冲突会自动
 * 退让到其它端口）位置就丢了。localStorage 仅作为主进程不可用时的兜底。
 */
const storage = (() => {
  try {
    if (typeof localStorage !== 'undefined' && localStorage) {
      localStorage.setItem('__dsh_probe__', '1');
      localStorage.removeItem('__dsh_probe__');
      return localStorage;
    }
  } catch {
    /* 不可用 */
  }
  return null;
})();

function loadJSON(key, fallback) {
  try {
    const raw = storage && storage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function saveJSON(key, value) {
  try {
    if (storage) storage.setItem(key, JSON.stringify(value));
  } catch {
    /* 忽略 */
  }
}

/** 读取初始 HUD 状态：主进程优先（同步，避免启动时位置跳变） */
function loadHudState() {
  try {
    const s = ipcRenderer.sendSync('ui:get-hud');
    if (s && typeof s === 'object') {
      return {
        pos: {
          right: Number.isFinite(s.right) ? s.right : DEFAULT_POS.right,
          top: Number.isFinite(s.top) ? s.top : DEFAULT_POS.top,
        },
        collapsed: s.collapsed === true,
      };
    }
  } catch {
    /* 主进程未就绪，退回 localStorage */
  }
  const pos = loadJSON(POS_KEY, null);
  return {
    pos: pos && Number.isFinite(pos.right) && Number.isFinite(pos.top) ? pos : { ...DEFAULT_POS },
    collapsed: loadJSON(COLLAPSE_KEY, false) === true,
  };
}

/** 持久化 HUD 状态（主进程 + localStorage 兜底） */
function persistHud() {
  const payload = { right: hudPos.right, top: hudPos.top, collapsed: hudCollapsed };
  try {
    ipcRenderer.invoke('ui:set-hud', payload);
  } catch {
    /* 忽略 */
  }
  saveJSON(POS_KEY, hudPos);
  saveJSON(COLLAPSE_KEY, hudCollapsed);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 格式化金额 */
function fmtMoney(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return '--';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtTime(ts) {
  const d = new Date(ts);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 毫秒 → 「X 小时 Y 分」 */
function fmtLeft(ms) {
  if (!(ms > 0)) return '即将切换';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return '不足 1 分';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return m + ' 分';
  if (m === 0) return h + ' 小时';
  return h + ' 小时 ' + m + ' 分';
}

// ---------------------------------------------------------------------------
// HUD 小卡
// ---------------------------------------------------------------------------

const HUD_ID = 'dsh-desktop-hud';
const HUD_TIP_ID = 'dsh-desktop-hud-tooltip';
const TOAST_ID = 'dsh-desktop-peak-toast';

let balanceState = null;
let peakState = null;
const initialHud = loadHudState();
let hudPos = initialHud.pos;
let hudCollapsed = initialHud.collapsed;

function el(id) {
  return document.getElementById(id);
}

function setRow(id, text, icon) {
  const t = el(id);
  if (t) t.textContent = text;
  const i = el(id + '-icon');
  if (i) i.textContent = icon;
}

/** 应用位置与折叠状态 */
function applyHudLayout() {
  const hud = el(HUD_ID);
  if (!hud) return;
  const right = Number(hudPos.right);
  const top = Number(hudPos.top);
  hud.style.right = (Number.isFinite(right) ? right : DEFAULT_POS.right) + 'px';
  hud.style.top = (Number.isFinite(top) ? top : DEFAULT_POS.top) + 'px';
  hud.style.left = 'auto';
  hud.style.bottom = 'auto';
  const body = el(HUD_ID + '-body');
  if (body) body.style.display = hudCollapsed ? 'none' : 'block';
  const toggle = el(HUD_ID + '-toggle');
  if (toggle) toggle.textContent = hudCollapsed ? '+' : '−';
}

/** 构造 HUD（幂等） */
function ensureHud() {
  let hud = el(HUD_ID);
  if (hud) return hud;

  hud = document.createElement('div');
  hud.id = HUD_ID;
  hud.setAttribute(
    'style',
    [
      'position: fixed',
      'right: 12px',
      'top: 12px',
      'z-index: 2147483000',
      'padding: 7px 10px',
      'border-radius: 10px',
      'background: rgba(13, 17, 23, 0.88)',
      'backdrop-filter: blur(8px)',
      '-webkit-backdrop-filter: blur(8px)',
      'border: 1px solid rgba(255,255,255,0.10)',
      'box-shadow: 0 3px 14px rgba(0,0,0,0.35)',
      'color: #e6edf3',
      'font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      'font-size: 12px',
      'line-height: 1.5',
      'cursor: grab',
      'user-select: none',
      'opacity: ' + IDLE_OPACITY,
      'transition: opacity 0.18s ease',
      'max-width: 260px',
    ].join(';')
  );

  hud.innerHTML =
    '<div style="display:flex;align-items:flex-start;gap:6px">' +
    '<div id="' + HUD_ID + '-body" style="flex:1;min-width:0">' +
    '<div style="display:flex;align-items:center;gap:6px;white-space:nowrap">' +
    '<span id="' + HUD_ID + '-peak-text-icon">🟢</span>' +
    '<span id="' + HUD_ID + '-peak-text">时段判定中…</span>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:6px;white-space:nowrap">' +
    '<span id="' + HUD_ID + '-bal-text-icon">💰</span>' +
    '<span id="' + HUD_ID + '-bal-text">余额加载中…</span>' +
    '</div>' +
    '</div>' +
    '<span id="' + HUD_ID + '-toggle" style="cursor:pointer;padding:0 2px;color:#8b949e">−</span>' +
    '</div>';

  // 悬停详情
  const tip = document.createElement('div');
  tip.id = HUD_TIP_ID;
  tip.setAttribute(
    'style',
    [
      'position: fixed',
      'right: 12px',
      'top: 84px',
      'z-index: 2147483001',
      'display: none',
      'max-width: 340px',
      'padding: 10px 13px',
      'border-radius: 10px',
      'background: rgba(13, 17, 23, 0.96)',
      'border: 1px solid rgba(255,255,255,0.12)',
      'box-shadow: 0 6px 22px rgba(0,0,0,0.45)',
      'color: #e6edf3',
      'font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      'font-size: 12px',
      'line-height: 1.7',
      'pointer-events: none',
    ].join(';')
  );
  hud.appendChild(tip);

  hud.addEventListener('mouseenter', () => {
    hud.style.opacity = '1';
    renderTooltip(tip);
    tip.style.display = 'block';
  });
  hud.addEventListener('mouseleave', () => {
    hud.style.opacity = IDLE_OPACITY;
    tip.style.display = 'none';
  });

  // 折叠按钮
  hud.addEventListener('click', (e) => {
    const t = e && e.target;
    if (t && t.id === HUD_ID + '-toggle') {
      hudCollapsed = !hudCollapsed;
      persistHud();
      applyHudLayout();
    }
  });

  installDrag(hud);

  document.documentElement.appendChild(hud);
  applyHudLayout();
  return hud;
}

/**
 * 拖动：按住移动即改位置，松手持久化。
 * 以 right/top 存储，窗口缩放后仍贴住右上角一侧。
 */
function installDrag(hud) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startRight = 0;
  let startTop = 0;
  let moved = false;

  const onMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
    const maxRight = Math.max(0, window.innerWidth - 60);
    const maxTop = Math.max(0, window.innerHeight - 40);
    hudPos = {
      right: Math.min(maxRight, Math.max(0, startRight - dx)),
      top: Math.min(maxTop, Math.max(0, startTop + dy)),
    };
    applyHudLayout();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    hud.style.cursor = 'grab';
    if (moved) persistHud();
  };

  hud.addEventListener('mousedown', (e) => {
    const t = e && e.target;
    if (t && t.id === HUD_ID + '-toggle') return; // 折叠按钮不触发拖动
    if (e.button !== 0) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    startRight = Number(hudPos.right) || DEFAULT_POS.right;
    startTop = Number(hudPos.top) || DEFAULT_POS.top;
    hud.style.cursor = 'grabbing';
    if (e.preventDefault) e.preventDefault();
  });

  hud.addEventListener('dblclick', () => {
    hudPos = Object.assign({}, DEFAULT_POS);
    persistHud();
    applyHudLayout();
  });

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('mouseup', onUp, true);
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function peakMsLeft() {
  if (!peakState || !peakState.nextChangeAt) return 0;
  return peakState.nextChangeAt - Date.now();
}

/** 当前是否处于「高峰且守卫开启」——即消息会被拒绝 */
function isPeakBlocked() {
  if (!peakState) return false;
  return Boolean(peakState.isPeak) && peakState.guardEnabled !== false && !peakState.allowed;
}

function renderPeak() {
  if (!peakState) return;
  const left = fmtLeft(peakMsLeft());
  if (!peakState.isPeak) {
    setRow(HUD_ID + '-peak-text', '空闲 5 折 · ' + left + '后转高峰', '🟢');
    return;
  }
  if (isPeakBlocked()) {
    setRow(HUD_ID + '-peak-text', '高峰已暂停 · ' + left + '后恢复', '🔴');
  } else if (peakState.guardEnabled === false) {
    setRow(HUD_ID + '-peak-text', '高峰 · 守卫已关', '🟠');
  } else {
    setRow(HUD_ID + '-peak-text', '高峰 · 已放行', '🟠');
  }
}

function renderBalance() {
  const state = balanceState;
  if (!state) return;
  if (!state.ok) {
    setRow(HUD_ID + '-bal-text', '余额不可用', '⚠️');
    return;
  }
  const list = state.balances || [];
  const cny = list.find((b) => (b.currency || '').toUpperCase() === 'CNY') || list[0];
  if (!cny) {
    setRow(HUD_ID + '-bal-text', '余额查询中…', '💰');
    return;
  }
  setRow(
    HUD_ID + '-bal-text',
    '¥' + fmtMoney(cny.total_balance) + ' · ' + fmtTime(state.fetchedAt),
    '💰'
  );
}

/** 悬停详情 */
function renderTooltip(tip) {
  let html = '';

  if (!balanceState) {
    html += '<div style="color:#8b949e">余额加载中…</div>';
  } else if (!balanceState.ok) {
    html +=
      '<div style="font-weight:600;color:#f85149">余额获取失败</div>' +
      '<div style="color:#8b949e">' + escapeHtml(balanceState.error || '未知错误') + '</div>';
  } else {
    const rows = (balanceState.balances || [])
      .map(
        (b) =>
          '<div style="display:flex;justify-content:space-between;gap:16px">' +
          '<span style="color:#8b949e">' + escapeHtml(b.currency || '?') + ' 总余额</span>' +
          '<span style="font-weight:700;color:#3fb950">' + fmtMoney(b.total_balance) + '</span>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;gap:16px">' +
          '<span style="color:#8b949e">&nbsp;&nbsp;赠金</span><span>' + fmtMoney(b.granted_balance) + '</span>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;gap:16px">' +
          '<span style="color:#8b949e">&nbsp;&nbsp;充值</span><span>' + fmtMoney(b.topped_up_balance) + '</span>' +
          '</div>'
      )
      .join('<div style="height:6px"></div>');
    html +=
      '<div style="font-weight:600;margin-bottom:4px">DeepSeek 账户余额</div>' + rows +
      '<div style="color:#8b949e;margin-top:6px">更新于 ' + fmtTime(balanceState.fetchedAt) + '</div>';
  }

  html += '<div style="height:1px;background:rgba(255,255,255,0.10);margin:9px 0"></div>';

  if (!peakState) {
    html += '<div style="color:#8b949e">时段判定中…</div>';
  } else {
    const s = peakState;
    const head = s.isPeak
      ? '<span style="color:#f0883e">● 高峰时段（标准价）</span>'
      : '<span style="color:#3fb950">● 空闲时段（5 折）</span>';
    let guard;
    if (!s.isPeak) {
      guard = '<span style="color:#3fb950">守卫待命（进入高峰自动拦截）</span>';
    } else if (s.guardEnabled === false) {
      guard = '<span style="color:#8b949e">守卫已关闭 — 高峰会正常消耗 token</span>';
    } else if (s.allowed) {
      guard = '<span style="color:#f0883e">已临时放行 — 高峰会正常消耗 token</span>';
    } else if (s.guardAlive) {
      guard = '<span style="color:#3fb950">守卫运行中 — 高峰不消耗任何 token</span>';
    } else {
      guard = '<span style="color:#f85149">⚠ 守卫未生效 — 请在菜单「峰谷」重启服务</span>';
    }
    const prices = (s.prices || [])
      .map(
        (p) =>
          '<div style="display:flex;justify-content:space-between;gap:16px">' +
          '<span style="color:#8b949e">' + escapeHtml(p.label) + '</span>' +
          '<span>' + escapeHtml(p.value) + '</span></div>'
      )
      .join('');
    html +=
      '<div style="font-weight:600;margin-bottom:4px">DeepSeek 峰谷计价</div>' +
      '<div>' + head + '</div>' +
      '<div style="color:#8b949e">' + escapeHtml(s.countdownText || '') + '</div>' +
      '<div style="color:#8b949e;margin-top:4px">高峰（本机时间，周一至周五）</div>' +
      '<div>' + escapeHtml((s.localPeakWindows || []).join('、') || '—') + '</div>' +
      (prices ? '<div style="height:6px"></div>' + prices : '') +
      '<div style="height:6px"></div><div>' + guard + '</div>' +
      '<div style="color:#8b949e;margin-top:6px">拖动可移动 · 双击复位 · 点 − 折叠</div>';
  }

  tip.innerHTML = html;
}

// ---------------------------------------------------------------------------
// 高峰发送拦截（体验层；真正的保证在 harness 侧守卫插件）
// ---------------------------------------------------------------------------

function showPeakToast() {
  let toast = el(TOAST_ID);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.setAttribute(
      'style',
      [
        'position: fixed',
        'left: 50%',
        'top: 50%',
        'transform: translate(-50%, -50%)',
        'z-index: 2147483002',
        'max-width: 460px',
        'padding: 14px 20px',
        'border-radius: 12px',
        'background: rgba(60, 22, 22, 0.96)',
        'border: 1px solid rgba(248, 81, 73, 0.5)',
        'box-shadow: 0 10px 32px rgba(0,0,0,0.5)',
        'color: #ffdcd7',
        'font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
        'font-size: 13px',
        'line-height: 1.6',
        'text-align: center',
        'pointer-events: none',
        'transition: opacity 0.25s ease',
      ].join(';')
    );
    document.documentElement.appendChild(toast);
  }
  toast.innerHTML =
    '<b>高峰时段已暂停发送</b><br>' +
    '当前为 DeepSeek 高峰时段，发送不会消耗任何 token（请求被拦截）。<br>' +
    escapeHtml(fmtLeft(peakMsLeft())) + '后进入空闲时段（5 折）。<br>' +
    '如需立即使用，菜单「峰谷 → 临时放行至本时段结束」。';
  toast.style.opacity = '1';
  clearTimeout(showPeakToast._t);
  showPeakToast._t = setTimeout(() => {
    toast.style.opacity = '0';
  }, 4500);
}

/**
 * 高峰时拦截发送。仅拦 Enter，且目标必须是 textarea / contenteditable
 * （消息输入框），不碰 input（搜索框等），避免误伤。
 */
function installComposerGuard() {
  if (installComposerGuard._done) return;
  installComposerGuard._done = true;

  document.addEventListener(
    'keydown',
    (e) => {
      if (!isPeakBlocked()) return;
      if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.isComposing) return;
      const t = e.target;
      if (!t || !t.tagName) return;
      const tag = t.tagName.toLowerCase();
      if (tag !== 'textarea' && t.isContentEditable !== true) return;
      e.preventDefault();
      e.stopPropagation();
      showPeakToast();
    },
    true
  );

  setInterval(() => {
    if (!peakState) return;
    if (peakState.nextChangeAt && Date.now() >= peakState.nextChangeAt) {
      ipcRenderer.invoke('peak:refresh');
      return;
    }
    renderPeak();
  }, 1000);
}

// ---------------------------------------------------------------------------
// IPC 桥
// ---------------------------------------------------------------------------

const api = {
  onBalanceUpdate(callback) {
    ipcRenderer.on('balance:update', (_e, data) => callback(data));
  },
  onServiceLog(callback) {
    ipcRenderer.on('service:log', (_e, line) => callback(line));
  },
  onFatalError(callback) {
    ipcRenderer.on('fatal:error', (_e, msg) => callback(msg));
  },
  onPeakUpdate(callback) {
    ipcRenderer.on('peak:update', (_e, data) => callback(data));
  },
  refreshPeak() {
    return ipcRenderer.invoke('peak:refresh');
  },
  allowPeakTemporarily() {
    return ipcRenderer.invoke('peak:allow-temporarily');
  },
  setPeakGuard(enabled) {
    return ipcRenderer.invoke('peak:set-guard', enabled);
  },
  getAppInfo() {
    return ipcRenderer.invoke('app:info');
  },
  refreshBalance() {
    return ipcRenderer.invoke('balance:refresh');
  },
  quit() {
    ipcRenderer.send('app:quit');
  },
};

contextBridge.exposeInMainWorld('dshDesktop', api);

// ---------------------------------------------------------------------------
// 挂载
// ---------------------------------------------------------------------------

function mountOverlay() {
  ensureHud();
  installComposerGuard();

  api.onBalanceUpdate((state) => {
    balanceState = state;
    renderBalance();
  });

  api.onFatalError((msg) => {
    balanceState = { ok: false, error: msg };
    renderBalance();
  });

  api.onPeakUpdate((state) => {
    peakState = state;
    renderPeak();
  });

  api.refreshPeak().catch(() => {});
  api.refreshBalance().catch(() => {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountOverlay, { once: true });
} else {
  mountOverlay();
}
