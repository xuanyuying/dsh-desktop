/**
 * lib 模块集成测试（纯 Node，无需 Electron GUI）
 * 用法: node scripts/test-lib.js
 */
'use strict';

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

  // 2. 端口与 HTTP 检测
  const portOpen = await harness.isPortOpen(harness.HARNESS_HOST, harness.HARNESS_PORT);
  assert(portOpen === true, `端口 ${harness.HARNESS_PORT} 检测（当前环境应已监听）`);
  const ready = await harness.isHarnessReady();
  assert(ready === true, 'Harness HTTP 就绪检测');

  // 3. dsh 入口定位
  const entry = harness.findDshEntry();
  assert(!!entry, 'dsh 入口定位');
  if (entry) console.log(`       -> ${entry.script || entry.command}`);

  // 4. API Key（通用解析：环境变量 > 应用配置 > harness 凭据）
  const key = balance.resolveApiKey();
  assert(!!key, 'API Key 读取');
  if (key) console.log(`       -> ${key.slice(0, 6)}...${key.slice(-4)}`);

  // 4a. 应用配置文件优先级（DSH_DESKTOP_CONFIG）
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmpConfig = path.join(os.tmpdir(), `dsh-desktop-test-config-${Date.now()}.json`);
  fs.writeFileSync(tmpConfig, JSON.stringify({ apiKey: 'sk-test-app-config-key-1234567890' }), 'utf8');
  const oldEnv = process.env.DSH_DESKTOP_CONFIG;
  process.env.DSH_DESKTOP_CONFIG = tmpConfig;
  const fromAppConfig = balance.resolveApiKey();
  assert(fromAppConfig === 'sk-test-app-config-key-1234567890', '应用配置文件 API Key 解析');
  if (oldEnv === undefined) delete process.env.DSH_DESKTOP_CONFIG;
  else process.env.DSH_DESKTOP_CONFIG = oldEnv;
  fs.unlinkSync(tmpConfig);

  // 5. 余额数据（getBalanceData 返回 UI 消费格式）
  const data = await balance.getBalanceData(key);
  assert(data.ok === true, '余额数据获取');
  if (data.ok) {
    assert(Array.isArray(data.balances) && data.balances.length > 0, 'balances 数组非空');
    assert(typeof data.fetchedAt === 'number', 'fetchedAt 时间戳');
    const cny = data.balances.find((b) => b.currency === 'CNY');
    if (cny) {
      assert(Number(cny.total_balance) >= 0, `CNY 余额有效: ${cny.total_balance}`);
      console.log(`       -> CNY 总余额 ¥${cny.total_balance}`);
    }
  } else {
    console.log(`       -> 失败原因: ${data.error}`);
  }

  // 6. 未配置 Key 的错误分支
  const noKey = await balance.getBalanceData(null);
  assert(noKey.ok === false && noKey.error.includes('DEEPSEEK_API_KEY'), '无 Key 错误分支');

  // 7. 服务状态（复用外部服务场景）
  const { started } = await harness.ensureHarnessRunning();
  assert(started === false, '复用已运行服务（当前环境 3080 已监听）');

  console.log(`\n结果: ${passed} passed, ${failed} failed`);

  // 等待所有 socket 关闭，避免 Node 在 Windows 上退出时的 uv 断言
  await new Promise((r) => setTimeout(r, 500));
  process.exit(failed > 0 ? 1 : 0);
})();
