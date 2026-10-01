/**
 * lib 模块集成测试（纯 Node，无需 Electron GUI）
 * 覆盖：版本检测、token 解析、服务启动与认证、余额、API Key
 *
 * 用法: node scripts/test-lib.js
 *
 * 自包含：使用**临时 DSH_HOME + 独立端口**，不会碰开发机上正在运行的
 * 3080 会话，也不会写真实的 ~/.dsh。结束时自动清理。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupHarnessTestEnv, hasDsh } = require('./lib/test-env');

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
  console.log('=== lib 模块集成测试（隔离环境）===\n');

  // 必须在 require harness 之前建立隔离环境
  const env = await setupHarnessTestEnv();
  console.log(`临时 DSH_HOME: ${env.home}`);
  console.log(`独立端口     : ${env.port}\n`);

  const harness = require('../src/lib/harness');
  const balance = require('../src/lib/balance');

  try {
    // 1. 常量（端口来自隔离环境，而非默认 3080）
    assert(
      harness.HARNESS_URL === `http://127.0.0.1:${env.port}`,
      `HARNESS_URL = ${harness.HARNESS_URL}`
    );
    assert(
      harness.HARNESS_PORT === env.port,
      `HARNESS_PORT 可动态变化: ${harness.HARNESS_PORT}`
    );
    assert(
      harness.getHarnessUrl(1234) === 'http://127.0.0.1:1234',
      'getHarnessUrl 接受显式端口'
    );

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

    // 6. API Key 解析（隔离环境下只可能来自环境变量，因此这里直接测解析器）
    const tmpConfig = path.join(env.dir, 'config.json');
    fs.writeFileSync(tmpConfig, JSON.stringify({ apiKey: 'sk-test-app-config-key-1234567890' }), 'utf8');
    const oldEnv = process.env.DSH_DESKTOP_CONFIG;
    process.env.DSH_DESKTOP_CONFIG = tmpConfig;
    assert(balance.resolveApiKey() === 'sk-test-app-config-key-1234567890', '应用配置文件 API Key 解析');
    assert(balance.describeApiKeySource() === 'config:plaintext', '能识别明文来源');
    if (oldEnv === undefined) delete process.env.DSH_DESKTOP_CONFIG;
    else process.env.DSH_DESKTOP_CONFIG = oldEnv;

    // 6a. 加密字段优先于明文，且解密失败时安全回落
    fs.writeFileSync(
      tmpConfig,
      JSON.stringify({ apiKeyEncrypted: Buffer.from('garbage').toString('base64') }),
      'utf8'
    );
    process.env.DSH_DESKTOP_CONFIG = tmpConfig;
    balance.setDecryptAdapter(() => {
      throw new Error('boom');
    });
    assert(balance.resolveApiKey() === null, '加密字段解不开时不崩溃、回落到 null');
    balance.setDecryptAdapter((buf) => 'sk-decrypted-' + buf.toString('utf8'));
    assert(
      balance.resolveApiKey() === 'sk-decrypted-garbage',
      '注入解密器后能读出加密 Key'
    );
    assert(balance.describeApiKeySource() === 'config:encrypted', '能识别加密来源');
    balance.setDecryptAdapter(null);
    if (oldEnv === undefined) delete process.env.DSH_DESKTOP_CONFIG;
    else process.env.DSH_DESKTOP_CONFIG = oldEnv;

    // 6b. 首次运行创建的配置文件只含真实字段（JSON 没有注释，
    //     带 `_` 前缀的"说明字段"会被当成真实配置）
    const created = balance.ensureConfigFile();
    assert(created.created === true, '首次运行创建配置文件');
    const cfg = JSON.parse(fs.readFileSync(balance.configFilePath(), 'utf8'));
    const badKeys = Object.keys(cfg).filter((k) => !balance.CONFIG_KEYS.includes(k));
    assert(badKeys.length === 0, '配置文件不含伪字段: ' + (badKeys.join(', ') || '无'));
    const second = balance.ensureConfigFile();
    assert(second.created === false, '已存在时不重复创建');

    // 7. 未配置 Key 错误分支
    const noKey = await balance.getBalanceData(null);
    assert(noKey.ok === false && noKey.error.includes('DEEPSEEK_API_KEY'), '无 Key 错误分支');

    // 8. 真实余额接口（需要真实 Key；没有则跳过，不让 CI/离线环境失败）
    const key = process.env.DEEPSEEK_API_KEY;
    if (key) {
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
    } else {
      console.log('  SKIP: 未设置 DEEPSEEK_API_KEY，跳过真实余额接口');
      assert(true, '余额接口（已跳过）');
    }

    // 9. 【核心】服务启动 + 认证 token 捕获（dsh 0.1.5+ 关键路径）
    console.log('\n--- 服务启动与认证（核心）---');
    if (!hasDsh()) {
      console.log('  SKIP: 本机未安装 dsh，跳过启动环节');
      assert(true, '服务启动（已跳过：未安装 dsh）');
    } else {
      const result = await harness.ensureHarnessRunning();
      assert(!!result, 'ensureHarnessRunning 返回结果');
      assert(result.port === env.port, `在隔离端口上启动: ${result.port}`);
      assert(result.fellBackFrom === null, '首选端口空闲时不应发生退让');

      const alive = await harness.isHarnessReady();
      assert(alive === true, '服务已监听（任意 HTTP 响应）');

      const authUrl = harness.getAuthUrl();
      if (authUrl) {
        assert(authUrl.includes('token='), '认证 token URL 已捕获');
        assert(authUrl.includes(':' + env.port + '/'), 'token URL 指向隔离端口');
        console.log(`       -> ${authUrl.slice(0, 60)}...`);
      } else {
        const usable = await harness.isHarnessUsable();
        assert(usable === true, '无需 token（旧版或已认证，直接可访问）');
      }

      // 服务用完后由 cleanup 清理（stopHarnessIfOwned）
      assert(harness.startedByUs === true, '记录为「由本进程启动」，退出时会清理');
    }

    // 10. getLoadUrl 应返回 token URL（若有）或裸 URL
    const loadUrl = harness.getLoadUrl();
    assert(
      !!loadUrl && loadUrl.startsWith(`http://127.0.0.1:${env.port}`),
      `可加载 URL: ${loadUrl.slice(0, 50)}`
    );
  } catch (e) {
    failed++;
    console.log('  FAIL: 测试异常 -> ' + (e && e.message));
  } finally {
    await env.cleanup();
  }

  console.log(`\n结果: ${passed} passed, ${failed} failed`);
  await new Promise((r) => setTimeout(r, 300));
  process.exit(failed > 0 ? 1 : 0);
})();
