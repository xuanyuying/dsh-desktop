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
const { setupMenu } = fakeModule.exports;

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
};

setupMenu(handlers);

// 1. 顶层菜单
assert(Array.isArray(capturedMenu), '菜单模板已生成');
const labels = capturedMenu.map((m) => m.label);
assert(labels.length === 5, '五个顶层菜单: ' + labels.join(' | '));
assert(labels[0].includes('文件'), '菜单1: 文件');
assert(labels[1].includes('编辑'), '菜单2: 编辑');
assert(labels[2].includes('视图'), '菜单3: 视图');
assert(labels[3].includes('工具'), '菜单4: 工具');
assert(labels[4].includes('帮助'), '菜单5: 帮助');

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

// 6. 帮助菜单
const helpItems = capturedMenu[4].submenu.map((i) => i.label || i.type);
assert(helpItems.includes('DeepSeek Harness 文档'), '帮助→官方文档');
assert(helpItems.includes('关于 DSH Desktop'), '帮助→关于');

// 7. 快捷键检查
const allItems = capturedMenu.flatMap((m) => m.submenu || []);
const accels = allItems.filter((i) => i.accelerator).map((i) => i.accelerator);
assert(accels.includes('CmdOrCtrl+N'), '新建会话 Ctrl+N');
assert(accels.includes('F5'), '刷新 F5');
assert(accels.includes('F11'), '全屏 F11');
assert(accels.includes('F12'), '开发者工具 F12');
assert(accels.includes('Alt+F4'), '退出 Alt+F4');

console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
