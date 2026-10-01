/**
 * 测试用隔离环境：临时 DSH_HOME + 独立端口。
 *
 * 为什么需要它：`test-lib` / `test-e2e-auth` / `test-token-reuse` 会调用
 * `ensureHarnessRunning()` 真正启动一个 harness。如果用默认的 3080 与真实
 * ~/.dsh，就会和开发机上正在使用的会话抢端口与数据。
 *
 * 用法（必须在 require harness 之前调用）：
 *   const env = await setupHarnessTestEnv();
 *   ... 测试 ...
 *   await env.cleanup();
 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

/** 向系统要一个空闲端口（listen 0 后立刻关闭） */
function findEphemeralPort(host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(0, host, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * 建立隔离环境并把环境变量设好。
 * @param {{keep?: boolean}} [opts]
 * @returns {Promise<{home:string, port:number, dir:string, cleanup:()=>Promise<void>}>}
 */
async function setupHarnessTestEnv(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-testenv-'));
  const home = path.join(dir, 'dsh-home');
  fs.mkdirSync(home, { recursive: true });

  // 独立端口：避免与开发机上正在跑的 harness 冲突
  let port = await findEphemeralPort();
  if (!port) port = 39000 + Math.floor(Math.random() * 1000);

  // 必须在 require harness 之前设置（harness 在模块加载时读取端口）
  process.env.DSH_DESKTOP_PORT = String(port);
  process.env.DSH_HOME = home;
  // 桌面端数据也隔离，避免污染真实 ~/.dsh-desktop
  process.env.DSH_DESKTOP_DATA_DIR = path.join(dir, 'desktop-data');
  process.env.DSH_DESKTOP_UI_STATE = path.join(dir, 'desktop-data', 'ui-state.json');
  process.env.DSH_DESKTOP_PEAK_CONTROL = path.join(dir, 'desktop-data', 'peak-control.json');
  process.env.DSH_DESKTOP_PEAK_STATUS = path.join(dir, 'desktop-data', 'peak-status.json');

  async function cleanup() {
    try {
      const harness = require('../src/lib/harness.js');
      if (harness.startedByUs) harness.stopHarnessIfOwned();
    } catch {
      /* 忽略 */
    }
    if (opts.keep) {
      console.log('  （保留测试目录以便排查: ' + dir + '）');
      return;
    }
    // 给进程退出留一点时间再删目录
    await new Promise((r) => setTimeout(r, 800));
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 上偶尔删不掉，忽略 */
    }
  }

  return { home, port, dir, cleanup };
}

/** 该环境是否具备运行 harness 的条件（dsh 已安装） */
function hasDsh() {
  const candidates = [
    path.join(
      process.env.APPDATA || '',
      'npm',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js'
    ),
    path.join(
      process.env.LOCALAPPDATA || '',
      'npm',
      'node_modules',
      '@deepseek-ai',
      'dsh',
      'lib',
      'bin.js'
    ),
  ];
  return candidates.some((c) => c && fs.existsSync(c));
}

module.exports = { setupHarnessTestEnv, findEphemeralPort, hasDsh };
