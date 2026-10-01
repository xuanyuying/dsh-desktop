/**
 * 峰谷时段逻辑测试（对应官方规则：
 * 高峰 = 周一至周五 01:00–04:00 与 06:00–10:00 UTC，其余为空闲时段）
 *
 * 用法: node scripts/test-peak.js
 */
'use strict';

// 必须在 require peak.js 之前设置，便于验证本机时间换算
process.env.TZ = 'Asia/Shanghai';

const assert = require('node:assert');
const peak = require('../src/lib/peak.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    failures.push(name + ' → ' + e.message);
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

/** UTC 时间构造 */
const U = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi));

// 找一个确定的周一作为基准（不依赖手工推算星期）
function firstMondayUTC(year, month) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
const MON = firstMondayUTC(2026, 9); // 2026-09 的第一个周一
const mon = (h, mi) => U(MON.getUTCFullYear(), MON.getUTCMonth() + 1, MON.getUTCDate(), h, mi);
const dayOffset = (n, h, mi) => {
  const d = new Date(MON.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return U(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi);
};
const SAT = dayOffset(5, 0, 0);
const SUN = dayOffset(6, 0, 0);
const FRI = dayOffset(4, 0, 0);

console.log('=== 峰谷时段逻辑测试 ===\n');
console.log('基准周一 (UTC): ' + MON.toISOString().slice(0, 10) + '  周几=' + MON.getUTCDay());
console.log('');

console.log('[1] 官方高峰窗口边界（周一）');
check('00:59 → 空闲', () => assert.strictEqual(peak.isPeakAt(mon(0, 59)), false));
check('01:00 → 高峰（窗口起点含）', () => assert.strictEqual(peak.isPeakAt(mon(1, 0)), true));
check('03:59 → 高峰', () => assert.strictEqual(peak.isPeakAt(mon(3, 59)), true));
check('04:00 → 空闲（窗口终点不含）', () => assert.strictEqual(peak.isPeakAt(mon(4, 0)), false));
check('05:59 → 空闲', () => assert.strictEqual(peak.isPeakAt(mon(5, 59)), false));
check('06:00 → 高峰', () => assert.strictEqual(peak.isPeakAt(mon(6, 0)), true));
check('09:59 → 高峰', () => assert.strictEqual(peak.isPeakAt(mon(9, 59)), true));
check('10:00 → 空闲', () => assert.strictEqual(peak.isPeakAt(mon(10, 0)), false));
check('12:00 → 空闲', () => assert.strictEqual(peak.isPeakAt(mon(12, 0)), false));
check('23:59 → 空闲', () => assert.strictEqual(peak.isPeakAt(mon(23, 59)), false));

console.log('\n[2] 周末全天空闲');
check('周六 02:00 → 空闲（本应是高峰窗口）', () => assert.strictEqual(peak.isPeakAt(SAT), false));
check('周六 08:00 → 空闲', () => assert.strictEqual(peak.isPeakAt(dayOffset(5, 8, 0)), false));
check('周日 02:00 → 空闲', () => assert.strictEqual(peak.isPeakAt(SUN), false));
check('周日 23:59 → 空闲', () => assert.strictEqual(peak.isPeakAt(dayOffset(6, 23, 59)), false));
check('周六确实是周六', () => assert.strictEqual(SAT.getUTCDay(), 6));
check('周日确实是周日', () => assert.strictEqual(SUN.getUTCDay(), 0));

console.log('\n[3] 时段切换点');
check('周一 00:59 的下一次切换 = 周一 01:00', () => {
  const n = peak.nextTransition(mon(0, 59));
  assert.strictEqual(n.toISOString(), mon(1, 0).toISOString());
});
check('周一 03:00 的下一次切换 = 周一 04:00', () => {
  const n = peak.nextTransition(mon(3, 0));
  assert.strictEqual(n.toISOString(), mon(4, 0).toISOString());
});
check('周一 04:00 的下一次切换 = 周一 06:00', () => {
  const n = peak.nextTransition(mon(4, 0));
  assert.strictEqual(n.toISOString(), mon(6, 0).toISOString());
});
check('周一 10:00 的下一次切换 = 周二 01:00', () => {
  const n = peak.nextTransition(mon(10, 0));
  assert.strictEqual(n.toISOString(), dayOffset(1, 1, 0).toISOString());
});
check('周五 10:00 的下一次切换 = 下周一 01:00（跨周末）', () => {
  const n = peak.nextTransition(dayOffset(4, 10, 0));
  assert.strictEqual(n.toISOString(), dayOffset(7, 1, 0).toISOString());
});
check('周六 00:00 的下一次切换 = 下周一 01:00', () => {
  const n = peak.nextTransition(SAT);
  assert.strictEqual(n.toISOString(), dayOffset(7, 1, 0).toISOString());
});
check('周日 12:00 的下一次切换 = 下周一 01:00', () => {
  const n = peak.nextTransition(dayOffset(6, 12, 0));
  assert.strictEqual(n.toISOString(), dayOffset(7, 1, 0).toISOString());
});
check('周五确实是周五', () => assert.strictEqual(FRI.getUTCDay(), 5));

console.log('\n[4] 状态对象与倒计时');
check('高峰时 isPeak=true 且 label 为高峰时段', () => {
  const s = peak.getPeakState(mon(2, 0));
  assert.strictEqual(s.isPeak, true);
  assert.strictEqual(s.period, 'peak');
  assert.strictEqual(s.periodLabel, '高峰时段');
  assert.strictEqual(s.discountLabel, '标准价');
  assert.strictEqual(s.nextPeriodLabel, '空闲时段');
});
check('空闲时折扣为 5 折', () => {
  const s = peak.getPeakState(mon(5, 0));
  assert.strictEqual(s.isPeak, false);
  assert.strictEqual(s.discountLabel, '5 折');
  assert.strictEqual(s.nextPeriodLabel, '高峰时段');
});
check('周一 03:00 距切换 1 小时', () => {
  const s = peak.getPeakState(mon(3, 0));
  assert.strictEqual(s.msUntilChange, 60 * 60 * 1000);
  assert.strictEqual(s.countdown, '1 小时');
});
check('周一 02:30 倒计时 1 小时 30 分', () => {
  const s = peak.getPeakState(mon(2, 30));
  assert.strictEqual(s.countdown, '1 小时 30 分');
});
check('周一 00:30 倒计时 30 分', () => {
  const s = peak.getPeakState(mon(0, 30));
  assert.strictEqual(s.countdown, '30 分');
});
check('倒计时格式化：秒级', () => {
  assert.strictEqual(peak.formatDuration(30 * 1000), '不足 1 分');
});
check('倒计时格式化：0/负值', () => {
  assert.strictEqual(peak.formatDuration(0), '即将切换');
  assert.strictEqual(peak.formatDuration(-5), '即将切换');
});

console.log('\n[5] 本机时间换算（TZ=' + process.env.TZ + '）');
check('时区已生效为 Asia/Shanghai', () => {
  const off = new Date(mon(0, 0)).getTimezoneOffset();
  assert.strictEqual(off, -480, '实际偏移分钟=' + off);
});
check('本机高峰窗口 = 09:00–12:00 与 14:00–18:00', () => {
  const w = peak.getLocalPeakWindows(mon(0, 0));
  assert.deepStrictEqual(w, ['09:00–12:00', '14:00–18:00']);
});
check('状态对象带本机窗口', () => {
  const s = peak.getPeakState(mon(0, 0));
  assert.deepStrictEqual(s.localPeakWindows, ['09:00–12:00', '14:00–18:00']);
  assert.ok(s.rule.includes('01:00–04:00'));
});

console.log('\n[6] 官方价目表');
check('空闲价恰为高峰价一半', () => {
  for (const [id, m] of Object.entries(peak.PRICING)) {
    for (const k of ['inputCacheHit', 'inputCacheMiss', 'output']) {
      assert.strictEqual(
        m[k].offpeak * 2,
        m[k].peak,
        id + '.' + k + ' 非半价: ' + m[k].offpeak + ' vs ' + m[k].peak
      );
    }
  }
});
check('flash 输出价 = 0.6 / 1.2', () => {
  assert.strictEqual(peak.PRICING['deepseek-flash'].output.offpeak, 0.6);
  assert.strictEqual(peak.PRICING['deepseek-flash'].output.peak, 1.2);
});
check('v4-pro 缓存未命中 = 0.66 / 1.32', () => {
  assert.strictEqual(peak.PRICING['deepseek-v4-pro'].inputCacheMiss.offpeak, 0.66);
  assert.strictEqual(peak.PRICING['deepseek-v4-pro'].inputCacheMiss.peak, 1.32);
});

console.log('\n[7] describeState 摘要');
check('摘要包含时段、折扣与倒计时', () => {
  const d = peak.describeState(mon(3, 0));
  assert.ok(d.includes('高峰时段'), d);
  assert.ok(d.includes('标准价'), d);
  assert.ok(d.includes('1 小时'), d);
  assert.ok(d.includes('空闲时段'), d);
});

console.log('\n=== 结果 ===');
console.log('通过 ' + passed + ' / ' + (passed + failed));
if (failed > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');
