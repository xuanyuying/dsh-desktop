/**
 * Patch electron-builder：node_modules 收集改用 TRAVERSAL（纯文件系统扫描）。
 *
 * 原因：本项目零生产依赖（dependencies 为空），无需 npm/pnpm 收集依赖树；
 * 且受限环境禁止 spawn 子进程捕获输出（EPERM），npm 收集器必然失败。
 * TRAVERSAL 只读 package.json + 文件系统，不 spawn 任何命令。
 *
 * 用法: node scripts/patch-builder.js   （打包前运行）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const file = path.join(
  __dirname,
  '..',
  'node_modules',
  'app-builder-lib',
  'out',
  'util',
  'appFileCopier.js'
);

if (!fs.existsSync(file)) {
  console.error(`未找到 ${file}，请先 npm install`);
  process.exit(1);
}

let source = fs.readFileSync(file, 'utf8');

const target =
  'const pmApproaches = [await packager.getPackageManager(), node_module_collector_1.PM.TRAVERSAL];';
const replacement =
  'const pmApproaches = [node_module_collector_1.PM.TRAVERSAL];';

if (source.includes(target)) {
  source = source.replace(target, replacement);
  fs.writeFileSync(file, source, 'utf8');
  console.log('[patch] 已替换 node_modules 收集方式为 TRAVERSAL');
} else if (source.includes(replacement)) {
  console.log('[patch] 已应用过，跳过');
} else {
  console.error('[patch] 未找到目标代码，可能是版本差异');
  console.error('期望包含: ' + target);
  process.exit(1);
}
