/**
 * 菜单模块测试（mock electron）
 * 用法: node scripts/test-menu.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) {
    passed++;
    console.log('  PASS: ' + name);
  } else {
    failed++;
    console.log('  FAIL: ' + name);
  }
}

// mock electron
let capturedMenu = null;
const mockElectron = {
  Menu: {
    buildFromTemplate: (tpl) => {
      capturedMenu = tpl;
      return { items: tpl };
    },
    setApplicationMenu: () => {},
  },
  shell: { openExternal: () => {} },
  app: { quit: () => {}, getVersion: () => '1.2.0' },
};

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'menu.js'), 'utf8');
const fakeModule = { exports: {} };
new Function('require', 'module', 'exports', src)((id) =>
  id === 'electron' ? mockElectron : require(id)
, fakeModule, fakeModule.exports);
const { setupMenu, updatePeakMenu } = fakeModule.exports;

console.log('=== 菜单模块测试 ===');

const handlers = {
  newSession: () => {},
  refreshPage: () => {},
  forceReload: () => {},
  toggleDevTools: () => {},
  restartService: () => {},
  checkUpdate: () => {},
  showStatus: () => {},
  showServiceLog: () => {},
  openConfigDir: () => {},
  openInBrowser: () => {},
  showAbout: () => {},
  showPeakStatus: () => {},
  restartForPeakGuard: () => {},
  setPeakGuard: () => {},
  allowPeakTemporarily: () => {},
  checkDesktopUpdate: () => {},
  openSettings: () => {},
  openLogs: () => {},
  kickPortOwner: () => {},
  toggleMinimizeToTray: (v) => v,
  isMinimizeToTray: () => false,
  setAutoLaunch: (v) => v,
  isAutoLaunchEnabled: () => false,
};

setupMenu(handlers);

// 1. 顶层菜单
assert(Array.isArray(capturedMenu), '菜单模板已生成');
const labels = capturedMenu.map((m) => m.label);
assert(labels.length === 6, '六个顶层菜单: ' + labels.join(' | '));
assert(labels[0].includes('文件'), '菜单1: 文件');
assert(labels[1].includes('编辑'), '菜单2: 编辑');
assert(labels[2].includes('视图'), '菜单3: 视图');
assert(labels[3].includes('工具'), '菜单4: 工具');
assert(labels[4].includes('峰谷'), '菜单5: 峰谷');
assert(labels[5].includes('帮助'), '菜单6: 帮助');

// 2. 文件菜单项
const fileItems = capturedMenu[0].submenu.map((i) => i.label || i.type);
assert(fileItems.includes('新建会话'), '文件→新建会话');
assert(fileItems.includes('刷新界面'), '文件→刷新界面');
assert(fileItems.includes('在浏览器中打开'), '文件→在浏览器中打开');
assert(fileItems.includes('打开配置目录'), '文件→打开配置目录');
assert(fileItems.includes('退出'), '文件→退出');

// 3. 编辑菜单（role）
const editRoles = capturedMenu[1].submenu.filter((i) => i.role).map((i) => i.role);
assert(editRoles.includes('undo') && editRoles.includes('copy') && editRoles.includes('paste') && editRoles.includes('selectAll'), '编辑菜单含标准 role: ' + editRoles.join(','));

// 4. 视图菜单
const viewItems = capturedMenu[2].submenu.map((i) => i.label || i.role || i.type);
assert(viewItems.includes('重新加载'), '视图→重新加载');
assert(viewItems.includes('全屏'), '视图→全屏');
assert(viewItems.includes('开发者工具'), '视图→开发者工具');
assert(capturedMenu[2].submenu.some((i) => i.role === 'resetZoom'), '视图→重置缩放 role');

// 5. 工具菜单（含 0.1.5 相关功能）
const toolItems = capturedMenu[3].submenu.map((i) => i.label || i.type);
assert(toolItems.includes('检查 dsh 更新…'), '工具→检查 dsh 更新');
assert(toolItems.includes('重启 dsh 服务'), '工具→重启 dsh 服务');
assert(toolItems.includes('查看服务状态'), '工具→查看服务状态');

// 6. 峰谷菜单
const peakSub = capturedMenu[4].submenu;
const peakStatusItem = peakSub[0];
const peakGuardItem = peakSub.find((i) => i.type === 'checkbox');
const peakAllowItem = peakSub.find((i) => String(i.label).includes('临时放行'));
assert(peakStatusItem && typeof peakStatusItem.label === 'string', '峰谷→状态项存在');
assert(peakGuardItem, '峰谷→零 token 消耗开关存在');
assert(peakGuardItem.checked === true, '峰谷→守卫默认开启');
assert(peakAllowItem, '峰谷→临时放行项存在');
assert(
  peakSub.some((i) => i.label === '查看时段详情…'),
  '峰谷→查看时段详情'
);
assert(
  peakSub.some((i) => i.label === '重启服务以启用保护'),
  '峰谷→重启服务以启用保护'
);
assert(
  peakSub.some((i) => i.label === '官方计价说明'),
  '峰谷→官方计价说明'
);

// 6.5 updatePeakMenu 动态刷新
updatePeakMenu({
  isPeak: false,
  periodLabel: '空闲时段',
  discountLabel: '5 折',
  countdown: '2 小时',
  guardEnabled: true,
  allowed: false,
});
assert(peakStatusItem.label.includes('空闲时段'), '空闲时菜单显示空闲时段: ' + peakStatusItem.label);
assert(peakStatusItem.label.includes('5 折'), '空闲时菜单显示 5 折');
assert(peakStatusItem.label.includes('2 小时'), '空闲时菜单显示倒计时');
assert(peakStatusItem.label.startsWith('🟢'), '空闲时图标为绿');
assert(peakAllowItem.enabled === false, '空闲时「临时放行」不可用');

updatePeakMenu({
  isPeak: true,
  periodLabel: '高峰时段',
  discountLabel: '标准价',
  countdown: '1 小时 30 分',
  guardEnabled: true,
  allowed: false,
});
assert(peakStatusItem.label.includes('高峰时段'), '高峰时菜单显示高峰时段');
assert(peakStatusItem.label.startsWith('🔴'), '高峰时图标为红');
assert(peakAllowItem.enabled === true, '高峰且守卫开启时「临时放行」可用');

updatePeakMenu({
  isPeak: true,
  periodLabel: '高峰时段',
  discountLabel: '标准价',
  countdown: '1 小时',
  guardEnabled: true,
  allowed: true,
});
assert(peakAllowItem.label.includes('取消临时放行'), '已放行时菜单可取消: ' + peakAllowItem.label);

updatePeakMenu({
  isPeak: true,
  periodLabel: '高峰时段',
  discountLabel: '标准价',
  countdown: '1 小时',
  guardEnabled: false,
  allowed: false,
});
assert(peakGuardItem.checked === false, '守卫关闭时复选框同步为未勾选');
assert(peakAllowItem.enabled === false, '守卫关闭时「临时放行」不可用');
assert(updatePeakMenu(undefined) === undefined, 'payload 为空时安全返回');

// 7. 帮助菜单
const helpItems = capturedMenu[5].submenu.map((i) => i.label || i.type);
assert(helpItems.includes('DeepSeek Harness 文档'), '帮助→官方文档');
assert(helpItems.includes('关于 DSH Desktop'), '帮助→关于');
assert(helpItems.includes('检查 DSH Desktop 更新…'), '帮助→检查 DSH Desktop 更新');

// 7.5 新增的桌面端能力入口
assert(fileItems.includes('设置…'), '文件→设置');
assert(toolItems.includes('内置日志查看器…'), '工具→内置日志查看器');
assert(toolItems.includes('结束占用端口的 dsh 服务…'), '工具→结束占用端口的 dsh 服务');
const viewChecks = capturedMenu[2].submenu.filter((i) => i.type === 'checkbox').map((i) => i.label);
assert(viewChecks.includes('关闭时最小化到托盘'), '视图→关闭时最小化到托盘');
assert(viewChecks.includes('开机自动启动'), '视图→开机自动启动');
assert(
  capturedMenu[2].submenu.find((i) => i.label === '关闭时最小化到托盘').checked === false,
  '最小化到托盘默认关闭（保持关闭即退出）'
);
assert(
  capturedMenu[2].submenu.find((i) => i.label === '开机自动启动').checked === false,
  '开机自启默认关闭'
);

// 8. 快捷键检查
const allItems = capturedMenu.flatMap((m) => m.submenu || []);
const accels = allItems.filter((i) => i.accelerator).map((i) => i.accelerator);
assert(accels.includes('CmdOrCtrl+N'), '新建会话 Ctrl+N');
assert(accels.includes('F5'), '刷新 F5');
assert(accels.includes('F11'), '全屏 F11');
assert(accels.includes('F12'), '开发者工具 F12');
assert(accels.includes('Alt+F4'), '退出 Alt+F4');

console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
