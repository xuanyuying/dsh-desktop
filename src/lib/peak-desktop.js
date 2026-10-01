/**
 * 峰谷守卫的桌面侧管理（纯 Node，不依赖 Electron，便于单测）。
 *
 * 职责：
 *  - 生成把守卫插件注入 harness 的 patch 文件（--patch insert 形式）
 *  - 读写控制文件（开关 / 临时放行）
 *  - 读取守卫写出的心跳状态，据此确认「零 token」保护是否真的生效
 *
 * 三个文件都放在 ~/.dsh-desktop 下：
 *   peak-patch.yml    桌面端 → harness（注入插件）
 *   peak-control.json 桌面端 → 插件（{ enabled, allowUntilMs }）
 *   peak-status.json  插件 → 桌面端（心跳 + 权威时段状态）
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const GUARD_ROW_ID = 'dsh-desktop-peak-guard';
const GUARD_FILE = 'peak-guard.mjs';
/** 心跳超过该时长未更新即认为守卫不在运行 */
const HEARTBEAT_STALE_MS = 3 * 60 * 1000;

/** 桌面端数据目录 */
function getDesktopDir() {
  if (process.env.DSH_DESKTOP_DATA_DIR) return process.env.DSH_DESKTOP_DATA_DIR;
  return path.join(os.homedir(), '.dsh-desktop');
}

const patchPath = () => path.join(getDesktopDir(), 'peak-patch.yml');
const controlPath = () => path.join(getDesktopDir(), 'peak-control.json');
const statusPath = () => path.join(getDesktopDir(), 'peak-status.json');

function ensureDir() {
  const d = getDesktopDir();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 定位随应用分发的守卫插件。
 * @param {{isPackaged?: boolean, resourcesPath?: string, appDir?: string}} [opts]
 * @returns {string|null} 插件绝对路径
 */
function resolveGuardPluginPath(opts = {}) {
  const candidates = [];
  if (opts.isPackaged && opts.resourcesPath) {
    candidates.push(path.join(opts.resourcesPath, GUARD_FILE));
    candidates.push(path.join(opts.resourcesPath, 'resources', GUARD_FILE));
  }
  if (opts.appDir) candidates.push(path.join(opts.appDir, '..', 'resources', GUARD_FILE));
  // 开发/测试回退：仓库根下的 resources/
  candidates.push(path.join(__dirname, '..', '..', 'resources', GUARD_FILE));
  candidates.push(path.join(process.cwd(), 'resources', GUARD_FILE));
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c);
    } catch {
      /* 继续 */
    }
  }
  return null;
}

/** YAML 单引号字符串转义 */
function yamlQuote(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/**
 * 生成 patch 覆盖层内容。
 *
 * `insert` 且不带 `id` 会把行追加到入口列表顶层 —— 这是 dsh 里新增顶层插件行
 * 的唯一方式（裸 `- id:` 行只会被当作"覆盖已存在的行"，找不到就跳过）。
 * @param {string} guardPluginPath
 * @returns {string}
 */
function renderPatch(guardPluginPath) {
  const url = pathToFileURL(guardPluginPath).href;
  return (
    '# 由 DSH Desktop 自动生成 —— 注入峰谷守卫插件（高峰时段阻止一切模型调用）\n' +
    '- insert:\n' +
    '    - id: ' + GUARD_ROW_ID + '\n' +
    '      name: ' + yamlQuote(url) + '\n'
  );
}

/**
 * 写出 patch 文件。
 * @param {string} guardPluginPath
 * @returns {string} patch 文件绝对路径
 */
function writePatchFile(guardPluginPath) {
  ensureDir();
  const p = patchPath();
  fs.writeFileSync(p, renderPatch(guardPluginPath), 'utf8');
  return p;
}

/** 默认控制：启用守卫 */
function defaultControl() {
  return { enabled: true, allowUntilMs: 0 };
}

/** 读取控制文件（缺失/损坏时回落到默认：启用） */
function readControl() {
  try {
    const j = JSON.parse(fs.readFileSync(controlPath(), 'utf8'));
    return { enabled: j.enabled !== false, allowUntilMs: Number(j.allowUntilMs) || 0 };
  } catch {
    return defaultControl();
  }
}

/**
 * 写入控制文件。
 * @param {{enabled?: boolean, allowUntilMs?: number}} patch
 */
function writeControl(patch = {}) {
  ensureDir();
  const cur = readControl();
  const next = {
    enabled: patch.enabled === undefined ? cur.enabled : patch.enabled !== false,
    allowUntilMs:
      patch.allowUntilMs === undefined ? cur.allowUntilMs : Number(patch.allowUntilMs) || 0,
  };
  fs.writeFileSync(controlPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 首次运行时确保控制文件存在 */
function ensureControlFile() {
  if (!fs.existsSync(controlPath())) {
    ensureDir();
    fs.writeFileSync(controlPath(), JSON.stringify(defaultControl(), null, 2), 'utf8');
  }
  return readControl();
}

/** 读取守卫心跳状态；无文件返回 null */
function readStatus() {
  try {
    const j = JSON.parse(fs.readFileSync(statusPath(), 'utf8'));
    if (j && j.plugin === GUARD_ROW_ID) return j;
    return null;
  } catch {
    return null;
  }
}

/**
 * 心跳是否新鲜（守卫确实在运行）。
 * @param {object|null} status
 * @param {number} [now]
 */
function isGuardAlive(status, now = Date.now()) {
  if (!status || typeof status.updatedAt !== 'number') return false;
  return now - status.updatedAt < HEARTBEAT_STALE_MS;
}

/** 删除心跳（重启 harness 前调用，避免把上一次的旧心跳当成存活） */
function clearStatus() {
  try {
    fs.rmSync(statusPath(), { force: true });
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 状态组装（推送渲染进程 / 刷新菜单）
// ---------------------------------------------------------------------------

const peakLib = require('./peak');

/**
 * 组装峰谷状态包：全部为可序列化的普通值（IPC 可传）。
 * @param {{harnessRunning?: string, now?: number}} [ctx]
 */
function buildPayload(ctx = {}) {
  const now = typeof ctx.now === 'number' ? ctx.now : Date.now();
  const s = peakLib.getPeakState(new Date(now));
  const control = readControl();
  const alive = isGuardAlive(readStatus(), now);
  const allowed = control.allowUntilMs > now;

  const prices = Object.entries(peakLib.PRICING).map(([id, m]) => {
    const cur = s.isPeak ? m.output.peak : m.output.offpeak;
    const other = s.isPeak ? m.output.offpeak : m.output.peak;
    return {
      label: (id === 'deepseek-flash' ? 'Flash' : 'V4-Pro') + ' 输出',
      value:
        '$' + cur + ' / 1M' + (s.isPeak ? '（空闲 $' + other + '）' : '（高峰 $' + other + '）'),
    };
  });

  return {
    isPeak: s.isPeak,
    period: s.period,
    periodLabel: s.periodLabel,
    discountLabel: s.discountLabel,
    nextChangeAt: s.nextChangeAt ? s.nextChangeAt.getTime() : null,
    countdown: s.countdown,
    countdownText: s.isPeak
      ? '距离进入空闲时段（5 折）还有 ' + s.countdown
      : '距离进入高峰时段还有 ' + s.countdown,
    nextPeriodLabel: s.nextPeriodLabel,
    localPeakWindows: s.localPeakWindows,
    utcPeakWindows: s.utcPeakWindows,
    timeZone: s.timeZone,
    rule: s.rule,
    prices,
    guardEnabled: control.enabled,
    allowed,
    allowUntilMs: control.allowUntilMs,
    guardAlive: alive,
    /** 综合判定：此刻消息是否会被拒绝（守卫开关 + 时段 + 临时放行） */
    blocked: s.isPeak && control.enabled && !allowed,
    harnessRunning: ctx.harnessRunning || 'unknown',
  };
}

module.exports = {
  GUARD_ROW_ID,
  GUARD_FILE,
  HEARTBEAT_STALE_MS,
  getDesktopDir,
  patchPath,
  controlPath,
  statusPath,
  resolveGuardPluginPath,
  renderPatch,
  writePatchFile,
  defaultControl,
  readControl,
  writeControl,
  ensureControlFile,
  readStatus,
  isGuardAlive,
  clearStatus,
  buildPayload,
  yamlQuote,
};
