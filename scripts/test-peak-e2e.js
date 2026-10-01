/**
 * 峰谷守卫端到端验证：
 *   生成 patch → 用真实 dsh 启动 harness → 确认守卫插件被加载并写出心跳
 *
 * 使用隔离的临时 DSH_HOME 与桌面数据目录，不会触碰用户真实数据。
 * 用法: node scripts/test-peak-e2e.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const SANDBOX = path.join(os.tmpdir(), 'dsh-peak-e2e-' + process.pid);
const HOME = path.join(SANDBOX, 'dsh-home');
const DATA = path.join(SANDBOX, 'desktop-data');

// peak-desktop 通过该变量决定文件落点
process.env.DSH_DESKTOP_DATA_DIR = DATA;

const pd = require('../src/lib/peak-desktop.js');

/** 定位全局安装的 dsh */
function findDsh() {
  let root = null;
  try {
    root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
  } catch {
    /* 忽略 */
  }
  const candidates = [
    root && path.join(root, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(
      process.env.APPDATA || '',
      'npm',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js'
    ),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let child = null;
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

  try {
    console.log('=== 峰谷守卫端到端验证 ===\n');

    const dshBin = findDsh();
    if (!dshBin) {
      console.log('未找到全局安装的 dsh，跳过端到端验证');
      process.exit(0);
    }
    console.log('dsh: ' + dshBin);

    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.mkdirSync(HOME, { recursive: true });
    fs.mkdirSync(DATA, { recursive: true });

    const guardPath = pd.resolveGuardPluginPath({ appDir: __dirname });
    assert.ok(guardPath, '未找到守卫插件');

    // ---- 生成 patch 与控制文件（与桌面端启动时完全一致）----
    const patchFile = pd.writePatchFile(guardPath);
    const controlFile = pd.controlPath();
    const statusFile = pd.statusPath();
    pd.writeControl({ enabled: true, allowUntilMs: 0 });
    pd.clearStatus();

    console.log('patch : ' + patchFile);
    console.log('control: ' + controlFile);
    console.log('status : ' + statusFile + '\n');

    check('patch 文件已生成', () => assert.ok(fs.existsSync(patchFile)));
    check('启动前无心跳（避免沿用旧状态）', () => assert.strictEqual(pd.readStatus(), null));

    // ---- 启动真实 harness ----
    const args = ['web', '--patch', patchFile, '--port', '0', '--no-open'];
    console.log('启动: node bin.js ' + args.join(' '));

    let out = '';
    child = spawn(process.execPath, [dshBin, ...args], {
      env: {
        ...process.env,
        DSH_HOME: HOME,
        DSH_DESKTOP_PEAK_CONTROL: controlFile,
        DSH_DESKTOP_PEAK_STATUS: statusFile,
      },
      cwd: SANDBOX,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));

    // ---- 等待心跳出现 ----
    const deadline = Date.now() + 60000;
    let status = null;
    while (Date.now() < deadline) {
      status = pd.readStatus();
      if (status) break;
      if (child.exitCode !== null) break;
      await sleep(700);
    }

    // ---- 等监听地址打印（心跳可能先于 stdout 到达）----
    const urlDeadline = Date.now() + 20000;
    while (Date.now() < urlDeadline && !/http:\/\/127\.0\.0\.1:\d+/.test(out)) {
      if (child.exitCode !== null) break;
      await sleep(500);
    }

    console.log('\n启动输出: ' + (out.trim().split('\n')[0] || '(无)') + '\n');

    check('守卫插件已被 harness 加载（心跳文件出现）', () => assert.ok(status, '未出现心跳'));
    if (status) {
      console.log('  心跳内容: ' + JSON.stringify(status));
      check('心跳声明自己是峰谷守卫插件', () =>
        assert.strictEqual(status.plugin, pd.GUARD_ROW_ID));
      check('心跳带 harness 进程 pid', () => assert.ok(status.pid > 0));
      check('心跳带权威时段状态 isPeak', () =>
        assert.strictEqual(typeof status.isPeak, 'boolean'));
      check('心跳新鲜 → isGuardAlive 为真（保护确实生效）', () =>
        assert.strictEqual(pd.isGuardAlive(status), true));
    }
    check('harness 打印了监听地址', () => assert.ok(/http:\/\/127\.0\.0\.1:\d+/.test(out), out));
    check('harness 未报 unknown option --patch（参数顺序正确）', () =>
      assert.ok(!/unknown option/i.test(out), out));

    // ---- 实时核对：心跳报告的时段与本地计算是否一致 ----
    const peakState = require('../src/lib/peak.js').getPeakState();
    console.log('\n本地时段计算: ' + peakState.periodLabel + ' / 心跳: ' + (status ? (status.isPeak ? '高峰' : '空闲') : '无'));
    if (status) {
      check('心跳时段与桌面端本地计算一致', () =>
        assert.strictEqual(status.isPeak, peakState.isPeak));
    }

    console.log('\n=== 结果 ===');
    console.log('通过 ' + passed + ' / ' + (passed + failed));
    if (failed > 0) {
      console.log('\n失败项:');
      for (const f of failures) console.log('  - ' + f);
    } else {
      console.log('全部通过 ✓');
    }
  } catch (e) {
    console.error('端到端验证异常: ' + (e && e.stack ? e.stack : e));
    failed++;
  } finally {
    if (child && child.pid) {
      try {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        });
      } catch {
        try {
          child.kill();
        } catch {
          /* 忽略 */
        }
      }
    }
    await sleep(500);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    delete process.env.DSH_DESKTOP_DATA_DIR;
  }
  process.exit(failed > 0 ? 1 : 0);
})();
