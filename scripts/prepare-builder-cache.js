/**
 * 准备 electron-builder 构建工具缓存（幂等）
 *
 * 将 download-builder-tools.js 下载的 .7z 用已解压的 7za 解压到
 * electron-builder 期望的 hash 目录，并写入 complete 状态文件，
 * 使打包时直接命中缓存、完全离线。
 *
 * 用法: node scripts/prepare-builder-cache.js
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const cacheDir = process.env.ELECTRON_BUILDER_CACHE
  ? path.resolve(process.env.ELECTRON_BUILDER_CACHE)
  : path.join(__dirname, '..', '.builder-cache');

const MIRROR_BASE = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

const TOOLS = [
  { release: 'nsis-3.0.4.1', file: 'nsis-3.0.4.1.7z' },
  { release: 'nsis-resources-3.4.1', file: 'nsis-resources-3.4.1.7z' },
  { release: 'winCodeSign-2.6.0', file: 'winCodeSign-2.6.0.7z' },
];

// 与 electron-builder hashUrlSafe 相同（djb2）
function hashUrlSafe(input, length = 5) {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  hash >>>= 0;
  const out = hash.toString(36);
  return out.length >= length ? out.slice(0, length) : out.padStart(length, '0');
}

function find7za() {
  const dir = path.join(cacheDir, '7zip@1.0.0');
  if (!fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir);
  for (const e of entries) {
    if (e.startsWith('7zip-win-x64-') && fs.statSync(path.join(dir, e)).isDirectory()) {
      const exe = path.join(dir, e, 'bin', '7za.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

function extract7z(sevenZa, archive, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const r = spawnSync(sevenZa, ['x', '-y', `-o${targetDir}`, archive], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`7z 解压失败: ${archive} (exit ${r.status})`);
  }
}

function countFiles(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else n++;
    }
  }
  return n;
}

(async () => {
  // 1. 确保 7zip 可用（electron-builder 首次运行会下载它到缓存）
  let sevenZa = find7za();
  if (!sevenZa) {
    console.log('7zip 工具未在缓存中，请先运行一次 electron-builder 或手动解压');
    console.log('尝试从系统查找 7za...');
    const which = spawnSync('where', ['7za'], { encoding: 'utf8', windowsHide: true });
    if (which.status === 0 && which.stdout.trim()) {
      sevenZa = which.stdout.trim().split('\n')[0];
    }
  }
  if (!sevenZa) {
    console.error('未找到 7za.exe，无法准备工具缓存');
    process.exit(1);
  }
  console.log(`使用 7za: ${sevenZa}`);

  // 2. 逐个工具：解压到 hash 目录 + 写 complete 状态
  for (const tool of TOOLS) {
    const releaseDir = path.join(cacheDir, tool.release);
    const archive = path.join(releaseDir, tool.file);
    if (!fs.existsSync(archive)) {
      console.log(`[跳过] ${tool.file} 未下载，请先运行 download-builder-tools.js`);
      continue;
    }
    const fullUrl = MIRROR_BASE + tool.release + '/' + tool.file;
    const suffix = hashUrlSafe(fullUrl, 5);
    const extractDir = path.join(releaseDir, `${tool.release}-${suffix}`);
    const stateFile = `${extractDir}.state`;

    if (fs.existsSync(path.join(extractDir, 'Bin', 'makensis.exe')) ||
        fs.existsSync(path.join(extractDir, 'plugins')) ||
        fs.existsSync(path.join(extractDir, 'windows-10'))) {
      console.log(`[复用] ${tool.release} 已解压到 ${extractDir}`);
      // 确保状态文件为 complete
      if (!fs.existsSync(stateFile)) {
        const count = countFiles(extractDir);
        fs.writeFileSync(stateFile, JSON.stringify({
          version: 1, state: 'complete',
          timestamp: Date.now(), fileCount: count, extractedSize: 0,
        }, null, 2), 'utf8');
      }
      continue;
    }

    console.log(`[解压] ${tool.release}/${tool.file} -> ${extractDir}`);
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
    extract7z(sevenZa, archive, extractDir);
    const count = countFiles(extractDir);
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1, state: 'complete',
      timestamp: Date.now(), fileCount: count, extractedSize: 0,
    }, null, 2), 'utf8');
    console.log(`[完成] ${tool.release} (${count} files)`);
  }

  console.log('\n构建工具缓存准备就绪 ✓');
})();
