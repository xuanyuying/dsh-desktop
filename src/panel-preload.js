/**
 * DSH Desktop - 面板窗口 preload（设置 / 日志）
 *
 * 只暴露必要的 IPC；不暴露任何 Node 能力。
 * API Key 只在「保存」时单向送入主进程，绝不回读。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshPanel', {
  // 设置
  status: () => ipcRenderer.invoke('settings:status'),
  saveKey: (value) => ipcRenderer.invoke('settings:save-key', value),
  setAutoLaunch: (v) => ipcRenderer.invoke('settings:set-auto-launch', v),
  setMinimizeToTray: (v) => ipcRenderer.invoke('settings:set-minimize-to-tray', v),
  openConfig: () => ipcRenderer.invoke('settings:open-config'),

  // 日志
  readLog: () => ipcRenderer.invoke('logs:read'),
  clearLog: () => ipcRenderer.invoke('logs:clear'),
  openLogFolder: () => ipcRenderer.invoke('logs:open-folder'),

  close: () => window.close(),
});
