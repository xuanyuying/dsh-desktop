/**
 * 峰谷守卫插件测试：验证它在高峰时段确实短路 llm/stream（不调用 next），
 * 以及开关、临时放行、心跳文件等行为。
 *
 * 用法: node scripts/test-peak-guard.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PLUGIN = path.join(__dirname, '..', 'resources', 'peak-guard.mjs');
const SANDBOX = path.join(os.tmpdir(), 'dsh-peak-guard-test-' + process.pid);
const CONTROL = path.join(SANDBOX, 'peak-control.json');
const STATUS = path.join(SANDBOX, 'peak-status.json');

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

const U = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi);
const MON = (() => {
  const d = new Date(Date.UTC(2026, 8, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
})();
/** 基准周的某天某时刻（UTC 毫秒） */
const at = (dayOffset, h, mi) =>
  U(MON.getUTCFullYear(), MON.getUTCMonth() + 1, MON.getUTCDate() + dayOffset, h, mi);

const PEAK_MS = at(0, 2, 0); // 周一 02:00 UTC —— 高峰
const OFFPEAK_MS = at(0, 5, 0); // 周一 05:00 UTC —— 空闲
const WEEKEND_MS = at(5, 2, 0); // 周六 02:00 UTC —— 空闲

const realNow = Date.now;

/** 建立一个假的 Cordis ctx，捕获 llm/stream 监听器 */
function makeCtx() {
  const listeners = [];
  const disposers = [];
  return {
    listeners,
    disposers,
    ctx: {
      on(evt, fn, opts) {
        listeners.push({ evt, fn, opts });
      },
      logger: { warn() {}, info() {} },
      effect(fn) {
        const d = fn();
        if (typeof d === 'function') disposers.push(d);
        return d;
      },
    },
  };
}

/** 写控制文件 */
function writeState(obj) {
  fs.mkdirSync(SANDBOX, { recursive: true });
  if (obj === null) {
    fs.rmSync(CONTROL, { force: true });
    return;
  }
  fs.writeFileSync(CONTROL, JSON.stringify(obj), 'utf8');
}

/** 读状态/心跳文件 */
function readStatus() {
  return JSON.parse(fs.readFileSync(STATUS, 'utf8'));
}

(async () => {
  console.log('=== 峰谷守卫插件测试 ===\n');
  console.log('插件: ' + PLUGIN + '\n');

  fs.rmSync(SANDBOX, { recursive: true, force: true });
  process.env.DSH_DESKTOP_PEAK_CONTROL = CONTROL;
  process.env.DSH_DESKTOP_PEAK_STATUS = STATUS;

  const mod = await import(pathToFileURL(PLUGIN).href);

  check('导出 name 为 dsh-desktop-peak-guard', () =>
    assert.strictEqual(mod.name, 'dsh-desktop-peak-guard'));
  check('导出 apply 函数', () => assert.strictEqual(typeof mod.apply, 'function'));

  // ---- 安装一次，拿到监听器 ----
  writeState({ enabled: true, allowUntilMs: 0 });
  const fake = makeCtx();
  mod.apply(fake.ctx);

  const llm = fake.listeners.find((l) => l.evt === 'llm/stream');
  check('注册了 llm/stream 监听器', () => assert.ok(llm, '未找到 llm/stream 监听器'));
  check('监听器为 global + prepend（在其它监听器之前、跨作用域生效）', () => {
    assert.strictEqual(llm.opts.global, true);
    assert.strictEqual(llm.opts.prepend, true);
  });

  let nextCalls = 0;
  const next = () => {
    nextCalls++;
    return { called: true };
  };
  const opts = { provider: 'deepseek', model: 'deepseek-flash' };

  console.log('\n[1] 高峰时段必须短路');
  check('周一 02:00 UTC → 抛错且不调用 next()', () => {
    Date.now = () => PEAK_MS;
    nextCalls = 0;
    assert.throws(() => llm.fn(opts, next), /高峰时段/);
    assert.strictEqual(nextCalls, 0, 'next() 被调用了，会消耗 token！');
  });
  check('错误带稳定 code，便于识别', () => {
    Date.now = () => PEAK_MS;
    try {
      llm.fn(opts, next);
      assert.fail('未抛错');
    } catch (e) {
      assert.strictEqual(e.code, 'dsh-desktop/peak-blocked');
    }
  });
  check('错误信息含倒计时与放行指引', () => {
    Date.now = () => PEAK_MS;
    try {
      llm.fn(opts, next);
      assert.fail('未抛错');
    } catch (e) {
      // 周一 02:00 → 下一次切换是 04:00，共 2 小时
      assert.ok(e.message.includes('2 小时'), e.message);
      assert.ok(e.message.includes('临时放行'), e.message);
    }
  });

  console.log('\n[2] 空闲时段必须放行');
  check('周一 05:00 UTC → 调用 next()', () => {
    Date.now = () => OFFPEAK_MS;
    nextCalls = 0;
    const r = llm.fn(opts, next);
    assert.strictEqual(nextCalls, 1);
    assert.deepStrictEqual(r, { called: true });
  });
  check('周六 02:00 UTC → 放行（周末全天空闲）', () => {
    Date.now = () => WEEKEND_MS;
    nextCalls = 0;
    llm.fn(opts, next);
    assert.strictEqual(nextCalls, 1);
  });

  console.log('\n[3] 控制开关');
  check('enabled=false → 高峰也放行', () => {
    writeState({ enabled: false, allowUntilMs: 0 });
    Date.now = () => PEAK_MS;
    nextCalls = 0;
    llm.fn(opts, next);
    assert.strictEqual(nextCalls, 1);
  });
  check('allowUntilMs 未过期 → 高峰也放行', () => {
    writeState({ enabled: true, allowUntilMs: PEAK_MS + 60 * 1000 });
    Date.now = () => PEAK_MS;
    nextCalls = 0;
    llm.fn(opts, next);
    assert.strictEqual(nextCalls, 1);
  });
  check('allowUntilMs 已过期 → 恢复拦截', () => {
    writeState({ enabled: true, allowUntilMs: PEAK_MS - 60 * 1000 });
    Date.now = () => PEAK_MS;
    nextCalls = 0;
    assert.throws(() => llm.fn(opts, next), /高峰时段/);
    assert.strictEqual(nextCalls, 0);
  });
  check('控制文件缺失 → 默认启用守卫（失败偏向零消耗）', () => {
    writeState(null);
    Date.now = () => PEAK_MS;
    nextCalls = 0;
    assert.throws(() => llm.fn(opts, next), /高峰时段/);
    assert.strictEqual(nextCalls, 0);
  });
  check('控制文件损坏 → 默认启用守卫', () => {
    fs.mkdirSync(SANDBOX, { recursive: true });
    fs.writeFileSync(CONTROL, '{ 这不是 JSON', 'utf8');
    Date.now = () => PEAK_MS;
    nextCalls = 0;
    assert.throws(() => llm.fn(opts, next), /高峰时段/);
    assert.strictEqual(nextCalls, 0);
  });

  console.log('\n[4] 心跳文件（桌面端据此确认守卫确实加载）');
  writeState({ enabled: true, allowUntilMs: 0 });
  const fake2 = makeCtx();
  Date.now = () => PEAK_MS;
  mod.apply(fake2.ctx);
  check('apply 写出心跳且含 plugin/pid/updatedAt', () => {
    const hb = readStatus();
    assert.strictEqual(hb.plugin, 'dsh-desktop-peak-guard');
    assert.strictEqual(typeof hb.pid, 'number');
    assert.ok(hb.updatedAt > 0);
  });
  check('心跳报告权威时段状态（高峰）', () => {
    const hb = readStatus();
    assert.strictEqual(hb.isPeak, true);
    assert.ok(typeof hb.nextChangeAt === 'number');
  });
  check('心跳不覆盖控制文件（开关不会被打回默认值）', () => {
    writeState({ enabled: false, allowUntilMs: 12345 });
    const f4 = makeCtx();
    mod.apply(f4.ctx);
    const ctrl = JSON.parse(fs.readFileSync(CONTROL, 'utf8'));
    assert.strictEqual(ctrl.enabled, false, '控制文件被心跳覆盖了！');
    assert.strictEqual(ctrl.allowUntilMs, 12345);
    for (const d of f4.disposers) {
      try {
        d();
      } catch {
        /* 忽略 */
      }
    }
  });
  check('空闲时心跳报告 isPeak=false', () => {
    writeState({ enabled: true, allowUntilMs: 0 });
    const f3 = makeCtx();
    Date.now = () => OFFPEAK_MS;
    mod.apply(f3.ctx);
    const hb = readStatus();
    assert.strictEqual(hb.isPeak, false);
  });
  check('ctx.effect 注册了清理函数（避免定时器泄漏）', () => {
    assert.ok(fake2.disposers.length >= 1, '没有清理函数');
  });

  // ---- 清理 ----
  Date.now = realNow;
  for (const d of [...fake.disposers, ...fake2.disposers]) {
    try {
      d();
    } catch {
      /* 忽略 */
    }
  }
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  delete process.env.DSH_DESKTOP_PEAK_CONTROL;
  delete process.env.DSH_DESKTOP_PEAK_STATUS;

  console.log('\n=== 结果 ===');
  console.log('通过 ' + passed + ' / ' + (passed + failed));
  if (failed > 0) {
    console.log('\n失败项:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('全部通过 ✓');
})().catch((e) => {
  Date.now = realNow;
  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  } catch {}
  console.error('测试异常: ' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
