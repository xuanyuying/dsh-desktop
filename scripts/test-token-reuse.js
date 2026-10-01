// 验证 token URL 的可重复使用性 + 新会话按钮存在性
//
// 说明：ensureHarnessRunning() 不再结束占用端口的进程（端口冲突时退让到空闲端口）。
const http = require('node:http');
const harness = require('../src/lib/harness');

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
  console.log('=== token 复用性与新会话按钮验证 ===\n');

  const result = await harness.ensureHarnessRunning();
  const tokenUrl = result.authUrl;
  if (!tokenUrl) {
    console.log('未捕获 token（旧版 dsh？）');
    process.exit(0);
  }
  console.log('token URL:', tokenUrl.slice(0, 60) + '...\n');

  // 1. 第一次访问 token URL
  console.log('[1] 第一次访问 token URL');
  const r1 = await probe(tokenUrl);
  console.log('    status:', r1.status, '| set-cookie:', r1.headers['set-cookie'] ? '有' : '无');

  // 2. 第二次访问同一 token URL（验证是否一次性）
  console.log('\n[2] 第二次访问同一 token URL');
  const r2 = await probe(tokenUrl);
  console.log('    status:', r2.status, '| set-cookie:', r2.headers['set-cookie'] ? '有' : '无');
  console.log('    → token', r2.status === 303 ? '可重复使用 ✓' : '一次性（第二次 ' + r2.status + '）');

  // 3. 用 cookie 访问裸 URL
  const cookie = (r1.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  console.log('\n[3] 用 cookie 访问裸 URL');
  const r3 = await probe('http://127.0.0.1:3080/', { Cookie: cookie });
  console.log('    status:', r3.status, '| 大小:', r3.body.length);

  // 4. 检查新会话按钮相关的 DOM 特征（在页面 HTML/JS 中查找）
  console.log('\n[4] 新会话按钮选择器验证（前端资源）');
  const html = r3.body;
  console.log('    页面含 root:', html.includes('id="root"') ? '是' : '否');
  // 检查入口 JS 中是否含 newSession class
  const m = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
  if (m) {
    const js = await probe('http://127.0.0.1:3080' + m[1]);
    const hasNewSession = js.body.includes('newSession');
    const hasAriaLabel = js.body.includes('新建会话') || js.body.includes('New session');
    console.log('    入口 JS 大小:', js.body.length);
    console.log('    含 newSession class:', hasNewSession ? '是' : '否');
    console.log('    含"新建会话"文案:', hasAriaLabel ? '是' : '否');
  }

  console.log('\n=== 结论 ===');
  console.log('重载策略：' + (r2.status === 303
    ? 'token 可重复用，重载可直接用 token URL'
    : 'token 一次性，重载必须用 cookie + 裸 URL（已认证后）'));

  try { harness.stopHarnessIfOwned(); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  process.exit(0);
})();
