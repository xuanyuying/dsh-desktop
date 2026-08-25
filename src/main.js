/**
 * DSH Desktop - Main process
 * - Single instance lock (prevent multi-open)
 * - Launch/reuse dsh web service
 * - Load full Web UI (with retry + service watch)
 * - Real-time balance display
 */
'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');

const harness = require('./lib/harness');
const balance = require('./lib/balance');

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
    autoHideMenuBar: true,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  loadMainPage();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    pageLoadRetry = 0;
    // 延迟检查：页面 HTML 加载完成不代表 React 已渲染。
    // 若 #root 无内容（React 未挂载），视为加载失败并重试。
    setTimeout(async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        const len = await mainWindow.webContents.executeJavaScript(
          'document.getElementById("root") ? document.getElementById("root").innerHTML.length : -1'
        );
        if (len > 0) {
          pageReady = true;
          stopPageWatch();
          logService('UI rendered (#root len=' + len + ')');
        } else {
          logService('page loaded but #root empty (React not mounted), retrying...');
          pageReady = false;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(harness.HARNESS_URL);
          }
        }
      } catch (e) {
        logService('render check error: ' + e.message);
        pageReady = true; // 检查失败则视为已加载，避免死循环
      }
    }, 3000);
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || url !== harness.HARNESS_URL) return;
    pageReady = false;
    if (pageLoadRetry < PAGE_LOAD_MAX_RETRY) {
      pageLoadRetry++;
      logService('page load failed(' + code + ' ' + desc + '), retry ' + (PAGE_LOAD_RETRY_MS / 1000) + 's (' + pageLoadRetry + '/' + PAGE_LOAD_MAX_RETRY + ')');
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !pageReady) {
          mainWindow.loadURL(harness.HARNESS_URL);
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
  mainWindow.loadURL(harness.HARNESS_URL);
}

// Watch dsh service: once available and page not ready, auto-reload.
function startPageWatch() {
  stopPageWatch();
  pageWatchTimer = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || pageReady) return;
    const ready = await harness.isHarnessReady();
    if (ready && !pageReady) {
      logService('dsh service available, auto reload...');
      mainWindow.loadURL(harness.HARNESS_URL);
    }
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

  // 1. Open window immediately (fast), page loaded by service watch
  createMainWindow();
  logService('window opened, waiting for dsh service...');

  // 2. Ensure service running (async, not blocking window)
  try {
    const { started } = await harness.ensureHarnessRunning();
    logService(started ? 'dsh web service launched by app' : 'reusing running dsh web service');
  } catch (err) {
    logService('service launch error: ' + err.message);
  }

  // 3. Start balance polling
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
