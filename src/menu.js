/**
 * DSH Desktop - Application menu
 *
 * Standard desktop menu bar: File / Edit / View / Tools / Help
 */
'use strict';

const { Menu, shell, app } = require('electron');

/**
 * Build and set the application menu.
 * @param {object} handlers - callbacks provided by main.js
 *   { newSession, refreshPage, restartService, checkUpdate, openConfigDir,
 *     openInBrowser, showAbout, harnessUrl, getVersionInfo }
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
          label: '关于 DSH Desktop',
          click: () => handlers.showAbout(),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  return menu;
}

module.exports = { setupMenu };
