/**
 * DSH Desktop - 主进程
 *
 * DeepSeek Harness 桌面端启动软件
 * - 检测/启动 dsh web 服务（单实例锁防多开）
 * - 加载完整预览版 Web UI（含加载失败重试）
 * - 右下角实时显示 DeepSeek 账户余额
 */
'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');

const harness = require('./lib/harness');
const balance = require('./lib/balance');

const BALANCE_REFRESH_MS = 30 * 1000; // 余额实时刷新间隔 30s
const PAGE_LOAD_RETRY_MS = 3000;      // 页面加载失败重试间隔
const PAGE_LOAD_MAX_RETRY = 5;        // 页面加载最大重试次数

// ---------------------------------------------------------------------------
// 单实例锁：防止多次启动导致多个 Electron 进程与多个 dsh 服务
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在运行，退出当前实例
  console.log('[dsh-desktop] 已有实例运行，退出重复启动');
  app.quit();
} else {
  // 第二个实例启动时，聚焦已有窗口
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// 余额轮询
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
// 窗口
// ---------------------------------------------------------------------------

let mainWindow = null;
let pageLoadRetry = 0;
let pageReady = false;
let pageWatchTimer = null;

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return; // 防重复创建

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

  // 外链用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    pageLoadRetry = 0;
    pageReady = true;
    stopPageWatch();
    logService(`已连接 ${harness.HARNESS_URL}`);
  });

  // 页面加载失败：重试（服务可能还在启动）
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || url !== harness.HARNESS_URL) return;
    pageReady = false;
    if (pageLoadRetry < PAGE_LOAD_MAX_RETRY) {
      pageLoadRetry++;
      logService(`页面加载失败(${code} ${desc})，${PAGE_LOAD_RETRY_MS / 1000}s 后重试 (${pageLoadRetry}/${PAGE_LOAD_MAX_RETRY})`);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !pageReady) {
          mainWindow.loadURL(harness.HARNESS_URL);
        }
      }, PAGE_LOAD_RETRY_MS);
    } else {
      logService('页面加载重试次数已用尽，持续监听服务可用性...');
      startPageWatch();
    }
  });

  // 持续监听兜底：无论加载成功与否，服务后启动时自动重载
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

/**
 * 持续监听 dsh 服务可用性：一旦服务可用且页面未就绪，自动重新加载。
 * 解决"服务启动慢 / 服务后启动"导致页面空白、双击不显示的问题。
 */
function startPageWatch() {
  stopPageWatch();
  pageWatchTimer = setInterval(async () => {
    if (!mainWindow || mainWindow.isDestroyed() || pageReady) return;
    const ready = await harness.isHarnessReady();
    if (ready && !pageReady) {
      logService('检测到 dsh 服务可用，自动重新加载页面...');
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
  const line = `[dsh] ${msg.trim()}`;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('service:log', line);
  }
  console.log(line);
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
// 生命周期
// ---------------------------------------------------------------------------

async function bootstrap() {
  apiKey = balance.resolveApiKey();

  // 1. 立即创建窗口（秒开），页面由服务监听自动加载
  createMainWindow();
  logService('窗口已打开，等待 dsh 服务...');

  // 2. 异步确保服务运行（不阻塞窗口打开）
  try {
    const { started } = await harness.ensureHarnessRunning();
    logService(started ? 'dsh web 服务已由本应用启动' : '复用已运行的 dsh web 服务');
  } catch (err) {
    logService(`服务启动异常: ${err.message}`);
  }

  // 3. 启动余额轮询
  startBalancePolling();
}

function shutdownApp() {
  stopBalancePolling();
  const stopped = harness.stopHarnessIfOwned();
  if (stopped) logService('已关闭本应用启动的 dsh 服务');
  app.quit();
}

/**
 * 无 GUI 测试模式：验证服务启动与余额获取，随后自动退出。
 * 用法: electron . --headless-test
 */
async function headlessTest() {
  console.log('=== DSH Desktop headless test ===');
  apiKey = balance.resolveApiKey();
  console.log(`API Key: ${apiKey ? '已配置 (' + apiKey.slice(0, 6) + '...)' : '未配置'}`);

  const { started } = await harness.ensureHarnessRunning();
  console.log(`Harness: ${started ? '已由本应用启动' : '复用已运行服务'} @ ${harness.HARNESS_URL}`);

  const data = await balance.getBalanceData(apiKey);
  if (data.ok) {
    const lines = data.balances.map(
      (b) => `${b.currency} 总余额 ${b.total_balance}（赠金 ${b.granted_balance} / 充值 ${b.topped_up_balance}）`
    );
    console.log(`余额: ${lines.join('; ')}`);
    console.log(`服务可用: ${data.isAvailable}`);
  } else {
    console.log(`余额获取失败: ${data.error}`);
  }

  harness.stopHarnessIfOwned();
  console.log('=== headless test done ===');
  app.exit(0);
}

if (process.argv.includes('--headless-test')) {
  app.whenReady().then(() => headlessTest().catch((err) => {
    console.error('headless test 失败:', err.message);
    app.exit(1);
  }));
} else {
  app.whenReady().then(async () => {
    try {
      await bootstrap();
    } catch (err) {
      console.error('[dsh-desktop] 启动失败:', err.message);
      // 失败时仍打开窗口，展示错误信息
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
