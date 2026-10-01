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
      // 真实 Electron 会克隆模板；这里保留同一批对象，以便断言
      // "构建后通过 id 取回的 MenuItem"确实被更新（这正是之前的 bug：
      // 改模板改到的是没人引用的副本）。
      const find = (id) => {
        const walk = (items) => {
          for (const it of items) {
            if (!it) continue;
            if (it.id === id) return it;
            if (Array.isArray(it.submenu)) {
              const f = walk(it.submenu);
              if (f) return f;
            }
          }
          return null;
        };
        return walk(tpl);
      };
      return { items: tpl, getMenuItemById: find };
    },
    setApplicationMenu: () => {},
  },
  shell: { openExternal: () => {} },
  app: { quit: () => {}, getVersion: () => '1.3.2' },
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
  setFloatHud: (v) => v,
  refreshPeakNow: () => true,
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
assert(labels[4].includes('帮助'), '菜单5: 帮助');
assert(labels[5].includes('时段与余额'), '菜单6: 最右侧状态菜单');
assert(capturedMenu[5].id === 'desk-status', '状态菜单带 id（动态更新需要）');
assert(
  labels[labels.length - 1].includes('时段与余额'),
  '状态菜单位于菜单栏最右端（帮助右侧）'
);
assert(
  labels.indexOf(labels.find((l) => l.includes('帮助'))) === 4,
  '帮助之后才是状态菜单'
);

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

// 6. 最右侧状态菜单（时段 + 余额）
const peakSub = capturedMenu[5].submenu;
const statusTop = capturedMenu[5];
const peakStatusItem = peakSub.find((i) => i.id === 'desk-status-period');
const peakCountdownItem = peakSub.find((i) => i.id === 'desk-status-countdown');
const peakBalItem = peakSub.find((i) => i.id === 'desk-status-bal');
const peakGuardItem = peakSub.find((i) => i.id === 'desk-status-guard');
const peakAllowItem = peakSub.find((i) => i.id === 'desk-status-allow');
const peakFloatItem = peakSub.find((i) => i.id === 'desk-status-float');
assert(peakStatusItem, '状态菜单→时段项存在');
assert(peakCountdownItem && peakCountdownItem.enabled === false, '状态菜单→倒计时项（只读）');
assert(peakBalItem && peakBalItem.enabled === false, '状态菜单→余额项（只读）');
assert(peakGuardItem, '状态菜单→零 token 消耗开关存在');
assert(peakGuardItem.checked === true, '状态菜单→守卫默认开启');
assert(peakAllowItem && peakAllowItem.enabled === false, '状态菜单→临时放行（空闲时不可用）');
assert(peakFloatItem && peakFloatItem.checked === true, '状态菜单→悬浮小卡默认开启（吸附在模式徽标右侧）');
assert(
  peakSub.some((i) => i.label === '官方计价说明'),
  '状态菜单→官方计价说明'
);

// 6.5 updatePeakMenu 动态刷新（必须作用在真实 MenuItem 上）
const baseBalance = {
  ok: true,
  balances: [{ currency: 'CNY', total_balance: '7.33', granted_balance: '0.00', topped_up_balance: '7.33' }],
  fetchedAt: new Date('2026-10-01T09:32:00').getTime(),
};

updatePeakMenu({
  isPeak: false,
  periodLabel: '空闲时段',
  discountLabel: '5 折',
  countdown: '2 小时',
  nextPeriodLabel: '高峰时段',
  guardEnabled: true,
  allowed: false,
  guardAlive: true,
  floatHud: false,
  balance: baseBalance,
  localPeakWindows: ['09:00–12:00', '14:00–18:00'],
  prices: [
    { label: 'Flash 输出', value: '$0.6 / 1M（高峰 $1.2）' },
    { label: 'V4-Pro 输出', value: '$1.98 / 1M（高峰 $3.96）' },
  ],
});
assert(
  statusTop.label.includes('空闲，2小时转高峰'),
  '菜单栏标签形如「空闲，<倒计时>转高峰」: ' + statusTop.label
);
assert(statusTop.label.includes('，余额：¥7.33'), '菜单栏标签带余额: ' + statusTop.label);
assert(statusTop.label.startsWith('空闲'), '标签以时段开头（无图标）: ' + statusTop.label);
assert(peakStatusItem.label.includes('空闲时段'), '详情显示空闲时段');
assert(peakCountdownItem.label.includes('2 小时') && peakCountdownItem.label.includes('高峰时段'), '详情显示倒计时: ' + peakCountdownItem.label);
assert(peakBalItem.label.includes('7.33') && peakBalItem.label.includes('09:32'), '详情显示余额与时间: ' + peakBalItem.label);
assert(peakSub.find((i) => i.id === 'desk-status-bal-sub').label.includes('赠金'), '详情显示赠金/充值');
assert(
  peakSub.find((i) => i.id === 'desk-status-windows').label.includes('09:00–12:00'),
  '详情显示本机高峰窗口'
);
assert(
  peakSub.find((i) => i.id === 'desk-status-prices').label.includes('Flash输出 $0.6/1M') &&
    peakSub.find((i) => i.id === 'desk-status-prices').label.includes('V4-Pro输出 $1.98/1M'),
  '详情显示当前价目: ' + peakSub.find((i) => i.id === 'desk-status-prices').label
);
assert(
  peakSub.some((i) => i.label === '重启服务以启用保护'),
  '详情提供「重启服务以启用保护」'
);
assert(peakAllowItem.enabled === false, '空闲时「临时放行」不可用');

updatePeakMenu({
  isPeak: true,
  periodLabel: '高峰时段',
  discountLabel: '标准价',
  countdown: '1 小时 30 分',
  nextPeriodLabel: '空闲时段',
  guardEnabled: true,
  allowed: false,
  guardAlive: true,
  balance: baseBalance,
});
assert(
  statusTop.label.includes('高峰，1小时30分转空闲'),
  '高峰时标签显示「高峰，<倒计时>转空闲」: ' + statusTop.label
);
assert(
  peakSub.find((i) => i.id === 'desk-status-guardstate').label.includes('运行中'),
  '详情说明守卫运行中（高峰不消耗 token）'
);
assert(peakAllowItem.enabled === true, '高峰且守卫开启时「临时放行」可用');

updatePeakMenu({
  isPeak: true,
  periodLabel: '高峰时段',
  discountLabel: '标准价',
  countdown: '1 小时',
  nextPeriodLabel: '空闲时段',
  guardEnabled: true,
  allowed: true,
  balance: baseBalance,
});
assert(peakAllowItem.label.includes('取消临时放行'), '已放行时菜单可取消: ' + peakAllowItem.label);
assert(
  peakSub.find((i) => i.id === 'desk-status-guardstate').label.includes('已临时放行'),
  '已放行时详情说明「高峰会消耗 token」'
);

updatePeakMenu({
  isPeak: true,
  periodLabel: '高峰时段',
  discountLabel: '标准价',
  countdown: '1 小时',
  nextPeriodLabel: '空闲时段',
  guardEnabled: false,
  allowed: false,
  balance: baseBalance,
});
assert(peakGuardItem.checked === false, '守卫关闭时复选框同步为未勾选');
assert(peakAllowItem.enabled === false, '守卫关闭时「临时放行」不可用');
assert(
  peakSub.find((i) => i.id === 'desk-status-guardstate').label.includes('已关闭'),
  '守卫关闭时详情明确说明高峰会消耗 token: ' +
    peakSub.find((i) => i.id === 'desk-status-guardstate').label
);
assert(
  statusTop.label.includes('高峰，1小时转空闲'),
  '守卫关闭时标签仍显示时段与倒计时: ' + statusTop.label
);

updatePeakMenu({
  isPeak: false,
  periodLabel: '空闲时段',
  discountLabel: '5 折',
  countdown: '1 小时',
  nextPeriodLabel: '高峰时段',
  guardEnabled: true,
  allowed: false,
  floatHud: true,
  balance: { ok: false, error: '未配置 DEEPSEEK_API_KEY' },
});
assert(statusTop.label.includes('不可用'), '余额不可用时最右端显示不可用: ' + statusTop.label);
assert(peakFloatItem.checked === true, '悬浮小卡开关同步');
assert(updatePeakMenu(undefined) === undefined, 'payload 为空时安全返回');

// 7. 帮助菜单
const helpItems = capturedMenu[4].submenu.map((i) => i.label || i.type);
assert(helpItems.includes('DeepSeek Harness 文档'), '帮助→官方文档');
assert(helpItems.includes('关于 DSH Desktop'), '帮助→关于');
assert(
  !helpItems.includes('检查 DSH Desktop 更新…'),
  '帮助栏不应再有「检查 DSH Desktop 更新」（已移到工具栏）'
);

// 7.5 新增的桌面端能力入口
assert(fileItems.includes('设置…'), '文件→设置');
assert(toolItems.includes('内置日志查看器…'), '工具→内置日志查看器');
assert(toolItems.includes('结束占用端口的 dsh 服务…'), '工具→结束占用端口的 dsh 服务');
assert(toolItems.includes('检查 DSH Desktop 更新…'), '工具→检查 DSH Desktop 更新');
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
