/**
 * 将下载的 Electron 二进制 zip 解压到 node_modules/electron/dist
 * 并写入 path.txt（模拟 electron 包的 postinstall）。
 * 用法: node scripts/extract-electron.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const VERSION = '43.4.0';
const PLATFORM = 'win32-x64';
const root = path.join(__dirname, '..');
const zip = path.join(root, '.electron-cache', `electron-v${VERSION}-${PLATFORM}.zip`);
const dist = path.join(root, 'node_modules', 'electron', 'dist');

if (!fs.existsSync(zip)) {
  console.error(`未找到 ${zip}，请先运行 scripts/download-electron.js`);
  process.exit(1);
}

// 若已解压且 electron.exe 存在，直接复用（避免被占用文件的删除失败）
if (fs.existsSync(path.join(dist, 'electron.exe'))) {
  fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'electron.exe', 'utf8');
  console.log('Electron 已就绪（复用现有 dist）:', path.join(dist, 'electron.exe'));
  process.exit(0);
}

console.log('解压 Electron 到 node_modules/electron/dist ...');

// 清理旧目录（若被占用则忽略，继续尝试）
if (fs.existsSync(dist)) {
  try {
    fs.rmSync(dist, { recursive: true, force: true });
  } catch (err) {
    console.warn(`清理旧目录失败（可能被占用）: ${err.message}`);
  }
}
fs.mkdirSync(dist, { recursive: true });

// 用 PowerShell 的 Expand-Archive（兼容性最好）
const psScript = `Expand-Archive -Path '${zip.replace(/'/g, "''")}' -DestinationPath '${dist.replace(/'/g, "''")}' -Force`;
try {
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript], {
    stdio: 'inherit',
    windowsHide: true,
  });
} catch {
  // 回退：用 Node 自带解压（tar 支持 zip）
  console.log('使用 Node 内置解压...');
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['-e', `
    const fs=require('fs');
    const {execSync}=require('child_process');
    const z='${zip}';
    const d='${dist}';
    // node 无内置 zip 解压，尝试 tar
    try { execSync('tar -xf "'+z+'" -C "'+d+'"', {stdio:'inherit'}); } catch(e) { console.error('解压失败:', e.message); process.exit(1); }
  `], { stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) process.exit(r.status || 1);
}

if (!fs.existsSync(path.join(dist, 'electron.exe'))) {
  console.error('解压后未找到 electron.exe，解压可能失败');
  process.exit(1);
}

// 写 path.txt（electron 模块依赖它定位二进制）
fs.writeFileSync(path.join(root, 'node_modules', 'electron', 'path.txt'), 'electron.exe', 'utf8');

console.log('Electron 就绪:', path.join(dist, 'electron.exe'));
