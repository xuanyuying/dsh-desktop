/**
 * 冒烟测试：验证核心逻辑（不依赖 Electron GUI）
 * 用法: node scripts/smoke-test.js
 */
'use strict';

const harness = require('../src/lib/harness');
const balance = require('../src/lib/balance');

(async () => {
  console.log('=== DSH Desktop 冒烟测试 ===');

  // 1. Harness 服务
  const portOpen = await harness.isPortOpen(harness.HARNESS_HOST, harness.HARNESS_PORT);
  const ready = await harness.isHarnessReady();
  console.log(`[1] Harness 端口 ${harness.HARNESS_PORT}: ${portOpen ? '已监听' : '未监听'}`);
  console.log(`[2] Harness HTTP 就绪: ${ready ? 'OK' : 'FAIL'}`);

  // 2. dsh 入口
  const entry = harness.findDshEntry();
  console.log(`[3] dsh 入口: ${entry ? entry.script || entry.command : '未找到'}`);

  // 3. API Key
  const key = balance.resolveApiKey();
  console.log(`[4] API Key: ${key ? `${key.slice(0, 6)}...${key.slice(-4)} (已配置)` : '未配置'}`);

  // 4. 余额 API
  if (key) {
    const data = await balance.getBalanceData(key);
    if (data.ok) {
      console.log('[5] 余额 API: OK');
      console.log(
        `    余额: ${data.balances
          .map((b) => `${b.currency} ${b.total_balance}`)
          .join(', ')} (可用: ${data.isAvailable})`
      );
    } else {
      console.log(`[5] 余额 API: FAIL - ${data.error}`);
    }
  } else {
    console.log('[5] 余额 API: 跳过（无 Key）');
  }

  console.log('=== 测试完成 ===');
  await new Promise((r) => setTimeout(r, 300));
})();
