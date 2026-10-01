/**
 * 孤儿服务清理验证：模拟用户遇到的"端口冲突"场景
 *
 * 场景：3080 被一个外部/遗留的 dsh web 占用（需认证但本应用无 token），
 *       DSH Desktop 应自动清理它并启动自己的服务（捕获新 token）。
 *
 * 用法: node scripts/test-orphan-cleanup.js
 *
 * ⚠ 破坏性测试：它会 taskkill 占用 3080 的 dsh web 进程。如果那是用户正在
 *   使用的 harness（甚至承载当前对话的那个），运行本脚本会直接中断会话。
 *   因此必须显式设置 DSH_DESKTOP_TEST_DESTRUCTIVE=1 才会执行。
 */
'use strict';

if (process.env.DSH_DESKTOP_TEST_DESTRUCTIVE !== '1') {
  console.log('=== 孤儿服务清理验证 ===');
  console.log('已跳过：这是破坏性测试，会终止占用 3080 的 dsh web 进程。');
  console.log('若确认该端口上没有正在使用的会话，请这样运行：');
  console.log('  $env:DSH_DESKTOP_TEST_DESTRUCTIVE=1; node scripts/test-orphan-cleanup.js');
  process.exit(0);
}

const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const harness = require('../src/lib/harness');

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) {
    passed++;
    console.log('  PASS: ' + name);
  } else {
    failed++;
    console.log('  FAIL: ' + name);
  }
}

function probe(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.get(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: 5000 },
      (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => resolve({ status: r.statusCode, body }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, error: 'timeout' });
    });
  });
}

(async () => {
  console.log('=== 孤儿服务清理验证（端口冲突场景）===\n');

  // 确保端口空闲
  if (await harness.isPortOpen('127.0.0.1', 3080)) {
    console.log('端口 3080 已被占用，先清理...');
    harness.killDshWebOnPort(3080);
    await new Promise((r) => setTimeout(r, 2500));
  }

  // 1. 用"外部方式"启动一个孤儿 dsh web（不经过 harness，因此 harness 无其 token）
  console.log('[1] 启动孤儿 dsh web（模拟外部/遗留服务）');
  const dshScript = 'C:/Users/29130/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const orphan = spawn(process.execPath, [dshScript, 'web', '--port', '3080', '--no-open'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let orphanOut = '';
  orphan.stdout.on('data', (d) => (orphanOut += d.toString()));
  orphan.stderr.on('data', (d) => (orphanOut += d.toString()));

  // 等孤儿服务就绪
  let orphanReady = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 800));
    if (await harness.isPortOpen('127.0.0.1', 3080)) {
      orphanReady = true;
      break;
    }
  }
  assert(orphanReady, '孤儿服务已启动并占用 3080');
  assert(harness.getAuthUrl() === null, 'harness 无该服务的 token（authUrl 为 null）');

  const bare = await probe('http://127.0.0.1:3080/');
  assert(bare.status === 401, '孤儿服务需认证（401）: ' + bare.status);

  // 2. 调用 ensureHarnessRunning —— 应检测端口冲突、清理孤儿、启动自己的服务
  console.log('\n[2] 调用 ensureHarnessRunning（应自动处理冲突）');
  const result = await harness.ensureHarnessRunning();
  assert(!!result, 'ensureHarnessRunning 返回');
  assert(!!result.authUrl, '冲突处理后捕获到新 token（服务已由本应用接管）');
  if (result.authUrl) {
    console.log('    新 token URL: ' + result.authUrl.slice(0, 55) + '...');
  }

  // 3. 验证孤儿进程已被终止
  await new Promise((r) => setTimeout(r, 1000));
  const orphanAlive = (() => {
    try {
      const out = execSync(`tasklist /FI "PID eq ${orphan.pid}" /NH`, { encoding: 'utf8', windowsHide: true });
      return out.includes(String(orphan.pid));
    } catch {
      return false;
    }
  })();
  assert(!orphanAlive, '孤儿进程已被清理（PID ' + orphan.pid + '）');

  // 4. 新服务可用性
  const alive = await harness.isHarnessReady();
  assert(alive === true, '新服务运行中');

  // 5. 用新 token 走认证流程
  if (result.authUrl) {
    const auth = await probe(result.authUrl);
    assert(auth.status === 303, '新服务 token 认证可用（303）: ' + auth.status);
  }

  console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed');

  // 清理
  try {
    harness.stopHarnessIfOwned();
  } catch {}
  try {
    execSync('taskkill /PID ' + orphan.pid + ' /T /F', { stdio: 'ignore' });
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
  process.exit(failed > 0 ? 1 : 0);
})();
