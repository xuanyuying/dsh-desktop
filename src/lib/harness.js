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
/** 首选端口；被外部服务占用时自动退让到空闲端口 */
const PREFERRED_PORT = Number(process.env.DSH_DESKTOP_PORT || 3080);
const STARTUP_TIMEOUT_MS = 60 * 1000;

/**
 * 实际使用的端口。
 *
 * 默认**不再** taskkill 占用端口的进程 —— 那可能正是用户正在使用的 harness
 * （甚至承载当前会话），误杀会直接中断用户的工作。改为退让到下一个空闲端口；
 * 确需结束占用进程时，由菜单项显式触发 killDshWebOnPort。
 */
let activePort = PREFERRED_PORT;
let fellBackFrom = null;

/** 当前 harness 基址 */
function getHarnessUrl(port = activePort) {
  return `http://${HARNESS_HOST}:${port}`;
}

/** 在 [start, start+count) 中找第一个空闲端口 */
async function findFreePort(start, count = 20) {
  for (let p = start; p < start + count && p <= 65535; p++) {
    if (!(await isPortOpen(HARNESS_HOST, p, 500))) return p;
  }
  return null;
}

let harnessProcess = null;
let startedByUs = false;
// dsh 0.1.5+ 启动时打印的带认证 token 的 URL（每次启动随机生成）
let authUrl = null;
// 服务启动输出缓冲（用于解析 token URL）
let startupOutput = '';
// 由桌面端注入的额外 patch 覆盖层（如峰谷守卫插件）
let extraPatches = [];
// 本次启动是否真的带上了 patch（兜底重试会去掉 patch，此时守卫不生效）
let guardPatchesApplied = false;

/**
 * 设置额外 patch 覆盖层。
 *
 * 注意参数顺序：`--patch` 是 `dsh web` 子命令自己的选项，而 `--port`/`--no-open`
 * 属于被透传给 app 的参数。启动器一旦遇到不认识的选项（`--port`）就会把其后
 * 全部内容原样透传，因此 `--patch` 必须排在 app 参数之前，否则会报
 * "unknown option '--patch'"。
 * @param {string[]} list - patch 文件绝对路径
 */
function setExtraPatches(list) {
  extraPatches = Array.isArray(list) ? list.filter(Boolean).slice() : [];
}

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

/**
 * 探测 Harness HTTP 服务是否在运行。
 * 注意：dsh 0.1.5+ 未认证时返回 401，因此只要拿到任意 HTTP 响应
 * （200/303/401 等）都说明服务已监听，不能只认 200。
 */
async function isHarnessReady() {
  try {
    const res = await fetch(`${getHarnessUrl()}/`, {
      signal: AbortSignal.timeout(3000),
      redirect: 'manual',
    });
    return res.status > 0;
  } catch {
    return false;
  }
}

/**
 * 探测服务是否**可直接使用**（无需再认证）：
 * 访问 / 返回 200 表示已认证（cookie 有效）或旧版无需认证。
 * 返回 401 表示需要 token 认证。
 */
async function isHarnessUsable() {
  try {
    const res = await fetch(`${getHarnessUrl()}/`, {
      signal: AbortSignal.timeout(3000),
      redirect: 'manual',
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** 获取当前应加载的 URL（优先带 token 的认证 URL） */
function getLoadUrl() {
  return authUrl || getHarnessUrl();
}

/** 取得启动输出中解析到的 token URL */
function getAuthUrl() {
  return authUrl;
}

/** 从启动输出中解析认证 URL */
function parseAuthUrl(text) {
  if (!text) return null;
  const m = text.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_\-]+/);
  if (m) return m[0];
  // 兜底：任意 host 的 token URL
  const m2 = text.match(/https?:\/\/[^\s"']+\?token=[A-Za-z0-9_\-]+/);
  return m2 ? m2[0] : null;
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
 * 确保 dsh web 服务可用。
 *
 * 处理 dsh 0.1.5+ 的认证机制：服务需用启动时打印的带 token URL 认证。
 *
 * 端口策略（默认永不误杀）：
 *  A. 首选端口空闲          → 在其上启动，捕获 token URL
 *  B. 首选端口可访问(200)   → 直接复用
 *  C. 首选端口是本应用启动的 → 用已有 token 复用
 *  D. 首选端口被外部服务占用 → **退让到下一个空闲端口**，不结束任何进程
 *
 * 需要清理占用进程时由菜单显式触发 killDshWebOnPort。
 *
 * @returns {Promise<{started: boolean, entry: object|null, authUrl: string|null,
 *   reused: boolean, port: number, fellBackFrom: number|null}>}
 */
async function ensureHarnessRunning() {
  activePort = PREFERRED_PORT;
  fellBackFrom = null;

  if (await isPortOpen(HARNESS_HOST, PREFERRED_PORT)) {
    // B. 已就绪且可直接使用 → 复用
    activePort = PREFERRED_PORT;
    if (await isHarnessUsable()) {
      startedByUs = false;
      logLine('复用已就绪的 dsh web 服务（无需认证）');
      return { started: false, entry: null, authUrl, reused: true, port: activePort, fellBackFrom };
    }
    // C. 需认证但本次进程持有 token（例如刚启动过）→ 复用
    if (authUrl && authUrl.includes(`:${PREFERRED_PORT}/`)) {
      startedByUs = true;
      logLine('复用本应用启动的 dsh web 服务（带认证 URL）');
      return { started: false, entry: null, authUrl, reused: true, port: activePort, fellBackFrom };
    }
    // D. 外部/遗留服务占用且无法认证 → 退让，绝不 taskkill
    const alt = await findFreePort(PREFERRED_PORT + 1, 20);
    if (alt === null) {
      throw new Error(
        `端口 ${PREFERRED_PORT} 已被其它服务占用，且在 ${PREFERRED_PORT + 1}–${PREFERRED_PORT + 20} 内找不到空闲端口。` +
          '本应用不会自动结束占用端口的进程；请手动关闭它，或在菜单「工具 → 结束占用端口的 dsh 服务」中处理。'
      );
    }
    activePort = alt;
    fellBackFrom = PREFERRED_PORT;
    logLine(
      `端口 ${PREFERRED_PORT} 被其它服务占用，自动改用 ${alt}（不会结束任何进程）`
    );
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
  let usedPatches = extraPatches;
  const attempts = [{ entry: dshEntry, label: 'node+bin.js', patches: extraPatches }];
  if (dshEntry.script) {
    const cmdEntry = findDshCmdEntry();
    if (cmdEntry) attempts.push({ entry: cmdEntry, label: 'dsh.cmd', patches: extraPatches });
  } else {
    const nodeEntry = findDshNodeEntry();
    if (nodeEntry) attempts.unshift({ entry: nodeEntry, label: 'node+bin.js', patches: extraPatches });
  }
  // 兜底：极老的 dsh 可能不认识 web 子命令的 --patch。去掉注入重试一次，
  // 保证「服务能起来」优先于「守卫被注入」——守卫缺失时界面会明确告警。
  if (extraPatches.length > 0) {
    attempts.push({ entry: dshEntry, label: 'node+bin.js (无 --patch 兜底)', patches: [] });
  }

  for (const attempt of attempts) {
    logLine(`启动 dsh web (${attempt.label})...`);
    started = await trySpawnWeb(attempt.entry, attempt.patches);
    if (started) {
      usedPatches = attempt.patches;
      if (attempt.patches.length === 0 && extraPatches.length > 0) {
        logLine('警告：本次启动未能注入峰谷守卫，高峰零 token 保护不可用');
      }
      break;
    }
    logLine(`方式 ${attempt.label} 启动失败，尝试下一种...`);
  }

  if (!started) {
    throw new Error(
      'dsh web 服务启动失败。可能原因：端口 ' + activePort + ' 被其他程序占用，或 dsh 安装异常。'
    );
  }
  startedByUs = true;
  guardPatchesApplied = usedPatches.length > 0;
  return {
    started: true,
    entry: dshEntry,
    authUrl: authUrl,
    reused: false,
    guardPatches: guardPatchesApplied,
    port: activePort,
    fellBackFrom,
  };
}

/** 清理占用指定端口的 dsh web 孤儿进程（仅匹配 node + dsh web 命令行） */
function killDshWebOnPort(port) {
  try {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).stdout || '';
    const pids = new Set();
    for (const line of out.split('\n')) {
      if (!line.includes(':' + port) || !line.includes('LISTENING')) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && /^\d+$/.test(pid)) pids.add(pid);
    }
    let killedAny = false;
    for (const pid of pids) {
      // 校验该 PID 是 node 且命令行含 dsh web，避免误杀
      const info = spawnSync(
        'powershell',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 }
      );
      const cmd = (info.stdout || '').toLowerCase();
      if (!cmd.includes('dsh') || !cmd.includes('web')) {
        logLine(`端口 ${port} 的 PID ${pid} 非 dsh web，跳过`);
        continue;
      }
      logLine(`终止孤儿 dsh web 进程 PID ${pid}`);
      spawnSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killedAny = true;
    }
    return killedAny;
  } catch (e) {
    logLine('清理孤儿进程失败: ' + e.message);
    return false;
  }
}

/**
 * 拼装 dsh web 的启动参数。
 * 单独导出以便单测断言 `--patch` 与 app 参数的相对顺序。
 * @param {{command: string, script?: string}} dshEntry
 * @param {string[]} patches - patch 文件绝对路径
 * @returns {string[]}
 */
function buildWebArgs(dshEntry, patches = extraPatches) {
  const patchArgs = patches.filter(Boolean).flatMap((p) => ['--patch', p]);
  const appArgs = ['--port', String(activePort), '--no-open'];
  return dshEntry.script
    ? [dshEntry.script, 'web', ...patchArgs, ...appArgs]
    : ['web', ...patchArgs, ...appArgs];
}

/**
 * 构造子进程环境变量。
 *
 * 打包后的应用没有独立的 node.exe，只能用自身 exe 充当 Node 运行时
 * （`resolvePackageEntry` 返回 `command: process.execPath`）。这种情况下
 * **必须**显式设置 `ELECTRON_RUN_AS_NODE=1`，否则 Electron 会把它当作
 * 第二个应用实例启动：再跑一遍 main.js、抢单实例锁失败、白起一堆进程。
 * 实测每次启动都会留下这样一条记录（startup.log 中 lock=false 那行）。
 */
function buildSpawnEnv(entry) {
  const env = { ...process.env, ...getProxyEnv() };
  if (entry && entry.command === process.execPath) {
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }
  return env;
}

/** 尝试 spawn dsh web 并等待就绪（同时捕获认证 token URL） */
async function trySpawnWeb(dshEntry, patches = extraPatches) {
  // 启动器参数顺序：--patch（web 子命令选项）必须在 app 参数之前，
  // 否则 --port 之后的 --patch 会被透传给 app 并报 unknown option。
  // --no-open：阻止 dsh web 自动打开系统浏览器（界面由 DSH Desktop 窗口承载）
  const args = buildWebArgs(dshEntry, patches);

  authUrl = null;
  startupOutput = '';

  return new Promise((resolve) => {
    let child = null;
    try {
      // 0.1.5+ 支持代理环境变量：显式传递，确保桌面端代理设置生效
      // （其中包含「用自身 exe 当 Node」时必须的 ELECTRON_RUN_AS_NODE）
      const env = buildSpawnEnv(dshEntry);
      child = spawn(dshEntry.command, args, {
        env,
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

    // 捕获启动输出并解析带 token 的认证 URL
    const onData = (d) => {
      const s = d.toString();
      startupOutput += s;
      const parsed = parseAuthUrl(startupOutput);
      if (parsed && parsed !== authUrl) {
        authUrl = parsed;
        logLine('已捕获认证 URL（token 就绪）');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    child.on('exit', (code) => {
      harnessProcess = null;
      // 端口冲突时 dsh 会立刻退出：此时若端口上已有可复用服务，视为成功
      logLine(`dsh web 进程退出 code=${code}`);
      finish(false);
    });
    child.on('error', (e) => {
      logLine(`dsh web 进程错误: ${e.message}`);
      harnessProcess = null;
      finish(false);
    });

    // 等待就绪（最多 30s）。服务在监听后再给 token 输出一点时间（最多 5s），
    // 确保 dsh 0.1.5+ 的认证 URL 被捕获后再返回。
    const deadline = Date.now() + 30000;
    let tokenWaitUntil = null;
    const probe = async () => {
      if (settled) return;
      if (await isHarnessReady()) {
        if (authUrl) {
          logLine('dsh web 服务已就绪（token 已捕获）');
          finish(true);
          return;
        }
        // 服务已监听但 token 未解析：等待输出到达
        if (tokenWaitUntil === null) tokenWaitUntil = Date.now() + 5000;
        if (Date.now() >= tokenWaitUntil) {
          logLine('dsh web 服务已就绪（未捕获 token，可能为旧版无需认证）');
          finish(true);
          return;
        }
        setTimeout(probe, 300);
        return;
      }
      if (Date.now() > deadline) {
        logLine('dsh web 启动超时(30s)');
        finish(false);
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

// ---------------------------------------------------------------------------
// dsh 版本检测与升级（结合官方 0.1.5+ 更新）
// ---------------------------------------------------------------------------

/** 获取本地已安装的 dsh 版本 */
function getLocalDshVersion() {
  const entry = findDshEntry();
  if (!entry || !entry.script) return null;
  try {
    // entry.script = <pkgDir>/lib/bin.js → 向上找 package.json
    const pkgDir = path.dirname(path.dirname(entry.script));
    const pkgJson = path.join(pkgDir, 'package.json');
    if (fs.existsSync(pkgJson)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      return pkg.version || null;
    }
  } catch {
    /* 忽略 */
  }
  return null;
}

/** 查询 npm 上 dsh 的最新版本 */
function getLatestDshVersion() {
  return new Promise((resolve) => {
    try {
      const req = require('node:https').get(
        'https://registry.npmjs.org/@deepseek-ai/dsh',
        { headers: { accept: 'application/json', 'User-Agent': 'dsh-desktop' }, timeout: 15000 },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            try {
              const j = JSON.parse(body);
              resolve((j['dist-tags'] && j['dist-tags'].latest) || null);
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/** 比较版本号（返回 true 表示 a 比 b 新） */
function isNewerVersion(a, b) {
  if (!a || !b) return false;
  const parse = (v) => {
    const s = String(v).replace(/^v/, '');
    const [core, pre] = s.split('-');
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    let stage = 1; // 1=正式版, 2=alpha, 3=rc
    let stageNum = 0;
    if (pre) {
      if (pre.includes('rc')) stage = 3;
      else if (pre.includes('alpha')) stage = 2;
      const m = pre.match(/(\d+)/);
      if (m) stageNum = parseInt(m[1], 10);
    }
    return { nums, stage, stageNum };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const x = pa.nums[i] || 0;
    const y = pb.nums[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  // 主版本相同：比较阶段（rc > alpha > 正式）与阶段序号
  if (pa.stage !== pb.stage) return pa.stage > pb.stage;
  return pa.stageNum > pb.stageNum;
}

/**
 * 升级 dsh 到指定版本（默认 latest）。
 * @param {string} version - 目标版本，'latest' 或具体版本号
 * @returns {Promise<{ok: boolean, output: string}>}
 */
function upgradeDsh(version = 'latest') {
  return new Promise((resolve) => {
    const target = version === 'latest' ? '@deepseek-ai/dsh@latest' : '@deepseek-ai/dsh@' + version;
    logLine('升级 dsh: npm install -g ' + target);
    let output = '';
    try {
      const child = spawn('npm', ['install', '-g', target], {
        env: { ...process.env },
        cwd: os.homedir(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: true,
      });
      child.stdout.on('data', (d) => (output += d.toString()));
      child.stderr.on('data', (d) => (output += d.toString()));
      child.on('exit', (code) => {
        resolve({ ok: code === 0, output: output.slice(-2000) });
      });
      child.on('error', (e) => resolve({ ok: false, output: e.message }));
      // 10 分钟超时
      setTimeout(() => resolve({ ok: false, output: 'timeout: ' + output.slice(-500) }), 10 * 60 * 1000);
    } catch (e) {
      resolve({ ok: false, output: e.message });
    }
  });
}

/** 代理环境变量（0.1.5+ 支持 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY） */
function getProxyEnv() {
  const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const out = {};
  for (const k of keys) {
    if (process.env[k]) out[k] = process.env[k];
  }
  return out;
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
  PREFERRED_PORT,
  // 动态只读属性：端口可能在启动时因冲突而退让
  get HARNESS_PORT() {
    return activePort;
  },
  get HARNESS_URL() {
    return getHarnessUrl();
  },
  getHarnessUrl,
  findFreePort,
  isPortOpen,
  isHarnessReady,
  isHarnessUsable,
  getLoadUrl,
  getAuthUrl,
  waitForHarness,
  findDshEntry,
  ensureHarnessRunning,
  stopHarnessIfOwned,
  autoInstallDsh,
  killDshWebOnPort,
  setExtraPatches,
  buildWebArgs,
  buildSpawnEnv,
  getLocalDshVersion,
  getLatestDshVersion,
  isNewerVersion,
  upgradeDsh,
  getProxyEnv,
  get startedByUs() {
    return startedByUs;
  },
  get guardPatchesApplied() {
    return guardPatchesApplied;
  },
};
