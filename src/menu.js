/**
 * DSH Desktop - Application menu
 *
 * 标准菜单栏：文件 / 编辑 / 视图 / 工具 / 帮助，最右侧是一个**实时状态菜单**
 * （时段与余额），它显示在「帮助」右边。
 *
 * 为什么把时段/余额放在菜单栏而不是页面上浮动：
 *   - 原生菜单永远不会遮挡 Web 内容，也不会抢走页面里的点击
 *   - 悬停即可展开全部细节，比浮层更"桌面软件"
 *
 * 实现要点：`Menu.buildFromTemplate()` 会**克隆**模板对象，之后改模板是无效的。
 * 因此所有需要动态更新的项都带 `id`，构建后用 `getMenuItemById` 取回**真实
 * MenuItem** 再改属性 —— 改模板只会改到一个没人引用的副本（这是之前的 bug）。
 */
'use strict';

const { Menu, shell, app } = require('electron');

let currentMenu = null;
/** id → 真实 MenuItem（构建后解析） */
const live = new Map();
/** 最近一次的状态包，供菜单点击时读取 */
let lastPayload = null;

function item(id) {
  return live.get(id) || null;
}

function setLabel(id, text) {
  const it = item(id);
  if (it && it.label !== text) it.label = text;
}

function setEnabled(id, on) {
  const it = item(id);
  if (it && it.enabled !== on) it.enabled = on;
}

/** 「余额」一行文本 */
function balanceLine(payload) {
  const b = payload && payload.balance;
  if (!b) return '余额：读取中…';
  if (!b.ok) return '余额：不可用';
  const list = b.balances || [];
  const cny = list.find((x) => (x.currency || '').toUpperCase() === 'CNY') || list[0];
  if (!cny) return '余额：查询中…';
  return '余额：¥' + cny.total_balance + ' · ' + timeOf(b.fetchedAt);
}

function timeOf(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 去掉倒计时里的空格，让菜单栏标签更紧凑：'2 小时 30 分' → '2小时30分' */
function compactCountdown(text) {
  return String(text || '').replace(/\s+/g, '');
}

/**
 * 菜单栏标签：时段、倒计时与余额。
 * 形如：空闲，2小时30分转高峰，余额：¥7.33
 */
function statusTitle(payload) {
  if (!payload) return '时段与余额';

  const period = payload.isPeak ? '高峰' : '空闲';
  const next = payload.isPeak ? '空闲' : '高峰';
  const left = compactCountdown(payload.countdown);
  return period + '，' + left + '转' + next + '，余额：' + moneyOf(payload);
}

/** 余额文本（¥金额 / 不可用 / —） */
function moneyOf(payload) {
  const b = payload && payload.balance;
  if (!b) return '—';
  if (!b.ok) return '不可用';
  const list = b.balances || [];
  const cny = list.find((x) => (x.currency || '').toUpperCase() === 'CNY') || list[0];
  return cny ? '¥' + cny.total_balance : '—';
}

/** 价目压成一行：'Flash 输出 $0.6/1M · V4-Pro 输出 $1.98/1M' */
function priceLine(payload) {
  const list = payload && payload.prices;
  if (!Array.isArray(list) || list.length === 0) return '当前价目：—';
  const parts = list.map((p) => {
    const cur = String(p.value || '').split('（')[0].replace(/\s+/g, '');
    return String(p.label || '').replace(/\s+/g, '') + ' ' + cur;
  });
  return '当前价目：' + parts.join(' · ');
}

/** 守卫状态一行（说明"高峰到底会不会消耗 token"） */
function guardLine(payload) {
  if (payload.guardEnabled === false) {
    return '守卫：已关闭 —— 高峰会正常消耗 token';
  }
  if (payload.isPeak && payload.allowed) {
    return '守卫：已临时放行 —— 高峰会消耗 token';
  }
  if (payload.guardAlive) {
    return payload.isPeak
      ? '守卫：运行中 —— 高峰不消耗任何 token'
      : '守卫：待命（进入高峰自动拦截）';
  }
  return '守卫：⚠ 未生效，请用下方「重启服务以启用保护」';
}

/**
 * 刷新最右侧状态菜单。
 * @param {object} payload - main.js 的 buildPeakPayload()（含 balance 字段）
 */
function updatePeakMenu(payload) {
  if (!payload) return;
  lastPayload = payload;

  setLabel('desk-status', statusTitle(payload));

  const s = payload;
  setLabel(
    'desk-status-period',
    (s.periodLabel || '') + ' · ' + (s.discountLabel || '')
  );
  setLabel(
    'desk-status-countdown',
    (s.countdown || '') + ' 后进入' + (s.nextPeriodLabel || '')
  );
  setLabel('desk-status-guardstate', guardLine(payload));
  setLabel('desk-status-bal', balanceLine(payload));

  // 赠金 / 充值明细
  const b = payload.balance;
  let sub = ' ';
  if (b && b.ok) {
    const list = b.balances || [];
    const cny = list.find((x) => (x.currency || '').toUpperCase() === 'CNY') || list[0];
    if (cny) {
      sub = '  赠金 ¥' + cny.granted_balance + ' · 充值 ¥' + cny.topped_up_balance;
    }
  } else if (b && !b.ok && b.error) {
    sub = '  ' + String(b.error).slice(0, 60);
  }
  setLabel('desk-status-bal-sub', sub);

  // 本机高峰窗口与当前价目（让「点击后看到详细信息」名副其实）
  setLabel(
    'desk-status-windows',
    '高峰窗口（本机）：' + ((payload.localPeakWindows || []).join('、') || '—')
  );
  setLabel('desk-status-prices', priceLine(payload));

  const guard = item('desk-status-guard');
  if (guard && guard.checked !== (payload.guardEnabled !== false)) {
    guard.checked = payload.guardEnabled !== false;
  }

  const allow = item('desk-status-allow');
  if (allow) {
    allow.enabled = Boolean(payload.isPeak) && payload.guardEnabled !== false;
    const label = payload.allowed ? '取消临时放行（恢复零消耗）' : '临时放行至本时段结束';
    if (allow.label !== label) allow.label = label;
  }

  const floatItemRef = item('desk-status-float');
  if (floatItemRef && floatItemRef.checked !== (payload.floatHud === true)) {
    floatItemRef.checked = payload.floatHud === true;
  }

  if (currentMenu && process.platform === 'darwin') {
    // macOS 的菜单标题不随属性变化，需要重新设置
    Menu.setApplicationMenu(currentMenu);
  }
}

/**
 * Build and set the application menu.
 * @param {object} handlers - callbacks provided by main.js
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
        {
          id: 'desk-view-min-tray',
          label: '关闭时最小化到托盘',
          type: 'checkbox',
          checked:
            typeof handlers.isMinimizeToTray === 'function'
              ? handlers.isMinimizeToTray() === true
              : false,
          click: (it) => {
            it.checked = handlers.toggleMinimizeToTray(it.checked) === true;
          },
        },
        {
          id: 'desk-view-autolaunch',
          label: '开机自动启动',
          type: 'checkbox',
          checked:
            typeof handlers.isAutoLaunchEnabled === 'function'
              ? handlers.isAutoLaunchEnabled() === true
              : false,
          click: (it) => {
            it.checked = handlers.setAutoLaunch(it.checked) === true;
          },
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
        {
          label: '内置日志查看器…',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => handlers.openLogs(),
        },
        { type: 'separator' },
        {
          label: '检查 DSH Desktop 更新…',
          click: () => handlers.checkDesktopUpdate(),
        },
        { type: 'separator' },
        {
          label: '结束占用端口的 dsh 服务…',
          click: () => handlers.kickPortOwner(),
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

    // ---------------- 状态（时段 + 余额）----------------
    // 紧接「帮助」之后；点击展开全部细节
    {
      id: 'desk-status',
      label: '时段与余额',
      submenu: [
        { id: 'desk-status-period', label: '时段判定中…', enabled: false },
        { id: 'desk-status-countdown', label: '…', enabled: false },
        { id: 'desk-status-guardstate', label: '守卫：判定中…', enabled: false },
        { type: 'separator' },
        { id: 'desk-status-bal', label: '余额：读取中…', enabled: false },
        { id: 'desk-status-bal-sub', label: ' ', enabled: false },
        { type: 'separator' },
        { id: 'desk-status-windows', label: '高峰窗口（本机）：—', enabled: false },
        { id: 'desk-status-prices', label: '当前价目：—', enabled: false },
        { type: 'separator' },
        {
          id: 'desk-status-guard',
          label: '高峰时段零 token 消耗',
          type: 'checkbox',
          checked: true,
          click: (it) => handlers.setPeakGuard(it.checked),
        },
        {
          id: 'desk-status-allow',
          label: '临时放行至本时段结束',
          // 首次收到状态前不可点（空闲时放行没有意义）
          enabled: false,
          click: () => handlers.allowPeakTemporarily(),
        },
        { label: '重启服务以启用保护', click: () => handlers.restartForPeakGuard() },
        { type: 'separator' },
        {
          id: 'desk-status-float',
          label: '在页面上显示悬浮小卡',
          type: 'checkbox',
          // 默认开启：小卡吸附在会话标题旁「XX模式」徽标右侧
          checked: true,
          click: (it) => handlers.setFloatHud(it.checked),
        },
        { label: '查看时段与余额详情…', click: () => handlers.showPeakStatus() },
        { label: '刷新', click: () => handlers.refreshPeakNow() },
        { type: 'separator' },
        {
          label: '官方计价说明',
          click: () => shell.openExternal('https://api-docs.deepseek.com/quick_start/pricing'),
        },
      ],
    },
  ];

  currentMenu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(currentMenu);

  // 关键：从**构建后的菜单**取回真实 MenuItem。
  // 模板对象在 buildFromTemplate 时被克隆，继续改模板是无效的。
  live.clear();
  for (const id of [
    'desk-status',
    'desk-status-period',
    'desk-status-countdown',
    'desk-status-guardstate',
    'desk-status-bal',
    'desk-status-bal-sub',
    'desk-status-windows',
    'desk-status-prices',
    'desk-status-guard',
    'desk-status-allow',
    'desk-status-float',
    'desk-view-min-tray',
    'desk-view-autolaunch',
  ]) {
    const found = currentMenu.getMenuItemById(id);
    if (found) live.set(id, found);
  }

  return currentMenu;
}

/** 供测试与诊断：当前解析到的真实菜单项 id */
function liveMenuIds() {
  return [...live.keys()];
}

module.exports = { setupMenu, updatePeakMenu, liveMenuIds };
