/**
 * DSH Desktop - preload 脚本
 *
 * 在 Harness Web UI 左下角注入"余额实时显示"浮层：
 * - 通过 IPC 接收主进程推送的余额数据
 * - 渲染余额、币种、刷新时间、可用状态
 * - 提供悬浮详情与点击手动刷新
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// 余额浮层 UI（注入到页面左下角）
// ---------------------------------------------------------------------------

const OVERLAY_ID = 'dsh-desktop-balance-overlay';
const TOOLTIP_ID = 'dsh-desktop-balance-tooltip';
let lastState = null;

/** 构造浮层根元素（幂等，重复调用返回已存在的元素） */
function ensureOverlay() {
  let overlay = document.getElementById(OVERLAY_ID);
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute(
    'style',
    [
      'position: fixed',
      'right: 12px',
      'bottom: 12px',
      'z-index: 2147483647',
      'display: flex',
      'align-items: center',
      'gap: 8px',
      'padding: 8px 14px',
      'border-radius: 12px',
      'background: rgba(15, 20, 30, 0.85)',
      'backdrop-filter: blur(10px)',
      '-webkit-backdrop-filter: blur(10px)',
      'border: 1px solid rgba(255, 255, 255, 0.12)',
      'box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35)',
      'color: #e6edf3',
      'font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      'font-size: 13px',
      'line-height: 1.4',
      'cursor: pointer',
      'user-select: none',
      'transition: opacity 0.2s ease',
    ].join(';')
  );

  overlay.innerHTML = `
    <span id="${OVERLAY_ID}-icon" style="font-size:16px;line-height:1">💰</span>
    <span id="${OVERLAY_ID}-text" style="white-space:nowrap">余额加载中…</span>
  `;

  // 点击手动刷新
  overlay.addEventListener('click', () => {
    ipcRenderer.invoke('balance:refresh');
    setText('刷新中…');
  });

  // 悬停显示详情
  const tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  tooltip.setAttribute(
    'style',
    [
      'position: fixed',
      'right: 12px',
      'bottom: 56px',
      'z-index: 2147483647',
      'display: none',
      'min-width: 240px',
      'padding: 10px 14px',
      'border-radius: 10px',
      'background: rgba(15, 20, 30, 0.92)',
      'backdrop-filter: blur(10px)',
      '-webkit-backdrop-filter: blur(10px)',
      'border: 1px solid rgba(255, 255, 255, 0.12)',
      'box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4)',
      'color: #e6edf3',
      'font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      'font-size: 12px',
      'line-height: 1.6',
      'pointer-events: none',
    ].join(';')
  );
  overlay.appendChild(tooltip);

  overlay.addEventListener('mouseenter', () => {
    if (lastState) renderTooltip(tooltip, lastState);
    tooltip.style.display = 'block';
  });
  overlay.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });

  document.documentElement.appendChild(overlay);
  return overlay;
}

function setText(text) {
  const el = document.getElementById(`${OVERLAY_ID}-text`);
  if (el) el.textContent = text;
}

function setIcon(icon) {
  const el = document.getElementById(`${OVERLAY_ID}-icon`);
  if (el) el.textContent = icon;
}

/** 格式化金额 */
function fmtMoney(v) {
  const n = Number(v);
  if (Number.isNaN(n)) return '--';
  return n.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** 渲染主视图文本 */
function renderMain(state) {
  if (!state.ok) {
    setIcon('⚠️');
    setText('余额不可用');
    return;
  }
  const list = state.balances || [];
  const cny = list.find((b) => (b.currency || '').toUpperCase() === 'CNY') || list[0];
  if (!cny) {
    setIcon('💰');
    setText('余额查询中…');
    return;
  }
  setIcon('💰');
  setText(
    `余额 ¥${fmtMoney(cny.total_balance)}  ·  ${fmtTime(state.fetchedAt)}`
  );
}

/** 渲染悬停详情 */
function renderTooltip(tooltip, state) {
  let html = '';
  if (!state.ok) {
    html = `<div style="font-weight:600;color:#f85149">余额获取失败</div>
            <div style="color:#8b949e">${escapeHtml(state.error || '未知错误')}</div>`;
  } else {
    const rows = (state.balances || [])
      .map((b) => {
        const currency = b.currency || '?';
        const total = fmtMoney(b.total_balance);
        const granted = fmtMoney(b.granted_balance);
        const topped = fmtMoney(b.topped_up_balance);
        return `<div style="display:flex;justify-content:space-between;gap:16px">
                  <span style="color:#8b949e">${escapeHtml(currency)} 总余额</span>
                  <span style="font-weight:700;color:#3fb950">${total}</span>
                </div>
                <div style="display:flex;justify-content:space-between;gap:16px">
                  <span style="color:#8b949e">　赠金</span><span>${granted}</span>
                </div>
                <div style="display:flex;justify-content:space-between;gap:16px">
                  <span style="color:#8b949e">　充值</span><span>${topped}</span>
                </div>`;
      })
      .join('<div style="height:6px"></div>');
    const status = state.isAvailable
      ? '<span style="color:#3fb950">● 服务可用</span>'
      : '<span style="color:#f85149">● 服务不可用</span>';
    html = `
      <div style="font-weight:600;margin-bottom:6px">DeepSeek 账户余额</div>
      ${rows}
      <div style="display:flex;justify-content:space-between;margin-top:8px;color:#8b949e">
        <span>${status}</span>
        <span>更新于 ${fmtTime(state.fetchedAt)}</span>
      </div>`;
  }
  tooltip.innerHTML = html;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// IPC 桥
// ---------------------------------------------------------------------------

const api = {
  /** 订阅余额更新 */
  onBalanceUpdate(callback) {
    ipcRenderer.on('balance:update', (_e, data) => callback(data));
  },
  /** 订阅服务日志 */
  onServiceLog(callback) {
    ipcRenderer.on('service:log', (_e, line) => callback(line));
  },
  /** 订阅致命错误 */
  onFatalError(callback) {
    ipcRenderer.on('fatal:error', (_e, msg) => callback(msg));
  },
  /** 获取应用信息 */
  getAppInfo() {
    return ipcRenderer.invoke('app:info');
  },
  /** 手动刷新余额 */
  refreshBalance() {
    return ipcRenderer.invoke('balance:refresh');
  },
  /** 退出应用 */
  quit() {
    ipcRenderer.send('app:quit');
  },
};

contextBridge.exposeInMainWorld('dshDesktop', api);

// ---------------------------------------------------------------------------
// 浮层挂载：等 DOM 就绪后注入，并监听余额推送
// ---------------------------------------------------------------------------

function mountOverlay() {
  const overlay = ensureOverlay();
  void overlay;

  api.onBalanceUpdate((state) => {
    lastState = state;
    renderMain(state);
  });

  api.onFatalError((msg) => {
    setIcon('❌');
    setText('启动失败');
    lastState = { ok: false, error: msg };
  });

  // 请求一次初始余额
  api.refreshBalance().catch(() => {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountOverlay, { once: true });
} else {
  mountOverlay();
}
