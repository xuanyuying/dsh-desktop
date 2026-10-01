/**
 * DSH Desktop 峰谷守卫（Cordis Host 插件，由 DSH Desktop 通过 --patch insert 注入）
 *
 * 作用：在 DeepSeek 官方「高峰时段」拒绝一切流式模型调用。
 *
 * 强制点：`llm/stream` 是包裹每一次流式模型调用的 waterfall
 * （签名见 dsh-llm：'llm/stream'(this, options, next)）。
 * 不调用 next() 即短路，adapter 永远不会被触达 —— 请求不会发出，
 * 因此不产生任何 token 消耗（而非"发出后再取消"）。
 *
 * 官方规则（权威来源 https://api-docs.deepseek.com/quick_start/pricing）：
 *   "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday
 *    (all other hours are off-peak). Off-peak rates are half of the peak rates."
 *
 * 与 src/lib/peak.js 保持同一套规则；此处独立实现以保证插件自包含
 * （插件必须能在未加载任何桌面端代码的情况下独立判定）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'dsh-desktop-peak-guard';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const PEAK_WINDOWS_UTC = [
  { start: 60, end: 240 }, // 01:00–04:00 UTC
  { start: 360, end: 600 }, // 06:00–10:00 UTC
];
const HEARTBEAT_MS = 30 * 1000;

/** 该时刻是否处于高峰时段（周一至周五的 UTC 窗口内） */
function isPeakAt(date) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return PEAK_WINDOWS_UTC.some((w) => minutes >= w.start && minutes < w.end);
}

/** 下一个时段切换点 */
function nextTransition(from) {
  const base = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (let d = 0; d <= 8; d++) {
    const dayStart = base + d * DAY;
    const day = new Date(dayStart).getUTCDay();
    if (day === 0 || day === 6) continue;
    for (const w of PEAK_WINDOWS_UTC) {
      for (const m of [w.start, w.end]) {
        const t = dayStart + m * MINUTE;
        if (t > from.getTime()) return new Date(t);
      }
    }
  }
  return null;
}

/** 毫秒 → 「X 小时 Y 分」 */
function formatDuration(ms) {
  if (!(ms > 0)) return '即将切换';
  const totalMin = Math.floor(ms / MINUTE);
  if (totalMin < 1) return '不足 1 分';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return m + ' 分';
  if (m === 0) return h + ' 小时';
  return h + ' 小时 ' + m + ' 分';
}

/**
 * 控制文件路径（桌面端 → 插件：{ enabled, allowUntilMs }）。
 * 与状态文件严格分离：若共用同一文件，周期心跳会覆盖掉用户的开关。
 */
function controlPath() {
  return (
    process.env.DSH_DESKTOP_PEAK_CONTROL || join(homedir(), '.dsh-desktop', 'peak-control.json')
  );
}

/** 状态文件路径（插件 → 桌面端：心跳与权威时段状态） */
function statusPath() {
  return (
    process.env.DSH_DESKTOP_PEAK_STATUS || join(homedir(), '.dsh-desktop', 'peak-status.json')
  );
}

/**
 * 读取桌面端的控制开关。
 * 缺省（文件缺失/损坏）为「启用守卫」，保证失败时偏向不消耗 token。
 */
function readControl() {
  try {
    const j = JSON.parse(readFileSync(controlPath(), 'utf8'));
    return {
      enabled: j.enabled !== false,
      allowUntilMs: Number(j.allowUntilMs) || 0,
    };
  } catch {
    return { enabled: true, allowUntilMs: 0 };
  }
}

/**
 * 写出心跳（DSH Desktop 据此确认守卫真的加载了这一进程）。
 * 时钟统一取自 Date.now()，与拦截判定同源。
 */
function writeHeartbeat(extra, nowMs = Date.now()) {
  const p = statusPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const now = new Date(nowMs);
    const next = nextTransition(now);
    writeFileSync(
      p,
      JSON.stringify(
        {
          plugin: name,
          pid: process.pid,
          updatedAt: nowMs,
          isPeak: isPeakAt(now),
          nextChangeAt: next ? next.getTime() : null,
          ...extra,
        },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    /* 心跳失败不影响拦截本身 */
  }
}

export function apply(ctx) {
  writeHeartbeat({ phase: 'applied' });

  ctx.on(
    'llm/stream',
    (options, next) => {
      const now = Date.now();
      const control = readControl();
      if (!control.enabled) return next();
      if (control.allowUntilMs > now) return next();

      const date = new Date(now);
      if (!isPeakAt(date)) return next();

      const nextAt = nextTransition(date);
      const left = nextAt ? formatDuration(nextAt.getTime() - now) : '稍后';
      const model = options && options.model ? String(options.model) : '未知模型';

      try {
        ctx.logger.warn(
          '[peak-guard] 已阻止高峰时段模型调用 model=' +
            model +
            '，距离空闲时段还有 ' +
            left,
        );
      } catch {
        /* 日志失败不影响拦截 */
      }

      const err = new Error(
        'DSH Desktop 峰谷守卫：当前为 DeepSeek 高峰时段，已阻止本次模型调用以确保零 token 消耗。\n' +
          '距离进入空闲时段（5 折）还有 ' + left + '。\n' +
          '如需临时放行，请在 DSH Desktop 菜单「峰谷时段」中开启「临时放行」。',
      );
      err.code = 'dsh-desktop/peak-blocked';
      throw err;
    },
    { global: true, prepend: true },
  );

  // 周期性刷新心跳与状态，供桌面端显示权威状态
  const timer = setInterval(() => writeHeartbeat({ phase: 'alive' }), HEARTBEAT_MS);
  if (timer.unref) timer.unref();
  ctx.effect(() => () => clearInterval(timer), 'peak-guard.heartbeat()');
}
