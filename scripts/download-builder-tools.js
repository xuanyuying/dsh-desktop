/**
 * 预下载 electron-builder 构建工具（NSIS / winCodeSign / nsis-resources）
 * 到 ELECTRON_BUILDER_CACHE 目录，使打包不访问 GitHub。
 * 用法: node scripts/download-builder-tools.js
 */
'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MIRROR_BASE = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

// releaseName, 文件名, sha256（来自 electron-builder 源码，用于校验）
const TOOLS = [
  {
    release: 'nsis-3.0.4.1',
    file: 'nsis-3.0.4.1.7z',
    sha256: '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa',
  },
  {
    release: 'nsis-resources-3.4.1',
    file: 'nsis-resources-3.4.1.7z',
    sha256: '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103',
  },
  {
    release: 'winCodeSign-2.6.0',
    file: 'winCodeSign-2.6.0.7z',
    sha256: 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4',
  },
];

const cacheDir = process.env.ELECTRON_BUILDER_CACHE
  ? path.resolve(process.env.ELECTRON_BUILDER_CACHE)
  : path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function download(url, target) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET' }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(res.headers.location, target)); // 跟随重定向
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const file = fs.createWriteStream(target);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

(async () => {
  console.log(`缓存目录: ${cacheDir}`);
  fs.mkdirSync(cacheDir, { recursive: true });

  for (const tool of TOOLS) {
    const dir = path.join(cacheDir, tool.release);
    const target = path.join(dir, tool.file);
    fs.mkdirSync(dir, { recursive: true });

    // 已存在且校验通过 → 跳过
    if (fs.existsSync(target)) {
      const actual = await sha256File(target);
      if (actual === tool.sha256) {
        console.log(`[复用] ${tool.release}/${tool.file}`);
        continue;
      }
      console.log(`[校验失败，重新下载] ${tool.release}/${tool.file}`);
    }

    const url = MIRROR_BASE + tool.release + '/' + tool.file;
    console.log(`[下载] ${url}`);
    await download(url, target);

    const actual = await sha256File(target);
    if (actual !== tool.sha256) {
      console.error(`[错误] ${tool.file} 校验失败: 期望 ${tool.sha256}，实际 ${actual}`);
      process.exit(1);
    }
    console.log(`[完成] ${tool.file} (${(fs.statSync(target).size / 1024 / 1024).toFixed(1)} MB)`);
  }

  console.log('\n全部构建工具就绪 ✓');
})();
