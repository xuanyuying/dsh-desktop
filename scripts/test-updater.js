/**
 * 自更新模块测试（版本比较 / 资源挑选 / 下载与跳转）
 * 用法: node scripts/test-updater.js
 *       加 DSH_TEST_NETWORK=1 额外校验 GitHub API 连通性
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const up = require('../src/lib/updater.js');

const SANDBOX = path.join(os.tmpdir(), 'dsh-updater-' + process.pid);

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

async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    failures.push(name + ' → ' + e.message);
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

(async () => {
  console.log('=== 自更新模块测试 ===\n');

  console.log('[1] 版本比较');
  check('1.3.1 > 1.3.0', () => assert.strictEqual(up.compareVersions('1.3.1', '1.3.0'), 1));
  check('1.3.0 < 1.3.1', () => assert.strictEqual(up.compareVersions('1.3.0', '1.3.1'), -1));
  check('相同版本为 0', () => assert.strictEqual(up.compareVersions('1.3.1', '1.3.1'), 0));
  check('忽略前缀 v', () => assert.strictEqual(up.compareVersions('v1.4.0', '1.3.9'), 1));
  check('1.10.0 > 1.9.0（按数值而非字典序）', () =>
    assert.strictEqual(up.compareVersions('1.10.0', '1.9.0'), 1));
  check('2.0.0 > 1.99.99', () => assert.strictEqual(up.compareVersions('2.0.0', '1.99.99'), 1));
  check('正式版 > 预发布版', () => assert.strictEqual(up.compareVersions('1.3.1', '1.3.1-beta.1'), 1));
  check('预发布版 < 正式版', () => assert.strictEqual(up.compareVersions('1.3.1-rc.1', '1.3.1'), -1));
  check('缺失分段按 0 补齐', () => assert.strictEqual(up.compareVersions('1.3', '1.3.0'), 0));
  check('isNewer 语义正确', () => {
    assert.strictEqual(up.isNewer('1.3.0', '1.3.1'), true);
    assert.strictEqual(up.isNewer('1.3.1', '1.3.1'), false);
    assert.strictEqual(up.isNewer('1.3.1', '1.3.0'), false);
  });
  check('异常输入不抛错', () => {
    assert.doesNotThrow(() => up.compareVersions(null, undefined));
    assert.doesNotThrow(() => up.compareVersions('', 'garbage'));
  });

  console.log('\n[2] 安装包资源挑选');
  check('优先选择 Setup 命名的 exe', () => {
    const a = up.pickInstallerAsset([
      { name: 'latest.yml', browser_download_url: 'u1' },
      { name: 'DSH Desktop Setup 1.4.0.exe', browser_download_url: 'u2' },
      { name: 'other.exe', browser_download_url: 'u3' },
    ]);
    assert.strictEqual(a.browser_download_url, 'u2');
  });
  check('忽略 blockmap', () => {
    const a = up.pickInstallerAsset([
      { name: 'DSH Desktop Setup 1.4.0.exe.blockmap', browser_download_url: 'u1' },
      { name: 'DSH Desktop Setup 1.4.0.exe', browser_download_url: 'u2' },
    ]);
    assert.strictEqual(a.browser_download_url, 'u2');
  });
  check('无 exe → null', () =>
    assert.strictEqual(up.pickInstallerAsset([{ name: 'a.zip' }]), null));
  check('assets 非数组 → null', () => assert.strictEqual(up.pickInstallerAsset(null), null));

  console.log('\n[3] release 解析');
  const releaseJson = {
    tag_name: 'v1.4.0',
    html_url: 'https://github.com/xuanyuying/dsh-desktop/releases/tag/v1.4.0',
    body: '修复若干问题',
    assets: [
      { name: 'latest.yml', browser_download_url: 'https://x/latest.yml', size: 10 },
      {
        name: 'DSH Desktop Setup 1.4.0.exe',
        browser_download_url: 'https://x/setup.exe',
        size: 1000,
      },
    ],
  };
  check('解析出版本号（去掉 v 前缀）', () =>
    assert.strictEqual(up.parseRelease(releaseJson).version, '1.4.0'));
  check('解析出安装包地址与大小', () => {
    const r = up.parseRelease(releaseJson);
    assert.strictEqual(r.installer.url, 'https://x/setup.exe');
    assert.strictEqual(r.installer.size, 1000);
  });
  check('无安装包时不报错，installer 为 null', () => {
    const r = up.parseRelease({ tag_name: 'v1.4.0', assets: [] });
    assert.strictEqual(r.installer, null);
  });
  check('notes 被截断到 4000 字符以内', () => {
    const r = up.parseRelease({ tag_name: 'v1', body: 'x'.repeat(9999) });
    assert.ok(r.notes.length <= 4000);
  });

  console.log('\n[4] 安装包落盘路径');
  check('非法文件名字符被替换', () => {
    const p = up.installerPath('/tmp', '1.0.0', 'a:b*c?.exe');
    assert.ok(!/[\\/:*?"<>|]/.test(path.basename(p)), p);
  });

  console.log('\n[5] 真实下载（本地 HTTP，含跳转）');
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });

  const payload = Buffer.from('DSH-DESKTOP-INSTALLER-PAYLOAD');
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/file' });
      res.end();
      return;
    }
    if (req.url === '/file') {
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
      return;
    }
    if (req.url === '/missing') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(500);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const dest = path.join(SANDBOX, 'dl.exe');
  let progressSeen = false;

  await checkAsync('跟随 302 跳转并完整写入文件', async () => {
    const r = await up.downloadFile(`http://127.0.0.1:${port}/redirect`, dest, {
      onProgress: () => {
        progressSeen = true;
      },
    });
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.bytes, payload.length);
    assert.strictEqual(fs.readFileSync(dest, 'utf8'), payload.toString());
  });
  await checkAsync('进度回调被触发', async () => assert.strictEqual(progressSeen, true));
  await checkAsync('404 返回失败而非写出空文件', async () => {
    const r = await up.downloadFile(`http://127.0.0.1:${port}/missing`, path.join(SANDBOX, 'x.exe'));
    assert.strictEqual(r.ok, false);
    assert.ok(/404/.test(r.error), r.error);
  });
  await checkAsync('连接失败返回失败而非抛错', async () => {
    const r = await up.downloadFile('http://127.0.0.1:1/none', path.join(SANDBOX, 'y.exe'));
    assert.strictEqual(r.ok, false);
  });
  server.close();

  if (process.env.DSH_TEST_NETWORK === '1') {
    console.log('\n[6] 网络：GitHub API 连通性');
    await checkAsync('能查到最新 release', async () => {
      const r = await up.fetchLatestRelease();
      assert.strictEqual(r.ok, true, r.error);
      assert.ok(r.release.version, '未解析出版本号');
      console.log('      → 线上最新版本: ' + r.release.version);
    });
  } else {
    console.log('\n[6] 跳过网络测试（设 DSH_TEST_NETWORK=1 启用）');
  }

  fs.rmSync(SANDBOX, { recursive: true, force: true });

  console.log('\n=== 结果 ===');
  console.log('通过 ' + passed + ' / ' + (passed + failed));
  if (failed > 0) {
    console.log('\n失败项:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('全部通过 ✓');
  process.exit(0);
})();
