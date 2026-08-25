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

/** 等待服务就绪（指数退避，避免 CPU 空转） */
async function waitForHarness(timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  while (Date.now() < deadline) {
    if (await isHarnessReady()) return true;
    // 指数退避：500ms → 1s → 2s → 4s → 封顶 5s
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5000);
  }
  return isHarnessReady();
}

/**
 * 定位 dsh 入口：
 * 1) 全局 npm 安装（npm root -g 下的 @deepseek-ai/dsh）→ node + bin.js
 * 2) npx 缓存 → node + bin.js
 * 3) 回退 PATH / 显式 DSH_BIN 中的 dsh.cmd
 */
function findDshEntry() {
  // 1) 全局 npm 安装
  const globalRoot = getGlobalNpmRoot();
  if (globalRoot) {
    const pkgDir = path.join(globalRoot, '@deepseek-ai', 'dsh');
    const entry = resolvePackageEntry(pkgDir);
    if (entry) return entry;
  }

  // 2) npx 缓存
  const npxRoot = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  try {
    const dirs = fs.readdirSync(npxRoot);
    for (const dir of dirs) {
      const pkgDir = path.join(npxRoot, dir, 'node_modules', '@deepseek-ai', 'dsh');
      const entry = resolvePackageEntry(pkgDir);
      if (entry) return entry;
    }
  } catch {
    /* 忽略并回退 */
  }

  // 3) 回退：PATH / 显式 DSH_BIN 中的 dsh.cmd
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

/** 获取全局 npm 包根目录 */
function getGlobalNpmRoot() {
  try {
    // 优先 npm root -g（权威）
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 10000,
    });
    const root = out.trim();
    if (root && fs.existsSync(root)) return root;
  } catch {
    /* 忽略 */
  }
  // 回退：Windows 常见全局位置
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules'),
    path.join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** 从包目录解析 node + bin.js 入口 */
function resolvePackageEntry(pkgDir) {
  const pkgJson = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJson)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    const bin = pkg.bin && (pkg.bin.dsh || pkg.bin['@deepseek-ai/dsh']);
    if (bin) {
      const script = path.join(pkgDir, bin);
      if (fs.existsSync(script)) {
        return { command: process.execPath, script };
      }
    }
  } catch {
    /* 忽略 */
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
