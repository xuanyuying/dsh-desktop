/**
 * DSH Desktop - Main process
 * - Single instance lock (prevent multi-open)
 * - Launch/reuse dsh web service
 * - Load full Web UI (with retry + service watch)
 * - Real-time balance display
 */
'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const harness = require('./lib/harness');
const balance = require('./lib/balance');
const { setupMenu } = require('./menu');

// ---------------------------------------------------------------------------
// File logging（便于诊断 GUI 问题：渲染错误、认证、WebSocket）
// ---------------------------------------------------------------------------
const LOG_DIR = path.join(os.homedir(), '.dsh-desktop');
const LOG_FILE = path.join(LOG_DIR, 'desktop.log');

function logToFile(line) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > 2 * 1024 * 1024) fs.writeFileSync(LOG_FILE, '');
    } catch {
      /* 文件不存在 */
    }
    fs.appendFileSync(LOG_FILE, '[' + new Date().toISOString() + '] ' + String(line) + '\n');
  } catch {
    /* 忽略日志写入失败 */
  }
}

function getLogFilePath() {
  return LOG_FILE;
}

const BALANCE_REFRESH_MS = 30 * 1000; // 30s balance refresh
const PAGE_LOAD_RETRY_MS = 3000;      // page reload retry interval
const PAGE_LOAD_MAX_RETRY = 5;        // max retry count

// ---------------------------------------------------------------------------
// Safe logging: packaged exe launched from desktop has invalid stdout pipe.
// console.log writing to stdout throws EPIPE: broken pipe => main process crash.
// Use safeLog (writes to stdout only if valid, silently ignores EPIPE).
// ---------------------------------------------------------------------------
function safeLog(...args) {
  try {
    if (process.stdout && !process.stdout.destroyed) {
      process.stdout.write(args.map(String).join(' ').trimEnd() + '\n');
    }
  } catch (e) {
    if (e && e.code !== 'EPIPE') {
      try {
        console.error(String(e && e.message));
      } catch {
        /* silent */
      }
    }
  }
}

// Guard stdout/stderr EPIPE and uncaught errors so the window stays alive.
try {
  process.stdout.on('error', (e) => { if (e && e.code === 'EPIPE') { /* ignore */ } });
  process.stderr.on('error', (e) => { if (e && e.code === 'EPIPE') { /* ignore */ } });
  process.on('uncaughtException', (err) => {
    try { process.stderr.write('[uncaught] ' + (err && err.message) + '\n'); } catch { /* silent */ }
  });
  process.on('unhandledRejection', (reason) => {
    try { process.stderr.write('[unhandledRejection] ' + (reason && reason.message) + '\n'); } catch { /* silent */ }
  });
} catch {
  /* ignore */
}

// ---------------------------------------------------------------------------
// Single instance lock
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  safeLog('[dsh-desktop] existing instance running, quit duplicate');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// Balance polling
// ---------------------------------------------------------------------------

let balanceTimer = null;
let apiKey = null;

async function refreshBalance() {
  const data = await balance.getBalanceData(apiKey);
  pushBalance(data);
}

function pushBalance(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('balance:update', data);
  }
}

function startBalancePolling() {
  if (balanceTimer) clearInterval(balanceTimer);
  refreshBalance();
  balanceTimer = setInterval(refreshBalance, BALANCE_REFRESH_MS);
}

function stopBalancePolling() {
  if (balanceTimer) {
    clearInterval(balanceTimer);
    balanceTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

let mainWindow = null;
let pageLoadRetry = 0;
let pageReady = false;
let pageWatchTimer = null;

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'DeepSeek Harness Desktop',
    autoHideMenuBar: false, // 显示顶部菜单栏
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // 窗口秒开：先显示启动提示页（等服务就绪后再加载真实界面）
  loadLoadingPage();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 捕获渲染进程 console（React/WebSocket/fetch 错误都在这里），写入日志文件
  mainWindow.webContents.on('console-message', (...args) => {
    try {
      let level, message, sourceId, lineNumber;
      // Electron 新版：(details)；旧版：(event, level, message, line, sourceId)
      if (args.length === 1 && args[0] && typeof args[0] === 'object' && 'message' in args[0]) {
        const d = args[0];
        level = d.level;
        message = d.message;
        sourceId = d.sourceId;
        lineNumber = d.lineNumber;
      } else {
        level = args[1];
        message = args[2];
        lineNumber = args[3];
        sourceId = args[4];
      }
      const levelNames = ['verbose', 'info', 'warning', 'error'];
      const lv = typeof level === 'number' ? levelNames[level] || level : level;
      // 只记录 warning/error，避免日志过载
      if (lv === 'warning' || lv === 'error') {
        logToFile('renderer[' + lv + '] ' + String(message).slice(0, 1500) + ' @ ' + String(sourceId || '').slice(-60) + ':' + lineNumber);
      }
    } catch {
      /* 忽略 */
    }
  });

  // 渲染进程崩溃
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logToFile('render-process-gone: ' + JSON.stringify(details));
    logService('render process gone: ' + (details && details.reason));
  });

  // 页面导航/重定向日志（诊断认证 303 流程）
  mainWindow.webContents.on('did-navigate', (_e, url, httpCode) => {
    logToFile('navigate: ' + String(url).replace(/token=[^&]+/, 'token=***') + (httpCode ? ' (http ' + httpCode + ')' : ''));
  });
  mainWindow.webContents.on('did-redirect-navigation', (_e, url, isInPlace, isMainFrame, frameProcessId, frameRoutingId) => {
    // 认证 303 重定向
    logToFile('redirect to: ' + String(url).replace(/token=[^&]+/, 'token=***'));
  });

  mainWindow.webContents.on('did-finish-load', () => {
    // 启动提示页（data:）不做渲染检查
    const curUrl = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : '';
    if (curUrl.startsWith('data:')) return;

    pageLoadRetry = 0;
    // 延迟检查：页面 HTML 加载完成不代表 React 已渲染。
    // 若 #root 无内容（React 未挂载），视为加载失败并重试。
    setTimeout(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const url2 = mainWindow.webContents.getURL();
      if (url2.startsWith('data:')) return;
      try {
        // 收集渲染诊断信息（写入日志，便于排查空白/交互失效）
        const info = await mainWindow.webContents.executeJavaScript(`(function () {
          try {
            var root = document.getElementById('root');
            var body = document.body;
            return JSON.stringify({
              rootLen: root ? root.innerHTML.length : -1,
              title: document.title || '',
              url: location.href.replace(/token=[^&]+/, 'token=***'),
              bodyText: body ? (body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160) : '',
              hasSidebar: !!document.querySelector('[class*="sidebar" i], [class*="Sidebar"]'),
              hasComposer: !!document.querySelector('textarea, [contenteditable="true"]'),
              errText: body && /error|failed|401|unauthor/i.test(body.innerText || '') ? (body.innerText || '').slice(0, 160) : ''
            });
          } catch (e) { return JSON.stringify({ err: String(e && e.message) }); }
        })()`);
        logToFile('render info: ' + info);

        let parsed = {};
        try {
          parsed = JSON.parse(info);
        } catch {
          /* 忽略 */
        }
        const len = typeof parsed.rootLen === 'number' ? parsed.rootLen : -1;

        if (len > 0) {
          pageReady = true;
          stopPageWatch();
          logService('UI rendered (root=' + len + ', sidebar=' + !!parsed.hasSidebar + ', composer=' + !!parsed.hasComposer + ')');
        } else {
          logService('page loaded but #root empty (React not mounted), retrying...');
          pageReady = false;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(harness.getLoadUrl());
          }
        }
      } catch (e) {
        logService('render check error: ' + e.message);
        pageReady = true; // 检查失败则视为已加载，避免死循环
      }
    }, 3000);
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // URL 可能带 ?token=... 查询串，用前缀匹配
    if (!isMainFrame) return;
    if (url && !url.startsWith(harness.HARNESS_URL)) return;
    pageReady = false;
    if (pageLoadRetry < PAGE_LOAD_MAX_RETRY) {
      pageLoadRetry++;
      logService('page load failed(' + code + ' ' + desc + '), retry ' + (PAGE_LOAD_RETRY_MS / 1000) + 's (' + pageLoadRetry + '/' + PAGE_LOAD_MAX_RETRY + ')');
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !pageReady) {
          mainWindow.loadURL(harness.getLoadUrl());
        }
      }, PAGE_LOAD_RETRY_MS);
    } else {
      logService('page retry exhausted, watching service...');
      startPageWatch();
    }
  });

  startPageWatch();

  mainWindow.on('closed', () => {
    stopPageWatch();
    mainWindow = null;
    pageLoadRetry = 0;
    pageReady = false;
  });
}

function loadMainPage() {
  pageReady = false;
  mainWindow.loadURL(harness.getLoadUrl());
}

/** 启动提示页（内联，窗口秒开时显示） */
function loadLoadingPage() {
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#0d1117;color:#8b949e;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}' +
    '.box{text-align:center}.logo{width:64px;height:64px;margin:0 auto 16px;border-radius:20px;' +
    'background:linear-gradient(135deg,#4d8dff,#5ad0fa);color:#fff;font-size:34px;font-weight:800;' +
    'display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(77,141,255,.35)}' +
    '.t{font-size:15px;margin-bottom:6px;color:#e6edf3}.s{font-size:12px}' +
    '.dot{display:inline-block;animation:b 1.4s infinite}@keyframes b{0%,100%{opacity:.3}50%{opacity:1}}' +
    '</style></head><body><div class="box"><div class="logo">D</div>' +
    '<div class="t">正在启动 DeepSeek Harness<span class="dot">…</span></div>' +
    '<div class="s">首次启动需要几秒钟，请稍候</div></div></body></html>';
  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

// ---------------------------------------------------------------------------
// Menu handlers
// ---------------------------------------------------------------------------

/**
 * 新建会话：真正点击 Harness 侧边栏的"新建会话"按钮。
 * 该按钮：button[aria-label="新建会话"|"New session"]（class 含 newSession），
 * 点击后调用前端 startSession() 创建工作区会话。
 * 找不到按钮时兜底重载界面。
 */
async function menuNewSession() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const hit = await mainWindow.webContents.executeJavaScript(`(function () {
      var selectors = [
        'button[aria-label="新建会话"]',
        'button[aria-label="New session"]',
        'button[aria-label="New Session"]',
        '[class*="newSession"]',
        '[class*="_newSession"]'
      ];
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i]);
        if (el) {
          el.click();
          return selectors[i];
        }
      }
      return null;
    })()`);

    if (hit) {
      logService('new session: clicked "' + hit + '"');
      return;
    }
    // 兜底：可能仍停留在启动页/401，重新加载界面
    logService('new session button not found, reloading UI');
    await reloadUI();
  } catch (e) {
    logService('new session failed: ' + e.message);
    try {
      await reloadUI();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 统一重载：已认证（有 dsh-auth cookie）时用裸 URL，
 * 否则用带 token 的 URL（token 可重复使用）。
 */
async function reloadUI() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const authed = await hasAuthCookie();
  const target = authed ? harness.HARNESS_URL + '/' : harness.getLoadUrl();
  pageReady = false;
  mainWindow.loadURL(target);
}

async function menuRefreshPage() {
  await reloadUI();
}

function menuForceReload() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  pageReady = false;
  mainWindow.webContents.reloadIgnoringCache();
}

function menuToggleDevTools() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.toggleDevTools();
}

async function menuRestartService() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'question',
    buttons: ['重启服务', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '重启 dsh 服务',
    message: '确定要重启 dsh web 服务吗？',
    detail: '当前会话界面会短暂断开，服务重启后自动重新连接。',
  });
  if (choice !== 0) return;

  logService('restarting dsh service...');
  pageReady = false;
  harness.stopHarnessIfOwned();
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const { started } = await harness.ensureHarnessRunning();
    logService(started ? 'dsh service restarted' : 'dsh service reused');
  } catch (e) {
    logService('restart failed: ' + e.message);
  }
}

/** 检查 dsh 更新（结合官方 0.1.5+ 版本） */
async function menuCheckUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  logService('checking dsh updates...');
  const local = harness.getLocalDshVersion();
  const latest = await harness.getLatestDshVersion();

  if (!latest) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '检查更新',
      message: '无法获取最新版本',
      detail: '请检查网络连接后重试。\n当前版本：' + (local || '未知'),
    });
    return;
  }

  const hasUpdate = harness.isNewerVersion(latest, local);
  if (!hasUpdate) {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '检查更新',
      message: '已是最新版本',
      detail: '当前 dsh 版本：' + (local || '未知') + '\n最新版本：' + latest,
    });
    return;
  }

  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    buttons: ['立即升级', '稍后'],
    defaultId: 0,
    cancelId: 1,
    title: '发现新版本',
    message: 'dsh 有新版本可用：' + latest,
    detail:
      '当前版本：' + (local || '未知') +
      '\n最新版本：' + latest +
      '\n\n升级会通过 npm 全局安装最新版 dsh（约 1-3 分钟），完成后建议重启服务。',
  });
  if (choice !== 0) return;

  logService('upgrading dsh to ' + latest + ' ...');
  const result = await harness.upgradeDsh('latest');
  if (result.ok) {
    const newVersion = harness.getLocalDshVersion();
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '升级完成',
      message: 'dsh 已升级到 ' + (newVersion || latest),
      detail: '建议重启 dsh 服务以生效。是否现在重启？',
      buttons: ['重启服务', '稍后'],
      defaultId: 0,
    }).then((r) => {
      if (r.response === 0) menuRestartService();
    });
  } else {
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '升级失败',
      message: 'dsh 升级失败',
      detail: result.output || '请检查网络或手动执行：npm install -g @deepseek-ai/dsh@latest',
    });
  }
}

/** 显示服务状态 */
async function menuShowStatus() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const ready = await harness.isHarnessReady();
  const local = harness.getLocalDshVersion();
  const proxy = harness.getProxyEnv();
  const proxyText = Object.keys(proxy).length
    ? Object.entries(proxy).map(([k, v]) => k + '=' + v).join('\n')
    : '（未配置代理）';
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '服务状态',
    message: ready ? 'dsh 服务运行中' : 'dsh 服务未就绪',
    detail:
      '服务地址：' + harness.HARNESS_URL +
      '\n服务状态：' + (ready ? '正常 (HTTP 200)' : '不可用') +
      '\n服务来源：' + (harness.startedByUs ? '由本应用启动' : '复用外部服务') +
      '\ndsh 版本：' + (local || '未知') +
      '\nDSH Desktop：v' + app.getVersion() +
      '\n\n代理环境：\n' + proxyText,
  });
}

/** 显示服务日志（简要） */
function menuShowServiceLog() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '服务日志',
    message: '日志输出位置',
    detail:
      'dsh 服务日志输出到应用控制台（stderr）。\n\n' +
      '如需查看详细日志，可：\n' +
      '1. 在"视图 → 开发者工具"中查看渲染日志\n' +
      '2. 或手动运行 dsh web 观察终端输出\n\n' +
      '服务地址：' + harness.HARNESS_URL,
  });
}

/** 打开 dsh 配置目录 */
function menuOpenConfigDir() {
  const home = process.env.DSH_HOME || path.join(require('node:os').homedir(), '.dsh');
  shell.openPath(home).then((err) => {
    if (err && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '打开目录失败',
        message: err,
        detail: '路径：' + home,
      });
    }
  });
}

function menuOpenInBrowser() {
  shell.openExternal(harness.HARNESS_URL);
}

/** 打开日志文件（或所在目录） */
function menuOpenLogFile() {
  const file = getLogFilePath();
  if (fs.existsSync(file)) {
    shell.openPath(file).then((err) => {
      if (err && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: '打开日志失败',
          message: err,
          detail: '日志路径：' + file,
        });
      }
    });
  } else {
    shell.openPath(LOG_DIR);
  }
}

/** 关于对话框 */
function menuShowAbout() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const local = harness.getLocalDshVersion();
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '关于 DSH Desktop',
    message: 'DSH Desktop v' + app.getVersion(),
    detail:
      'DeepSeek Harness 桌面版\n\n' +
      '内嵌完整 Harness Web 界面，右下角实时显示账户余额。\n\n' +
      'dsh 版本：' + (local || '未知') +
      '\n服务地址：' + harness.HARNESS_URL +
      '\nElectron：' + process.versions.electron +
      '\nChromium：' + process.versions.chrome +
      '\n\n项目主页：https://github.com/xuanyuying/dsh-desktop',
    buttons: ['确定', '打开项目主页'],
    defaultId: 0,
  }).then((r) => {
    if (r.response === 1) {
      shell.openExternal('https://github.com/xuanyuying/dsh-desktop');
    }
  });
}

/** 初始化菜单栏 */
function initMenu() {
  setupMenu({
    newSession: menuNewSession,
    refreshPage: menuRefreshPage,
    forceReload: menuForceReload,
    toggleDevTools: menuToggleDevTools,
    restartService: menuRestartService,
    checkUpdate: menuCheckUpdate,
    showStatus: menuShowStatus,
    showServiceLog: menuShowServiceLog,
    openConfigDir: menuOpenConfigDir,
    openInBrowser: menuOpenInBrowser,
    openLogFile: menuOpenLogFile,
    showAbout: menuShowAbout,
  });
}

// Watch dsh service: reload page when service becomes reachable and page not ready.
// 限次重载，避免认证失败时无限循环。
let pageWatchReloads = 0;
const PAGE_WATCH_MAX_RELOADS = 5;

/**
 * 检测 Electron session 中是否已有 dsh 认证 cookie。
 * 有 cookie 时说明 token 已兑换成功，直接用裸 URL 即可访问。
 */
async function hasAuthCookie() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: harness.HARNESS_URL + '/' });
    return Array.isArray(cookies) && cookies.some((c) => String(c.name).startsWith('dsh-auth'));
  } catch {
    return false;
  }
}

function startPageWatch() {
  stopPageWatch();
  pageWatchReloads = 0;
  pageWatchTimer = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || pageReady) return;
    if (pageWatchReloads >= PAGE_WATCH_MAX_RELOADS) {
      logService('page watch gave up after ' + pageWatchReloads + ' reloads');
      stopPageWatch();
      return;
    }
    // 服务在监听（任意 HTTP 响应）即可尝试加载
    const alive = await harness.isHarnessReady();
    if (!alive) return;

    // 认证状态判定（任一成立即可加载）：
    //  1) 已有 token URL（首次加载用它完成认证）
    //  2) 已有认证 cookie（认证完成，裸 URL 可直接访问）
    //  3) 服务无需认证（旧版 dsh 返回 200）
    const hasToken = !!harness.getAuthUrl();
    const authed = await hasAuthCookie();
    if (!hasToken && !authed) {
      const usable = await harness.isHarnessUsable();
      if (!usable) return; // 需认证但尚无凭证：等待 bootstrap 完成
    }

    // 已认证后优先用裸 URL（避免重复 token 兑换）
    const target = authed ? harness.HARNESS_URL + '/' : harness.getLoadUrl();
    const cur = mainWindow.webContents.getURL();
    if (cur === target || (authed && cur === harness.HARNESS_URL + '/')) {
      return; // 已在目标页，等待渲染检查结果
    }
    pageWatchReloads++;
    logService('service reachable, loading UI (' + pageWatchReloads + '/' + PAGE_WATCH_MAX_RELOADS + ')');
    mainWindow.loadURL(target);
  }, 5000);
}

function stopPageWatch() {
  if (pageWatchTimer) {
    clearInterval(pageWatchTimer);
    pageWatchTimer = null;
  }
}

function logService(msg) {
  const line = '[dsh] ' + String(msg).trim();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('service:log', line);
  }
  safeLog(line);
  logToFile(line);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcMain.handle('app:info', () => ({
  harnessUrl: harness.HARNESS_URL,
  harnessRunning: harness.startedByUs ? 'self' : 'external',
  apiKeyConfigured: !!apiKey,
  version: app.getVersion(),
}));

ipcMain.handle('balance:refresh', () => refreshBalance());

ipcMain.on('app:quit', () => {
  shutdownApp();
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function bootstrap() {
  apiKey = balance.resolveApiKey();

  // 0. 初始化菜单栏
  initMenu();

  // 1. 窗口秒开（显示启动提示页）
  createMainWindow();
  logService('window opened, starting dsh service...');

  // 2. 确保服务可用并捕获认证 token（dsh 0.1.5+ 需要带 token 的 URL）
  try {
    const result = await harness.ensureHarnessRunning();
    const state = result && result.started ? 'launched' : 'reused';
    const tokenState = result && result.authUrl ? 'token captured' : 'no token needed';
    logService('dsh web service ' + state + ' (' + tokenState + ')');
  } catch (err) {
    logService('service launch error: ' + err.message);
  }

  // 3. 加载真实界面（在服务就绪、token 已捕获之后）
  if (mainWindow && !mainWindow.isDestroyed()) {
    loadMainPage();
  }

  // 4. 余额轮询
  startBalancePolling();
}

function shutdownApp() {
  stopBalancePolling();
  const stopped = harness.stopHarnessIfOwned();
  if (stopped) logService('closed dsh service launched by app');
  app.quit();
}

// Headless test mode: electron . --headless-test
async function headlessTest() {
  safeLog('=== DSH Desktop headless test ===');
  apiKey = balance.resolveApiKey();
  safeLog('API Key: ' + (apiKey ? 'configured (' + apiKey.slice(0, 6) + '...)' : 'not configured'));

  const { started } = await harness.ensureHarnessRunning();
  safeLog('Harness: ' + (started ? 'launched' : 'reused') + ' @ ' + harness.HARNESS_URL);

  const data = await balance.getBalanceData(apiKey);
  if (data.ok) {
    const lines = data.balances.map(
      (b) => b.currency + ' total ' + b.total_balance + ' (granted ' + b.granted_balance + ' / topped ' + b.topped_up_balance + ')'
    );
    safeLog('Balance: ' + lines.join('; '));
    safeLog('Available: ' + data.isAvailable);
  } else {
    safeLog('Balance fetch failed: ' + data.error);
  }

  harness.stopHarnessIfOwned();
  safeLog('=== headless test done ===');
  app.exit(0);
}

if (process.argv.includes('--headless-test')) {
  app.whenReady().then(() => headlessTest().catch((err) => {
    safeLog('headless test failed: ' + err.message);
    app.exit(1);
  }));
} else {
  app.whenReady().then(async () => {
    try {
      await bootstrap();
    } catch (err) {
      safeLog('[dsh-desktop] bootstrap failed: ' + err.message);
      createMainWindow();
      mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('fatal:error', String(err.message || err));
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      shutdownApp();
    }
  });
}
