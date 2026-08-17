/**
 * DSH Desktop - 主进程
 *
 * DeepSeek Harness 桌面端启动软件
 * - 检测/启动 dsh web 服务
 * - 加载完整预览版 Web UI
 * - 左下角实时显示 DeepSeek 账户余额
 */
'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');

const harness = require('./lib/harness');
const balance = require('./lib/balance');

const BALANCE_REFRESH_MS = 30 * 1000; // 余额实时刷新间隔 30s

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

function createMainWindow() {
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

  mainWindow.loadURL(harness.HARNESS_URL);

  // 外链用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-finish-load', () => {
    logService(`已连接 ${harness.HARNESS_URL}`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
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

  // 1. 确保服务运行
  const { started } = await harness.ensureHarnessRunning();
  logService(started ? 'dsh web 服务已由本应用启动' : '复用已运行的 dsh web 服务');

  // 2. 创建窗口
  createMainWindow();

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
