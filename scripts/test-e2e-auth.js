/**
 * 端到端验证：模拟 DSH Desktop 的完整启动与认证流程
 * 1. 启动服务（捕获 token URL）
 * 2. 用 token URL 认证（303 + cookie）
 * 3. 带 cookie 访问页面（应 200 + 含 React root）
 * 用法: node scripts/test-e2e-auth.js
 *
 * 自包含：使用临时 DSH_HOME 与独立端口，不会碰开发机上正在运行的 3080 会话。
 */
'use strict';

const http = require('node:http');
const { setupHarnessTestEnv, hasDsh } = require('./lib/test-env');

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

/** 简单 HTTP 请求（返回 status/headers/body） */
function request(url, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.get(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, headers, timeout: 10000 },
      (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
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
  console.log('=== 端到端认证流程测试（隔离环境）===\n');

  const env = await setupHarnessTestEnv();
  console.log('临时 DSH_HOME: ' + env.home);
  console.log('独立端口     : ' + env.port + '\n');

  // 必须在设置好环境变量之后再 require
  const harness = require('../src/lib/harness');

  try {
    if (!hasDsh()) {
      console.log('SKIP: 本机未安装 dsh，跳过端到端认证流程');
      await env.cleanup();
      process.exit(0);
    }

    // 1. 启动服务并捕获 token
    console.log('[1] 启动 dsh web 服务');
    const result = await harness.ensureHarnessRunning();
    assert(!!result.authUrl, 'token URL 已捕获');
    const tokenUrl = result.authUrl;
    console.log('    token URL:', tokenUrl ? tokenUrl.slice(0, 55) + '...' : '(无)');

    if (!tokenUrl) {
      console.log('\n（服务可能已是旧版/无需认证，跳过认证流程）');
      await env.cleanup();
      process.exit(0);
    }

    // 2. 裸 URL 应返回 401（证明认证机制存在）
    console.log('\n[2] 验证裸 URL 需要认证');
    const bare = await request(harness.HARNESS_URL + '/');
    assert(bare.status === 401, '裸 URL 返回 401（需认证）: ' + bare.status + ' ' + JSON.stringify(bare.body.slice(0, 60)));

    // 3. token URL → 303 + cookie
    console.log('\n[3] 访问 token URL');
    const auth = await request(tokenUrl);
    assert(auth.status === 303, 'token URL 返回 303 重定向: ' + auth.status);
    const setCookie = auth.headers['set-cookie'];
    assert(!!setCookie, '获得认证 cookie');
    if (!setCookie) {
      await env.cleanup();
      process.exit(1);
    }

    // 4. 带 cookie 访问页面 → 200 + React root
    console.log('\n[4] 带 cookie 访问页面');
    const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    const page = await request(harness.HARNESS_URL + '/', { Cookie: cookie });
    assert(page.status === 200, '页面返回 200: ' + page.status);
    assert(page.body.includes('id="root"'), '页面含 React root 元素');
    assert(page.body.length > 5000, '页面内容完整 (' + page.body.length + ' 字节)');

    // 5. getLoadUrl 返回 token URL（窗口应加载它）
    console.log('\n[5] 验证 dsh 提供的加载 URL');
    assert(harness.getLoadUrl() === tokenUrl, 'getLoadUrl 返回带 token 的 URL');

    console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed');
  } catch (e) {
    failed++;
    console.log('  FAIL: 测试异常 -> ' + (e && e.message));
  } finally {
    await env.cleanup();
  }

  process.exit(failed > 0 ? 1 : 0);
})();
