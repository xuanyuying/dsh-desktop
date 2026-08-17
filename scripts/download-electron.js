/**
 * 手动下载 Electron 二进制（postinstall 被沙箱跳过时使用）
 * 用法: node scripts/download-electron.js
 */
'use strict';

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '43.4.0';
const PLATFORM = 'win32-x64';
const MIRRORS = [
  `https://npmmirror.com/mirrors/electron/${VERSION}/electron-v${VERSION}-${PLATFORM}.zip`,
  `https://github.com/electron/electron/releases/download/v${VERSION}/electron-v${VERSION}-${PLATFORM}.zip`,
];

const outDir = path.join(__dirname, '..', '.electron-cache');
const outFile = path.join(outDir, `electron-v${VERSION}-${PLATFORM}.zip`);

function download(url, target) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET' }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(res.headers.location, target));
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
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  for (const mirror of MIRRORS) {
    try {
      console.log(`下载: ${mirror}`);
      await download(mirror, outFile);
      const size = fs.statSync(outFile).size;
      console.log(`完成: ${(size / 1024 / 1024).toFixed(1)} MB -> ${outFile}`);
      process.exit(0);
    } catch (err) {
      console.error(`失败: ${err.message}`);
    }
  }
  process.exit(1);
})();
