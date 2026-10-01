/**
 * 打包产物预检：确保 dist 里的 app.asar 真的能跑起来。
 *
 * 检查项：
 *   1. 必需文件都在 asar 内
 *   2. asar 内每个 .js 都能通过 `node --check`（避免打包进去一个语法错误的主进程）
 *   3. extraResources 声明的文件都落在 resources/ 下
 *   4. 主进程入口与 preload 路径一致
 *
 * 用法: node scripts/preflight-package.js
 */
'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const UNPACKED = path.join(ROOT, 'dist', 'win-unpacked');
const ASAR = path.join(UNPACKED, 'resources', 'app.asar');

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

/** asar 内的路径统一成 POSIX 风格，便于比较 */
function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '');
}

console.log('=== 打包产物预检 ===\n');

if (!fs.existsSync(ASAR)) {
  console.error('未找到 ' + ASAR + '，请先运行 node scripts/build-dist.js');
  process.exit(2);
}

let asar;
try {
  asar = require('@electron/asar');
} catch {
  asar = require(path.join(ROOT, 'node_modules', '@electron', 'asar'));
}

const entries = asar.listPackage(ASAR).map(norm);
console.log('asar: ' + ASAR);
console.log('asar 内条目数: ' + entries.length + '\n');

console.log('[1] 必需文件');
const REQUIRED = [
  'package.json',
  'src/main.js',
  'src/menu.js',
  'src/preload.js',
  'src/panel-preload.js',
  'src/settings.html',
  'src/logs.html',
  'src/lib/harness.js',
  'src/lib/balance.js',
  'src/lib/peak.js',
  'src/lib/peak-desktop.js',
  'src/lib/ui-state.js',
  'src/lib/updater.js',
];
for (const f of REQUIRED) {
  check('包含 ' + f, () => assert.ok(entries.includes(f), 'asar 内没有 ' + f));
}

console.log('\n[2] asar 内 JS 语法');
// 用 extractAll 整包解出再检查：listPackage 返回的是 `\src\...` 形式，
// 与 extractFile 期望的路径约定不一致，逐个提取容易踩坑。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preflight-'));
let jsFiles = [];
const bad = [];
try {
  asar.extractAll(ASAR, tmp);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) jsFiles.push(p);
    }
  };
  walk(tmp);
  for (const f of jsFiles) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      bad.push(path.relative(tmp, f) + ' :: ' + String((e.stderr || e.message) || '').split('\n')[0]);
    }
  }
} catch (e) {
  bad.push('解包失败: ' + e.message);
}
check('全部 ' + jsFiles.length + ' 个 JS 通过 node --check', () =>
  assert.strictEqual(bad.length, 0, '\n      ' + bad.join('\n      ')));
check('解出的 JS 数量与 asar 条目一致', () => {
  const listed = entries.filter((e) => e.endsWith('.js')).length;
  assert.strictEqual(jsFiles.length, listed, '解出 ' + jsFiles.length + ' 个，列表 ' + listed + ' 个');
});
// 解出来的入口文件必须与源码一致，避免打包了旧版本
check('解出的 main.js 与源码一致', () => {
  const a = fs.readFileSync(path.join(tmp, 'src', 'main.js'));
  const b = fs.readFileSync(path.join(ROOT, 'src', 'main.js'));
  assert.ok(a.equals(b), '打包进去的 main.js 与当前源码不同（可能用了旧构建）');
});
check('解出的 preload.js 含 HUD 与主进程持久化', () => {
  const s = fs.readFileSync(path.join(tmp, 'src', 'preload.js'), 'utf8');
  assert.ok(s.includes('dsh-desktop-hud'), '缺少 HUD');
  assert.ok(s.includes("sendSync('ui:get-hud')"), 'HUD 位置未改为主进程持久化');
});
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n[3] extraResources 落盘');
let pkg = {};
try {
  pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
} catch (e) {
  check('读取 package.json', () => assert.fail(e.message));
}
const resDir = path.join(UNPACKED, 'resources');
for (const r of (pkg.build && pkg.build.extraResources) || []) {
  const to = typeof r === 'string' ? path.basename(r) : r.to || path.basename(r.from);
  check('resources/' + to + ' 存在', () => {
    const p = path.join(resDir, to);
    assert.ok(fs.existsSync(p), '缺失: ' + p);
    assert.ok(fs.statSync(p).size > 0, '文件为空: ' + p);
  });
}

console.log('\n[4] 守卫插件与主进程声明的路径一致');
check('peak-guard.mjs 可被 packaged 模式定位', () => {
  const p = path.join(resDir, 'peak-guard.mjs');
  assert.ok(fs.existsSync(p));
  // 与 peak-desktop.resolveGuardPluginPath({isPackaged:true, resourcesPath}) 的期望一致
  process.env.DSH_DESKTOP_DATA_DIR = path.join(os.tmpdir(), 'dsh-pf-' + Date.now());
  const pd = require(path.join(ROOT, 'src', 'lib', 'peak-desktop.js'));
  const found = pd.resolveGuardPluginPath({ isPackaged: true, resourcesPath: resDir });
  assert.ok(found, '未定位到守卫插件');
  assert.strictEqual(path.resolve(found), path.resolve(p));
});
check('主进程入口存在', () => {
  assert.strictEqual(pkg.main, 'src/main.js');
  assert.ok(entries.includes('src/main.js'));
});
check('asar 内不含非预期的大目录（node_modules 等）', () => {
  const junk = entries.filter((e) => e.startsWith('node_modules/') || e.startsWith('dist/'));
  assert.strictEqual(junk.length, 0, '不应打包: ' + junk.slice(0, 5).join(', '));
});

console.log('\n=== 结果 ===');
console.log('通过 ' + passed + ' / ' + (passed + failed));
if (failed > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过 ✓ 打包产物可以安装');
