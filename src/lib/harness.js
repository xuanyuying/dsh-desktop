/**
 * Harness 服务管理模块（纯 Node，可脱离 Electron 测试）
 */
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const HARNESS_HOST = process.env.DSH_DESKTOP_HOST || '127.0.0.1';
const HARNESS_PORT = Number(process.env.DSH_DESKTOP_PORT || 3080);
const HARNESS_URL = `http://${HARNESS_HOST}:${HARNESS_PORT}`;
const STARTUP_TIMEOUT_MS = 60 * 1000;

let harnessProcess = null;
let startedByUs = false;

/** 探测端口是否已被监听 */
function isPortOpen(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

/** 探测 Harness HTTP 服务是否就绪 */
async function isHarnessReady() {
  try {
    const res = await fetch(`${HARNESS_URL}/`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** 等待服务就绪 */
async function waitForHarness(timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHarnessReady()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return isHarnessReady();
}

/**
 * 定位 dsh 入口：
 * 优先返回 { command: node.exe, script: dsh/bin.js }，
 * 其次 { command: 'dsh.cmd' }（走 PATH / npx 缓存）。
 */
function findDshEntry() {
  // 1) 从 npx 缓存解析 @deepseek-ai/dsh 包，拿到 node + bin.js
  const npxRoot = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  try {
    const dirs = fs.readdirSync(npxRoot);
    for (const dir of dirs) {
      const pkgDir = path.join(npxRoot, dir, 'node_modules', '@deepseek-ai', 'dsh');
      const pkgJson = path.join(pkgDir, 'package.json');
      if (fs.existsSync(pkgJson)) {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
        const bin = pkg.bin && (pkg.bin.dsh || pkg.bin['@deepseek-ai/dsh']);
        if (bin) {
          const script = path.join(pkgDir, bin);
          if (fs.existsSync(script)) {
            return { command: process.execPath, script };
          }
        }
      }
    }
  } catch {
    /* 忽略并回退 */
  }

  // 2) 回退：PATH / 显式 DSH_BIN 中的 dsh.cmd
  const explicit = process.env.DSH_BIN;
  if (explicit && fs.existsSync(explicit)) return { command: explicit };
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    for (const name of ['dsh.cmd', 'dsh.bat', 'dsh']) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) return { command: full };
    }
  }
  return null;
}

/**
 * 确保 dsh web 服务在运行。
 * @returns {Promise<{started: boolean, entry: object|null}>}
 */
async function ensureHarnessRunning() {
  if (await isHarnessReady()) {
    startedByUs = false;
    return { started: false, entry: null };
  }

  const dshEntry = findDshEntry();
  if (!dshEntry) {
    throw new Error(
      '未找到 dsh 命令。请先安装 DeepSeek Harness（npm install -g @deepseek-ai/dsh）'
    );
  }

  const args = dshEntry.script
    ? [dshEntry.script, 'web', '--port', String(HARNESS_PORT)]
    : ['web', '--port', String(HARNESS_PORT)];

  harnessProcess = spawn(dshEntry.command, args, {
    env: { ...process.env },
    cwd: os.homedir(),
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: !dshEntry.script,
  });

  harnessProcess.on('exit', (code) => {
    harnessProcess = null;
  });

  const ok = await waitForHarness();
  if (!ok) {
    throw new Error('dsh web 服务启动超时，请检查控制台日志');
  }
  startedByUs = true;
  return { started: true, entry: dshEntry };
}

/** 停止由本应用启动的服务 */
function stopHarnessIfOwned() {
  if (startedByUs && harnessProcess && harnessProcess.pid) {
    try {
      spawnSync('taskkill', ['/pid', String(harnessProcess.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      try {
        harnessProcess.kill();
      } catch {
        /* 忽略 */
      }
    }
    return true;
  }
  return false;
}

module.exports = {
  HARNESS_HOST,
  HARNESS_PORT,
  HARNESS_URL,
  isPortOpen,
  isHarnessReady,
  waitForHarness,
  findDshEntry,
  ensureHarnessRunning,
  stopHarnessIfOwned,
  get startedByUs() {
    return startedByUs;
  },
};
