/**
 * 峰谷功能集成测试（不启动 harness）：
 *  - dsh 启动参数顺序（--patch 必须在 app 参数之前）
 *  - 生成的 patch 覆盖层是否为合法的 insert 结构
 *  - 守卫插件定位、控制/状态文件读写与失败回落
 *
 * 用法: node scripts/test-peak-integration.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离的桌面数据目录与端口（必须在 require harness.js 之前设置：
// 该模块在加载时就读取这两个环境变量）
const SANDBOX = path.join(os.tmpdir(), 'dsh-peak-int-' + process.pid);
process.env.DSH_DESKTOP_DATA_DIR = SANDBOX;
process.env.DSH_DESKTOP_PORT = '3199';

const harness = require('../src/lib/harness.js');
const pd = require('../src/lib/peak-desktop.js');
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

/** 尝试加载 js-yaml（来自 dsh 安装），用于校验生成的 YAML */
function loadYaml() {
  const candidates = [
    path.join(
      process.env.APPDATA || '',
      'npm',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'node_modules',
      'js-yaml'
    ),
    'js-yaml',
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {
      /* 继续 */
    }
  }
  return null;
}
const yaml = loadYaml();

console.log('=== 峰谷功能集成测试 ===\n');

console.log('[1] dsh 启动参数顺序');
check('node+bin.js 形式：--patch 出现在 --port 之前', () => {
  const args = harness.buildWebArgs(
    { command: 'node', script: 'C:\\dsh\\lib\\bin.js' },
    ['C:\\tmp\\p.yml']
  );
  assert.deepStrictEqual(args, [
    'C:\\dsh\\lib\\bin.js',
    'web',
    '--patch',
    'C:\\tmp\\p.yml',
    '--port',
    '3199',
    '--no-open',
  ]);
});
check('dsh.cmd 形式：--patch 出现在 --port 之前', () => {
  const args = harness.buildWebArgs({ command: 'dsh.cmd' }, ['C:\\tmp\\p.yml']);
  assert.deepStrictEqual(args, [
    'web',
    '--patch',
    'C:\\tmp\\p.yml',
    '--port',
    '3199',
    '--no-open',
  ]);
});
check('位置约束：--patch 下标 < --port 下标', () => {
  const args = harness.buildWebArgs({ command: 'dsh.cmd' }, ['a.yml', 'b.yml']);
  assert.ok(args.indexOf('--patch') < args.indexOf('--port'));
});
check('无 patch 时参数退化为原样', () => {
  assert.deepStrictEqual(harness.buildWebArgs({ command: 'dsh.cmd' }, []), [
    'web',
    '--port',
    '3199',
    '--no-open',
  ]);
});
check('setExtraPatches 过滤空值且不共享外部数组', () => {
  const src = ['x.yml', null, '', undefined, 'y.yml'];
  harness.setExtraPatches(src);
  const args = harness.buildWebArgs({ command: 'dsh.cmd' });
  assert.strictEqual(args.filter((a) => a === '--patch').length, 2);
  assert.ok(args.includes('x.yml') && args.includes('y.yml'));
  harness.setExtraPatches([]);
});

console.log('\n[2] 守卫插件定位');
const guardPath = pd.resolveGuardPluginPath({ appDir: __dirname });
check('能定位到随应用分发的 peak-guard.mjs', () => {
  assert.ok(guardPath, '未找到守卫插件');
  assert.ok(guardPath.endsWith('peak-guard.mjs'), guardPath);
});
check('指向的文件真实存在', () => assert.ok(fs.existsSync(guardPath)));
check('未打包时也能通过 isPackaged=false 定位', () => {
  assert.ok(pd.resolveGuardPluginPath({ isPackaged: false, appDir: __dirname }));
});

console.log('\n[3] patch 覆盖层生成');
const rendered = pd.renderPatch(guardPath);
check('含 insert 关键字（新增顶层行的唯一方式）', () => assert.ok(rendered.includes('insert:')));
check('不含裸 id 行（那种写法不会新增行）', () => {
  // 顶层若直接是 "- id:" 就会被当作"覆盖已存在的行"
  assert.ok(!/^-\s+id:/m.test(rendered), '出现了裸 - id: 行');
});
check('引用了正确的插件 id', () => assert.ok(rendered.includes(pd.GUARD_ROW_ID)));
check('name 使用 file:// URL（Windows 盘符路径必需）', () => {
  assert.ok(rendered.includes('file:///'), rendered);
});
if (yaml) {
  check('YAML 可解析且结构为 [{insert:[{id,name}]}]', () => {
    const doc = yaml.load(rendered);
    assert.ok(Array.isArray(doc), '顶层不是数组');
    assert.strictEqual(doc.length, 1);
    assert.ok(Array.isArray(doc[0].insert), 'insert 不是数组');
    assert.strictEqual(doc[0].insert[0].id, pd.GUARD_ROW_ID);
    assert.ok(doc[0].insert[0].name.startsWith('file:///'));
    // 这正是 dsh applyEntryPatches 里 `if (insert) { if (id) ... else data.push(...insert) }` 分支
    assert.strictEqual(doc[0].id, undefined, 'insert 行不应带 id');
  });
  check('路径含空格/中文时 YAML 与 URL 仍正确', () => {
    const weird = path.join(os.tmpdir(), 'a b', '中文 目录', 'peak-guard.mjs');
    const doc = yaml.load(pd.renderPatch(weird));
    const url = doc[0].insert[0].name;
    assert.ok(url.startsWith('file:///'), url);
    assert.ok(!url.includes(' '), 'file URL 中的空格应被百分号编码: ' + url);
    // 用 URL 反解回路径应与原路径一致
    const back = require('node:url').fileURLToPath(url);
    assert.strictEqual(path.resolve(back), path.resolve(weird));
  });
} else {
  console.log('  (跳过 YAML 结构断言：未找到 js-yaml)');
}
check('writePatchFile 落盘并可再次读取', () => {
  const p = pd.writePatchFile(guardPath);
  assert.ok(fs.existsSync(p));
  assert.strictEqual(fs.readFileSync(p, 'utf8'), rendered);
  assert.strictEqual(p, pd.patchPath());
});

console.log('\n[4] 控制文件');
check('首次 ensureControlFile 创建默认值（启用守卫）', () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  const c = pd.ensureControlFile();
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.allowUntilMs, 0);
});
check('writeControl 局部更新不影响其它字段', () => {
  pd.writeControl({ enabled: false });
  assert.strictEqual(pd.readControl().enabled, false);
  assert.strictEqual(pd.readControl().allowUntilMs, 0);
  pd.writeControl({ allowUntilMs: 123456 });
  assert.strictEqual(pd.readControl().enabled, false);
  assert.strictEqual(pd.readControl().allowUntilMs, 123456);
});
check('控制文件损坏 → 回落到默认启用', () => {
  fs.writeFileSync(pd.controlPath(), 'not json at all', 'utf8');
  const c = pd.readControl();
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.allowUntilMs, 0);
});
check('控制文件缺失 → 回落到默认启用', () => {
  fs.rmSync(pd.controlPath(), { force: true });
  assert.strictEqual(pd.readControl().enabled, true);
});

console.log('\n[5] 心跳状态与存活判定');
check('无状态文件 → readStatus 为 null，alive=false', () => {
  pd.clearStatus();
  assert.strictEqual(pd.readStatus(), null);
  assert.strictEqual(pd.isGuardAlive(pd.readStatus()), false);
});
check('新鲜心跳 → alive=true', () => {
  fs.mkdirSync(SANDBOX, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(
    pd.statusPath(),
    JSON.stringify({ plugin: pd.GUARD_ROW_ID, pid: 1, updatedAt: now, isPeak: false }),
    'utf8'
  );
  assert.strictEqual(pd.isGuardAlive(pd.readStatus(), now), true);
});
check('过期心跳 → alive=false（守卫已不在运行）', () => {
  const now = Date.now();
  const stale = now - pd.HEARTBEAT_STALE_MS - 1;
  fs.writeFileSync(
    pd.statusPath(),
    JSON.stringify({ plugin: pd.GUARD_ROW_ID, updatedAt: stale }),
    'utf8'
  );
  assert.strictEqual(pd.isGuardAlive(pd.readStatus(), now), false);
});
check('别的插件写的状态文件不被误认', () => {
  fs.writeFileSync(pd.statusPath(), JSON.stringify({ plugin: 'other', updatedAt: Date.now() }), 'utf8');
  assert.strictEqual(pd.readStatus(), null);
});

console.log('\n[6] 与时段逻辑联动');
const MON = (() => {
  const d = new Date(Date.UTC(2026, 8, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
})();
check('临时放行时长（至本时段结束）取值为下次切换点', () => {
  const atPeak = new Date(Date.UTC(2026, 8, MON.getUTCDate(), 2, 0));
  const s = peak.getPeakState(atPeak);
  assert.ok(s.msUntilChange > 0);
  const until = atPeak.getTime() + s.msUntilChange;
  assert.strictEqual(new Date(until).getUTCHours(), 4, '应放行至 04:00 UTC 窗口结束');
});

console.log('\n[7] 状态组装（buildPayload）');
const atPeakMs = Date.UTC(2026, 8, MON.getUTCDate(), 2, 0); // 周一 02:00 UTC → 高峰
const atOffpeakMs = Date.UTC(2026, 8, MON.getUTCDate(), 5, 0); // 周一 05:00 UTC → 空闲

function setHeartbeat(updatedAt) {
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.writeFileSync(
    pd.statusPath(),
    JSON.stringify({ plugin: pd.GUARD_ROW_ID, pid: 1, updatedAt }),
    'utf8'
  );
}

check('空闲时段：blocked=false，价格为 5 折', () => {
  pd.writeControl({ enabled: true, allowUntilMs: 0 });
  setHeartbeat(atOffpeakMs);
  const p = pd.buildPayload({ now: atOffpeakMs, harnessRunning: 'self' });
  assert.strictEqual(p.isPeak, false);
  assert.strictEqual(p.period, 'offpeak');
  assert.strictEqual(p.discountLabel, '5 折');
  assert.strictEqual(p.blocked, false);
  assert.strictEqual(p.guardAlive, true);
  assert.strictEqual(p.harnessRunning, 'self');
  const flash = p.prices.find((x) => x.label.startsWith('Flash'));
  assert.ok(flash.value.includes('$0.6'), flash.value);
  assert.ok(flash.value.includes('$1.2'), flash.value);
});

check('高峰 + 守卫开启 + 未放行：blocked=true，价格为标准价', () => {
  pd.writeControl({ enabled: true, allowUntilMs: 0 });
  setHeartbeat(atPeakMs);
  const p = pd.buildPayload({ now: atPeakMs });
  assert.strictEqual(p.isPeak, true);
  assert.strictEqual(p.periodLabel, '高峰时段');
  assert.strictEqual(p.discountLabel, '标准价');
  assert.strictEqual(p.blocked, true);
  assert.ok(p.countdownText.includes('空闲时段'), p.countdownText);
  const pro = p.prices.find((x) => x.label.startsWith('V4-Pro'));
  assert.ok(pro.value.includes('$3.96'), pro.value);
  assert.ok(pro.value.includes('$1.98'), pro.value);
});

check('高峰 + 临时放行中：blocked=false 且 allowed=true', () => {
  pd.writeControl({ enabled: true, allowUntilMs: atPeakMs + 60 * 1000 });
  setHeartbeat(atPeakMs);
  const p = pd.buildPayload({ now: atPeakMs });
  assert.strictEqual(p.isPeak, true);
  assert.strictEqual(p.allowed, true);
  assert.strictEqual(p.blocked, false);
});

check('高峰 + 守卫关闭：blocked=false', () => {
  pd.writeControl({ enabled: false, allowUntilMs: 0 });
  setHeartbeat(atPeakMs);
  const p = pd.buildPayload({ now: atPeakMs });
  assert.strictEqual(p.guardEnabled, false);
  assert.strictEqual(p.blocked, false);
});

check('心跳过期：guardAlive=false（守卫未生效必须可被发现）', () => {
  pd.writeControl({ enabled: true, allowUntilMs: 0 });
  setHeartbeat(atPeakMs - pd.HEARTBEAT_STALE_MS - 1000);
  const p = pd.buildPayload({ now: atPeakMs });
  assert.strictEqual(p.guardAlive, false);
  // 心跳失效时 blocked 仍为 true，但 UI 必须据此告警而非假装受保护
  assert.strictEqual(p.blocked, true);
});

check('payload 可 JSON 序列化（IPC 要求普通值）', () => {
  pd.writeControl({ enabled: true, allowUntilMs: 0 });
  setHeartbeat(atPeakMs);
  const p = pd.buildPayload({ now: atPeakMs });
  assert.strictEqual(typeof p.nextChangeAt, 'number');
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(p)));
});

// 清理
fs.rmSync(SANDBOX, { recursive: true, force: true });
delete process.env.DSH_DESKTOP_DATA_DIR;

console.log('\n=== 结果 ===');
console.log('通过 ' + passed + ' / ' + (passed + failed));
if (failed > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');
