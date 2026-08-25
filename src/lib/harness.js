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
 * 自动执行启动前提：定位 dsh（必要时自动安装）→ 启动 dsh web → 等待就绪。
 * @returns {Promise<{started: boolean, entry: object|null}>}
 */
async function ensureHarnessRunning() {
  if (await isHarnessReady()) {
    startedByUs = false;
    return { started: false, entry: null };
  }

  // 前提 1：定位 dsh 入口（找不到则自动安装）
  let dshEntry = findDshEntry();
  if (!dshEntry) {
    logLine('未找到 dsh 命令，自动安装 @deepseek-ai/dsh ...');
    dshEntry = await autoInstallDsh();
  }
  if (!dshEntry) {
    throw new Error(
      '未找到 dsh 命令且自动安装失败。请手动执行：npm install -g @deepseek-ai/dsh'
    );
  }

  // 前提 2：启动 dsh web（多方式重试）
  let started = false;
  const attempts = [
    { entry: dshEntry, label: 'node+bin.js' },
  ];
  // 若主入口是 node+bin.js，追加 .cmd 备选；反之亦然
  if (dshEntry.script) {
    const cmdEntry = findDshCmdEntry();
    if (cmdEntry) attempts.push({ entry: cmdEntry, label: 'dsh.cmd' });
  } else {
    const nodeEntry = findDshNodeEntry();
    if (nodeEntry) attempts.unshift({ entry: nodeEntry, label: 'node+bin.js' });
  }

  for (const attempt of attempts) {
    logLine(`启动 dsh web (${attempt.label})...`);
    started = await trySpawnWeb(attempt.entry);
    if (started) break;
    logLine(`方式 ${attempt.label} 启动失败，尝试下一种...`);
  }

  if (!started) {
    throw new Error('dsh web 服务启动失败，请检查 dsh 安装（npm install -g @deepseek-ai/dsh）');
  }
  startedByUs = true;
  return { started: true, entry: dshEntry };
}

/** 尝试 spawn dsh web 并等待就绪 */
async function trySpawnWeb(dshEntry) {
  // --no-open：阻止 dsh web 自动打开系统浏览器（界面由 DSH Desktop 窗口承载）
  const args = dshEntry.script
    ? [dshEntry.script, 'web', '--port', String(HARNESS_PORT), '--no-open']
    : ['web', '--port', String(HARNESS_PORT), '--no-open'];

  return new Promise((resolve) => {
    let child = null;
    try {
      child = spawn(dshEntry.command, args, {
        env: { ...process.env },
        cwd: os.homedir(),
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: !dshEntry.script,
      });
    } catch (e) {
      logLine(`spawn 失败: ${e.message}`);
      resolve(false);
      return;
    }

    harnessProcess = child;
    child.on('exit', (code) => {
      harnessProcess = null;
      logLine(`dsh web 进程退出 code=${code}`);
      resolve(false);
    });
    child.on('error', (e) => {
      logLine(`dsh web 进程错误: ${e.message}`);
      harnessProcess = null;
      resolve(false);
    });

    // 等待就绪（最多 30s）
    const deadline = Date.now() + 30000;
    const probe = async () => {
      if (await isHarnessReady()) {
        resolve(true);
        return;
      }
      if (Date.now() > deadline) {
        logLine('dsh web 启动超时(30s)');
        resolve(false);
        return;
      }
      setTimeout(probe, 1000);
    };
    probe();
  });
}

/** 自动安装 dsh 到全局 */
async function autoInstallDsh() {
  logLine('运行 npm install -g @deepseek-ai/dsh ...');
  return new Promise((resolve) => {
    try {
      const child = spawn('npm', ['install', '-g', '@deepseek-ai/dsh'], {
        env: { ...process.env },
        cwd: os.homedir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true,
      });
      child.on('exit', () => {
        // 安装后重新定位
        resolve(findDshEntry());
      });
      child.on('error', () => resolve(null));
      // 10 分钟超时兜底
      setTimeout(() => resolve(findDshEntry()), 10 * 60 * 1000);
    } catch {
      resolve(null);
    }
  });
}

/** 通过 PATH 查找 dsh.cmd */
function findDshCmdEntry() {
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

/** 通过 node+bin.js 查找（复用 findDshEntry 的包定位逻辑） */
function findDshNodeEntry() {
  return findDshEntry();
}

/** 日志行（写 stderr，EPIPE 安全） */
function logLine(msg) {
  try {
    if (process.stderr && !process.stderr.destroyed) {
      process.stderr.write('[dsh] ' + String(msg).trim() + '\n');
    }
  } catch {
    /* EPIPE 静默 */
  }
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
  autoInstallDsh,
  get startedByUs() {
    return startedByUs;
  },
};
