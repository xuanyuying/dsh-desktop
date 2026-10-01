/**
 * DSH Desktop - Application menu
 *
 * Standard desktop menu bar: File / Edit / View / Tools / Help
 */
'use strict';

const { Menu, shell, app } = require('electron');

// 峰谷菜单项需动态更新（时段与倒计时每秒级变化），因此保留引用。
// MenuItem 的 label/checked 在原位可变，无需重建整个菜单。
let peakStatusItem = null;
let peakAllowItem = null;
let peakGuardItem = null;
let minimizeToTrayItem = null;
let autoLaunchItem = null;
let currentMenu = null;

/**
 * 刷新峰谷菜单显示。
 * @param {object} payload - main.js 的 buildPeakPayload() 结果
 */
function updatePeakMenu(payload) {
  if (!payload) return;
  if (peakStatusItem) {
    const icon = payload.isPeak ? '🔴' : '🟢';
    peakStatusItem.label =
      icon + ' ' + payload.periodLabel + ' · ' + payload.discountLabel + ' · ' + payload.countdown;
  }
  if (peakGuardItem) {
    peakGuardItem.checked = payload.guardEnabled !== false;
  }
  if (peakAllowItem) {
    // 高峰且守卫启用时才有「放行」的意义
    peakAllowItem.enabled = Boolean(payload.isPeak) && payload.guardEnabled !== false;
    peakAllowItem.label = payload.allowed
      ? '取消临时放行（恢复零消耗）'
      : '临时放行至本时段结束';
  }
  if (currentMenu && process.platform === 'darwin') {
    // macOS 的菜单标题不随属性变化，需要重新设置
    Menu.setApplicationMenu(currentMenu);
  }
}

/**
 * Build and set the application menu.
 * @param {object} handlers - callbacks provided by main.js
 *   { newSession, refreshPage, restartService, checkUpdate, openConfigDir,
 *     openInBrowser, showAbout, showPeakStatus, restartForPeakGuard,
 *     setPeakGuard, allowPeakTemporarily }
 */
function setupMenu(handlers) {
  const template = [
    // ---------------- File ----------------
    {
      label: '文件(F)',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: () => handlers.newSession(),
        },
        {
          label: '刷新界面',
          accelerator: 'CmdOrCtrl+R',
          click: () => handlers.refreshPage(),
        },
        { type: 'separator' },
        {
          label: '在浏览器中打开',
          click: () => handlers.openInBrowser(),
        },
        {
          label: '打开配置目录',
          click: () => handlers.openConfigDir(),
        },
        {
          label: '设置…',
          accelerator: 'CmdOrCtrl+,',
          click: () => handlers.openSettings(),
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: 'Alt+F4',
          click: () => app.quit(),
        },
      ],
    },

    // ---------------- Edit ----------------
    {
      label: '编辑(E)',
      submenu: [
        { label: '撤销', role: 'undo', accelerator: 'CmdOrCtrl+Z' },
        { label: '重做', role: 'redo', accelerator: 'CmdOrCtrl+Y' },
        { type: 'separator' },
        { label: '剪切', role: 'cut', accelerator: 'CmdOrCtrl+X' },
        { label: '复制', role: 'copy', accelerator: 'CmdOrCtrl+C' },
        { label: '粘贴', role: 'paste', accelerator: 'CmdOrCtrl+V' },
        { label: '全选', role: 'selectAll', accelerator: 'CmdOrCtrl+A' },
      ],
    },

    // ---------------- View ----------------
    {
      label: '视图(V)',
      submenu: [
        {
          label: '重新加载',
          accelerator: 'F5',
          click: () => handlers.refreshPage(),
        },
        {
          label: '强制重新加载',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => handlers.forceReload(),
        },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn', accelerator: 'CmdOrCtrl+Plus' },
        { label: '缩小', role: 'zoomOut', accelerator: 'CmdOrCtrl+-' },
        { label: '重置缩放', role: 'resetZoom', accelerator: 'CmdOrCtrl+0' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen', accelerator: 'F11' },
        {
          label: '开发者工具',
          accelerator: 'F12',
          click: () => handlers.toggleDevTools(),
        },
        { type: 'separator' },
        (minimizeToTrayItem = {
          label: '关闭时最小化到托盘',
          type: 'checkbox',
          checked:
            typeof handlers.isMinimizeToTray === 'function'
              ? handlers.isMinimizeToTray() === true
              : false,
          click: (item) => {
            const actual = handlers.toggleMinimizeToTray(item.checked);
            item.checked = actual === true;
          },
        }),
        (autoLaunchItem = {
          label: '开机自动启动',
          type: 'checkbox',
          checked:
            typeof handlers.isAutoLaunchEnabled === 'function'
              ? handlers.isAutoLaunchEnabled() === true
              : false,
          click: (item) => {
            const actual = handlers.setAutoLaunch(item.checked);
            item.checked = actual === true;
          },
        }),
      ],
    },

    // ---------------- Tools ----------------
    {
      label: '工具(T)',
      submenu: [
        {
          label: '检查 dsh 更新…',
          click: () => handlers.checkUpdate(),
        },
        {
          label: '重启 dsh 服务',
          click: () => handlers.restartService(),
        },
        { type: 'separator' },
        {
          label: '查看服务状态',
          click: () => handlers.showStatus(),
        },
        {
          label: '打开日志文件',
          click: () => handlers.openLogFile(),
        },
        {
          label: '打开服务日志',
          click: () => handlers.showServiceLog(),
        },
        {
          label: '内置日志查看器…',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => handlers.openLogs(),
        },
        { type: 'separator' },
        {
          label: '结束占用端口的 dsh 服务…',
          click: () => handlers.kickPortOwner(),
        },
      ],
    },

    // ---------------- Peak / Off-peak ----------------
    {
      label: '峰谷(P)',
      submenu: [
        (peakStatusItem = {
          label: '🟢 时段判定中…',
          click: () => handlers.showPeakStatus(),
        }),
        { type: 'separator' },
        (peakGuardItem = {
          label: '高峰时段零 token 消耗',
          type: 'checkbox',
          checked: true,
          click: (item) => handlers.setPeakGuard(item.checked),
        }),
        (peakAllowItem = {
          label: '临时放行至本时段结束',
          click: () => handlers.allowPeakTemporarily(),
        }),
        { type: 'separator' },
        {
          label: '查看时段详情…',
          click: () => handlers.showPeakStatus(),
        },
        {
          label: '重启服务以启用保护',
          click: () => handlers.restartForPeakGuard(),
        },
        { type: 'separator' },
        {
          label: '官方计价说明',
          click: () => shell.openExternal('https://api-docs.deepseek.com/quick_start/pricing'),
        },
      ],
    },

    // ---------------- Help ----------------
    {
      label: '帮助(H)',
      submenu: [
        {
          label: 'DeepSeek Harness 文档',
          click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness'),
        },
        {
          label: 'DSH Desktop 项目主页',
          click: () => shell.openExternal('https://github.com/xuanyuying/dsh-desktop'),
        },
        {
          label: '反馈问题',
          click: () => shell.openExternal('https://github.com/xuanyuying/dsh-desktop/issues'),
        },
        { type: 'separator' },
        {
          label: '检查 DSH Desktop 更新…',
          click: () => handlers.checkDesktopUpdate(),
        },
        {
          label: '关于 DSH Desktop',
          click: () => handlers.showAbout(),
        },
      ],
    },
  ];

  currentMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(currentMenu);
  return currentMenu;
}

module.exports = { setupMenu, updatePeakMenu };
