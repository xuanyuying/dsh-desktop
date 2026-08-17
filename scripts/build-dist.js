/**
 * 一键打包脚本（国内网络 / 无 GitHub 访问环境）
 *
 * 解决的问题：
 * 1. electron 二进制：用 electronDist 指向本地已解压目录，不下载
 * 2. node_modules 收集：patch 为 TRAVERSAL（纯文件系统扫描，不 spawn npm）
 * 3. 构建工具（NSIS/winCodeSign/7zip）：预下载到 ELECTRON_BUILDER_CACHE
 * 4. 沙箱/受限环境禁止 pipe 捕获子进程输出（EPERM）：
 *    - builder-util exec/spawn 改 stdio inherit
 *    - makensis 脚本从 stdin 改为写入模板目录文件
 *
 * 用法: node scripts/build-dist.js
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function run(label, cmd, args, env) {
  console.log(`\n[${label}]`);
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) {
    console.error(`[失败] ${label} (exit ${r.status})`);
    process.exit(r.status || 1);
  }
}

(async () => {
  // 1. 预下载构建工具（幂等，已缓存则跳过）
  run('下载构建工具 (国内镜像)', process.execPath, [path.join(root, 'scripts', 'download-builder-tools.js')], {
    ELECTRON_BUILDER_CACHE: path.join(root, '.builder-cache'),
  });

  // 2. 确保工具已解压到正确缓存目录（幂等）
  run('准备构建工具缓存', process.execPath, [path.join(root, 'scripts', 'prepare-builder-cache.js')], {
    ELECTRON_BUILDER_CACHE: path.join(root, '.builder-cache'),
  });

  // 3. patch electron-builder（幂等）
  run('应用 electron-builder patch', process.execPath, [path.join(root, 'scripts', 'patch-builder.js')], {});

  // 4. 打包（直接调 electron-builder CLI，避免 npm 包装层的 spawn 限制）
  const builderCli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  run('electron-builder 打包', process.execPath, [builderCli, '--win'], {
    npm_config_cache: path.join(root, '.npm-cache'),
    ELECTRON_BUILDER_CACHE: path.join(root, '.builder-cache'),
    ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
  });

  const setup = path.join(root, 'dist', 'DSH Desktop Setup 1.0.0.exe');
  if (fs.existsSync(setup)) {
    const mb = (fs.statSync(setup).size / 1024 / 1024).toFixed(1);
    console.log(`\n✅ 打包完成: ${setup} (${mb} MB)`);
  } else {
    console.log('\n⚠️ 打包完成，但未找到安装包文件');
  }
})();
