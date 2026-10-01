/**
 * lib 模块集成测试（纯 Node，无需 Electron GUI）
 * 覆盖：版本检测、token 解析、服务启动与认证、余额、API Key
 * 用法: node scripts/test-lib.js
 *
 * 注意：ensureHarnessRunning() 现在**不会**结束占用端口的进程（端口冲突时
 * 改为退让到空闲端口）。但若本机 3080 上已有服务，本测试仍会被跳过启动环节，
 * 以免在开发机上多起一个 harness 实例。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const harness = require('../src/lib/harness');
const balance = require('../src/lib/balance');

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.log(`  FAIL: ${name}`);
  }
}

(async () => {
  console.log('=== lib 模块集成测试 ===');

  // 1. 常量
  assert(harness.HARNESS_URL === 'http://127.0.0.1:3080', `HARNESS_URL = ${harness.HARNESS_URL}`);

  // 2. dsh 入口定位
  const entry = harness.findDshEntry();
  assert(!!entry, 'dsh 入口定位');
  if (entry) console.log(`       -> ${entry.script || entry.command}`);

  // 3. dsh 版本检测（0.1.5 升级能力）
  const localVer = harness.getLocalDshVersion();
  assert(!!localVer, `本地 dsh 版本: ${localVer || '未知'}`);

  // 4. 版本比较逻辑
  assert(harness.isNewerVersion('0.1.5-rc.1', '0.1.1-rc.2') === true, '版本比较 0.1.5-rc.1 > 0.1.1-rc.2');
  assert(harness.isNewerVersion('0.1.5-rc.2', '0.1.5-rc.1') === true, '版本比较 rc 序号');
  assert(harness.isNewerVersion('0.1.1-rc.2', '0.1.5-rc.1') === false, '版本比较反向');

  // 5. 代理环境变量（0.1.5 特性）
  const proxyKeys = Object.keys(harness.getProxyEnv());
  assert(Array.isArray(proxyKeys), `代理环境解析（当前 ${proxyKeys.length} 项）`);

  // 6. API Key 解析
  const key = balance.resolveApiKey();
  assert(!!key, 'API Key 读取');
  if (key) console.log(`       -> ${key.slice(0, 6)}...${key.slice(-4)}`);

  // 6a. 应用配置文件优先级
  const tmpConfig = path.join(os.tmpdir(), `dsh-desktop-test-config-${Date.now()}.json`);
  fs.writeFileSync(tmpConfig, JSON.stringify({ apiKey: 'sk-test-app-config-key-1234567890' }), 'utf8');
  const oldEnv = process.env.DSH_DESKTOP_CONFIG;
  process.env.DSH_DESKTOP_CONFIG = tmpConfig;
  assert(balance.resolveApiKey() === 'sk-test-app-config-key-1234567890', '应用配置文件 API Key 解析');
  if (oldEnv === undefined) delete process.env.DSH_DESKTOP_CONFIG;
  else process.env.DSH_DESKTOP_CONFIG = oldEnv;
  fs.unlinkSync(tmpConfig);

  // 7. 余额数据
  const data = await balance.getBalanceData(key);
  assert(data.ok === true, '余额数据获取');
  if (data.ok) {
    assert(Array.isArray(data.balances) && data.balances.length > 0, 'balances 数组非空');
    assert(typeof data.fetchedAt === 'number', 'fetchedAt 时间戳');
    const cny = data.balances.find((b) => b.currency === 'CNY');
    if (cny) console.log(`       -> CNY 总余额 ¥${cny.total_balance}`);
  } else {
    console.log(`       -> 失败原因: ${data.error}`);
  }

  // 8. 未配置 Key 错误分支
  const noKey = await balance.getBalanceData(null);
  assert(noKey.ok === false && noKey.error.includes('DEEPSEEK_API_KEY'), '无 Key 错误分支');

  // 9. 【核心】服务启动 + 认证 token 捕获（dsh 0.1.5+ 关键路径）
  console.log('\n--- 服务启动与认证（核心）---');
  //
  // 开发机上 3080 往往已有服务在跑。ensureHarnessRunning() 已改为「端口冲突时
  // 退让到空闲端口、绝不结束他人进程」，但那会在本机多起一个 harness 实例，
  // 对纯测试而言是多余副作用，因此端口被占时跳过这一段。
  const portBusy = await harness.isPortOpen(harness.HARNESS_HOST, harness.HARNESS_PORT);
  const wouldSpawnDuplicate =
    portBusy && !harness.getAuthUrl() && !(await harness.isHarnessUsable());

  if (wouldSpawnDuplicate) {
    console.log('  SKIP: 端口 ' + harness.HARNESS_PORT + ' 已被既有服务占用。');
    console.log('        跳过启动环节，避免在开发机上多起一个 harness 实例。');
    console.log('        如需完整测试，请设置其它 DSH_DESKTOP_PORT。');
    assert(true, 'ensureHarnessRunning 已跳过（不在开发机上另起实例）');
  } else {
    const result = await harness.ensureHarnessRunning();
    assert(!!result, 'ensureHarnessRunning 返回结果');
    assert(typeof result.started === 'boolean', `started 标志: ${result.started}`);
    assert(typeof result.reused === 'boolean', `reused 标志: ${result.reused}`);

    const alive = await harness.isHarnessReady();
    assert(alive === true, '服务已监听（任意 HTTP 响应）');

    const authUrl = harness.getAuthUrl();
    if (authUrl) {
      assert(authUrl.includes('token='), `认证 token URL 已捕获`);
      console.log(`       -> ${authUrl.slice(0, 60)}...`);
    } else {
      // 旧版 dsh 无需认证也算通过
      const usable = await harness.isHarnessUsable();
      assert(usable === true, '无需 token（旧版或已认证，直接可访问）');
    }
  }

  // getLoadUrl 应返回 token URL（若有）或裸 URL
  const loadUrl = harness.getLoadUrl();
  assert(!!loadUrl && loadUrl.startsWith('http://127.0.0.1:3080'), `可加载 URL: ${loadUrl.slice(0, 50)}`);

  console.log(`\n结果: ${passed} passed, ${failed} failed`);

  // 等待 socket 关闭，避免 Node 在 Windows 上退出时的 uv 断言
  await new Promise((r) => setTimeout(r, 500));
  process.exit(failed > 0 ? 1 : 0);
})();
