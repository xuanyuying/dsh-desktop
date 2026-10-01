/**
 * token 复用性与页面资源验证。
 *
 * 自包含：临时 DSH_HOME + 独立端口，不碰开发机上的 3080 会话。
 * 用法: node scripts/test-token-reuse.js
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

function probe(url, headers = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.get(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, headers, timeout: 8000 },
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
  console.log('=== token 复用性与页面资源验证（隔离环境）===\n');

  const env = await setupHarnessTestEnv();
  console.log('临时 DSH_HOME: ' + env.home);
  console.log('独立端口     : ' + env.port + '\n');

  const harness = require('../src/lib/harness');

  try {
    if (!hasDsh()) {
      console.log('SKIP: 本机未安装 dsh');
      await env.cleanup();
      process.exit(0);
    }

    const result = await harness.ensureHarnessRunning();
    assert(result.port === env.port, '在隔离端口上启动: ' + result.port);
    const tokenUrl = result.authUrl;
    if (!tokenUrl) {
      console.log('未捕获 token（旧版 dsh？）');
      await env.cleanup();
      process.exit(0);
    }
    console.log('token URL: ' + tokenUrl.slice(0, 60) + '...\n');

    const base = harness.HARNESS_URL;

    // 1. 第一次访问 token URL
    console.log('[1] 第一次访问 token URL');
    const r1 = await probe(tokenUrl);
    assert(r1.status === 303, '第一次返回 303: ' + r1.status);
    assert(!!r1.headers['set-cookie'], '第一次拿到 cookie');

    // 2. 第二次访问同一 token URL（重载策略取决于是否一次性）
    console.log('\n[2] 第二次访问同一 token URL');
    const r2 = await probe(tokenUrl);
    const reusable = r2.status === 303;
    assert(r2.status === 303 || r2.status === 401, '第二次状态可预期: ' + r2.status);
    console.log('    → token ' + (reusable ? '可重复使用' : '一次性（第二次 ' + r2.status + '）'));

    // 3. 用 cookie 访问裸 URL —— 这条路径必须始终成立（重载时就靠它）
    console.log('\n[3] 用 cookie 访问裸 URL');
    const cookie = (r1.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    const r3 = await probe(base + '/', { Cookie: cookie });
    assert(r3.status === 200, '带 cookie 返回 200: ' + r3.status);
    assert(r3.body.includes('id="root"'), '页面含 React root');

    // 4. 无 cookie 裸访问应被拒绝（认证机制存在）
    const r4 = await probe(base + '/');
    assert(r4.status === 401, '无 cookie 返回 401: ' + r4.status);

    // 5. 前端资源可获取
    console.log('\n[4] 前端资源');
    const m = r3.body.match(/src="(\/assets\/index-[^"]+\.js)"/);
    if (m) {
      const js = await probe(base + m[1]);
      assert(js.status === 200 && js.body.length > 10000, '入口 JS 可获取 (' + js.body.length + ' 字节)');
    } else {
      assert(true, '页面未使用 /assets/index-*.js 命名（跳过）');
    }

    // 6. 重载策略结论
    console.log('\n=== 结论 ===');
    console.log(
      '重载策略：' +
        (reusable
          ? 'token 可重复用，重载可直接用 token URL'
          : 'token 一次性，重载必须用 cookie + 裸 URL（已认证后）')
    );
    assert(
      reusable || r3.status === 200,
      '两种情况下都存在可用的重载路径'
    );

    console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed');
  } catch (e) {
    failed++;
    console.log('  FAIL: 测试异常 -> ' + (e && e.message));
  } finally {
    await env.cleanup();
  }

  process.exit(failed > 0 ? 1 : 0);
})();
