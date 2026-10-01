/**
 * DeepSeek 官方峰谷计价时段（纯函数模块，不依赖 Electron，便于单测）。
 *
 * 权威来源：https://api-docs.deepseek.com/quick_start/pricing
 * 原文："Off-peak rates are half of the peak rates. Peak hours are
 * 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday
 * (all other hours are off-peak)."
 *
 * 即：高峰 = 周一至周五 01:00–04:00 与 06:00–10:00 UTC；
 * 其余时间（含整个周末）为空闲时段，空闲价 = 高峰价 5 折。
 *
 * 换算北京时间（UTC+8）：高峰 = 周一至周五 09:00–12:00 与 14:00–18:00。
 */
'use strict';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** UTC 高峰窗口（当日分钟数，左闭右开），仅周一至周五生效 */
const PEAK_WINDOWS_UTC = [
  { start: 60, end: 240 }, // 01:00–04:00 UTC
  { start: 360, end: 600 }, // 06:00–10:00 UTC
];

/** 官方价目表（美元 / 每 100 万 token） */
const PRICING = {
  'deepseek-flash': {
    name: 'DeepSeek-V4.1-Flash',
    inputCacheHit: { peak: 0.006, offpeak: 0.003 },
    inputCacheMiss: { peak: 0.3, offpeak: 0.15 },
    output: { peak: 1.2, offpeak: 0.6 },
  },
  'deepseek-v4-pro': {
    name: 'DeepSeek-V4-Pro-0813',
    inputCacheHit: { peak: 0.044, offpeak: 0.022 },
    inputCacheMiss: { peak: 1.32, offpeak: 0.66 },
    output: { peak: 3.96, offpeak: 1.98 },
  },
};

/** 该时刻是否处于高峰时段 */
function isPeakAt(date) {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false; // 周末全天空闲
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return PEAK_WINDOWS_UTC.some((w) => minutes >= w.start && minutes < w.end);
}

/**
 * 从 `from` 之后的下一个时段切换点（UTC 高峰窗口的四个边界中最近的未来一个）。
 * 周末没有边界，因此周五 10:00 之后的下一个切换点是周一 01:00。
 * @returns {Date|null}
 */
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

/** 两位补零 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本机时间 HH:MM */
function localHM(date) {
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

/** UTC 时间 HH:MM */
function utcHM(date) {
  return pad2(date.getUTCHours()) + ':' + pad2(date.getUTCMinutes());
}

/**
 * 把官方 UTC 窗口换算成本机时间窗口（去重）。
 * 跨时区/夏令时下逐日换算，因此结果始终是当前时区的真实区间。
 * @returns {string[]} 形如 ['09:00–12:00', '14:00–18:00']
 */
function getLocalPeakWindows(now = new Date(), days = 7) {
  const seen = new Set();
  const out = [];
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  for (let d = 0; d < days; d++) {
    const dayStart = base + d * DAY;
    const day = new Date(dayStart).getUTCDay();
    if (day === 0 || day === 6) continue;
    for (const w of PEAK_WINDOWS_UTC) {
      const a = new Date(dayStart + w.start * MINUTE);
      const b = new Date(dayStart + w.end * MINUTE);
      const key = localHM(a) + '–' + localHM(b);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }
  return out;
}

/** 把毫秒格式化为「X 小时 Y 分」/「Y 分」/「不足 1 分」 */
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

/** 本机时区标识 */
function getTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '本机时区';
  } catch {
    return '本机时区';
  }
}

/**
 * 当前峰谷状态。
 * @param {Date} [now]
 * @returns {{
 *   isPeak: boolean, period: 'peak'|'offpeak', periodLabel: string,
 *   discountLabel: string, nextChangeAt: Date|null, msUntilChange: number,
 *   countdown: string, nextPeriodLabel: string,
 *   localPeakWindows: string[], utcPeakWindows: string, timeZone: string,
 *   rule: string
 * }}
 */
function getPeakState(now = new Date()) {
  const isPeak = isPeakAt(now);
  const next = nextTransition(now);
  const msUntilChange = next ? next.getTime() - now.getTime() : 0;
  return {
    isPeak,
    period: isPeak ? 'peak' : 'offpeak',
    periodLabel: isPeak ? '高峰时段' : '空闲时段',
    discountLabel: isPeak ? '标准价' : '5 折',
    nextChangeAt: next,
    msUntilChange,
    countdown: formatDuration(msUntilChange),
    nextPeriodLabel: isPeak ? '空闲时段' : '高峰时段',
    localPeakWindows: getLocalPeakWindows(now),
    utcPeakWindows: '01:00–04:00 / 06:00–10:00 UTC',
    timeZone: getTimeZone(),
    rule: '高峰：周一至周五 01:00–04:00 与 06:00–10:00 UTC（其余时间为空闲时段，空闲价 = 高峰价 5 折）',
  };
}

/** 供菜单/日志使用的一行摘要 */
function describeState(now = new Date()) {
  const s = getPeakState(now);
  return s.periodLabel + ' · ' + s.discountLabel + ' · ' + s.countdown + '后进入' + s.nextPeriodLabel;
}

/** 距离下一个切换点的毫秒数（用于定时器对齐） */
function msUntilNextTransition(now = new Date()) {
  const s = getPeakState(now);
  return s.msUntilChange;
}

module.exports = {
  PEAK_WINDOWS_UTC,
  PRICING,
  isPeakAt,
  nextTransition,
  getLocalPeakWindows,
  getPeakState,
  describeState,
  formatDuration,
  msUntilNextTransition,
  getTimeZone,
  localHM,
  utcHM,
};
