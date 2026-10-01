/**
 * 生成安装包校验和（发布用）。
 *
 * 没有代码签名证书时，用户下载会看到 SmartScreen 警告；发布 SHA-256 校验和
 * 至少让人能核实文件确实来自本项目、未被篡改。
 *
 * 用法: node scripts/checksums.js
 * 输出: dist/SHA256SUMS.txt  + 控制台列表
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist');

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    let read;
    // 分块读取，安装包约 95MB
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function main() {
  if (!fs.existsSync(DIST)) {
    console.error('未找到 dist 目录，请先运行 node scripts/build-dist.js');
    process.exit(2);
  }

  const files = fs
    .readdirSync(DIST)
    .filter((f) => /^DSH Desktop Setup .+\.exe$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error('dist 下没有找到安装包（DSH Desktop Setup *.exe）');
    process.exit(2);
  }

  const lines = [];
  console.log('=== 安装包校验和 (SHA-256) ===\n');
  for (const f of files) {
    const full = path.join(DIST, f);
    const size = fs.statSync(full).size;
    const sum = sha256(full);
    lines.push(sum + '  ' + f);
    console.log(f);
    console.log('  SHA-256: ' + sum);
    console.log('  大小   : ' + (size / 1024 / 1024).toFixed(1) + ' MB\n');
  }

  const out = path.join(DIST, 'SHA256SUMS.txt');
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  console.log('已写入: ' + out);
}

main();
