/**
 * 桌面端 UI 状态持久化（纯 Node，不依赖 Electron，便于单测）。
 *
 * 存放 ~/.dsh-desktop/ui-state.json：
 *   { "window": { x, y, width, height, maximized }, "hud": { right, top, collapsed } }
 *
 * HUD 位置以前存在 localStorage，而 localStorage 按 origin 隔离 —— 端口一变
 * （现在端口冲突会自动退让）位置就丢了，所以改由主进程落盘。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_FILE = path.join(os.homedir(), '.dsh-desktop', 'ui-state.json');
const DEFAULT_WINDOW = { width: 1440, height: 900 };
const MIN_WINDOW = { width: 960, height: 640 };
const DEFAULT_HUD = { right: 12, top: 12, collapsed: false };

/** 状态文件路径（可用 DSH_DESKTOP_DATA_DIR 覆盖，便于测试） */
function statePath() {
  if (process.env.DSH_DESKTOP_UI_STATE) return process.env.DSH_DESKTOP_UI_STATE;
  if (process.env.DSH_DESKTOP_DATA_DIR) {
    return path.join(process.env.DSH_DESKTOP_DATA_DIR, 'ui-state.json');
  }
  return DEFAULT_FILE;
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 把窗口尺寸收敛到工作区内。
 *
 * 之前的实现写死 1440×900：在 1440×900 的屏幕上窗口底部会被任务栏挤掉，
 * 换更小的屏幕（1366×768）则连输入框都看不到。
 * @param {{x?:number,y?:number,width?:number,height?:number}} bounds
 * @param {{x:number,y:number,width:number,height:number}} workArea
 */
function clampBounds(bounds, workArea) {
  const wa = workArea || { x: 0, y: 0, width: DEFAULT_WINDOW.width, height: DEFAULT_WINDOW.height };
  const src = bounds || {};
  const width = clamp(
    Number.isFinite(src.width) ? src.width : DEFAULT_WINDOW.width,
    Math.min(MIN_WINDOW.width, wa.width),
    wa.width
  );
  const height = clamp(
    Number.isFinite(src.height) ? src.height : DEFAULT_WINDOW.height,
    Math.min(MIN_WINDOW.height, wa.height),
    wa.height
  );
  // 位置：优先用保存值，缺失或越界则居中
  const maxX = wa.x + wa.width - width;
  const maxY = wa.y + wa.height - height;
  const centeredX = wa.x + Math.round((wa.width - width) / 2);
  const centeredY = wa.y + Math.round((wa.height - height) / 2);
  const x = clamp(Number.isFinite(src.x) ? src.x : centeredX, wa.x, maxX);
  const y = clamp(Number.isFinite(src.y) ? src.y : centeredY, wa.y, maxY);
  return { x, y, width, height };
}

/** 读状态（缺失/损坏时返回默认）。保留全部键，供调用方扩展 */
function loadState(file = statePath()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** 合并写状态（只覆盖传入的键） */
function saveState(patch, file = statePath()) {
  const cur = loadState(file);
  const next = { ...cur, ...(patch || {}) };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch {
    return cur;
  }
}

/** 归一化 HUD 位置 */
function normalizeHud(hud) {
  const h = hud || {};
  return {
    right: clamp(Number.isFinite(h.right) ? h.right : DEFAULT_HUD.right, 0, 4000),
    top: clamp(Number.isFinite(h.top) ? h.top : DEFAULT_HUD.top, 0, 4000),
    collapsed: h.collapsed === true,
  };
}

function loadHud(file = statePath()) {
  return normalizeHud(loadState(file).hud);
}

function saveHud(hud, file = statePath()) {
  const next = normalizeHud(hud);
  saveState({ hud: next }, file);
  return next;
}

module.exports = {
  DEFAULT_FILE,
  DEFAULT_WINDOW,
  MIN_WINDOW,
  DEFAULT_HUD,
  statePath,
  clampBounds,
  loadState,
  saveState,
  normalizeHud,
  loadHud,
  saveHud,
};
