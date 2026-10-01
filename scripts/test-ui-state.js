/**
 * UI 状态持久化测试（窗口尺寸收敛 + HUD 位置）
 * 用法: node scripts/test-ui-state.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SANDBOX = path.join(os.tmpdir(), 'dsh-uistate-' + process.pid);
process.env.DSH_DESKTOP_UI_STATE = path.join(SANDBOX, 'ui-state.json');

const ui = require('../src/lib/ui-state.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    failures.push(name + ' → ' + e.message);
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

console.log('=== UI 状态持久化测试 ===\n');

console.log('[1] 窗口尺寸收敛到工作区');
check('1440×900 屏幕（工作区 1440×860）不超出底部', () => {
  const b = ui.clampBounds(
    { width: 1440, height: 900, x: 0, y: 0 },
    { x: 0, y: 0, width: 1440, height: 860 }
  );
  assert.strictEqual(b.height, 860, '高度应收敛到工作区');
  assert.ok(b.y + b.height <= 860, '底边不得超出工作区');
});
check('小屏 1366×768：窗口完整落在工作区内', () => {
  const wa = { x: 0, y: 0, width: 1366, height: 728 };
  const b = ui.clampBounds({ width: 1440, height: 900 }, wa);
  assert.ok(b.width <= wa.width, '宽度收敛');
  assert.ok(b.height <= wa.height, '高度收敛');
  assert.ok(b.x >= 0 && b.x + b.width <= wa.width, '水平不越界');
  assert.ok(b.y >= 0 && b.y + b.height <= wa.height, '垂直不越界');
});
check('无保存值时居中', () => {
  const b = ui.clampBounds(null, { x: 0, y: 0, width: 1000, height: 700 });
  assert.strictEqual(b.x, 0);
  assert.strictEqual(b.y, 0);
  assert.strictEqual(b.width, 1000);
  assert.strictEqual(b.height, 700);
});
check('副屏坐标（负 x）保持在工作区内', () => {
  const wa = { x: -1920, y: 0, width: 1920, height: 1040 };
  const b = ui.clampBounds({ x: -1900, y: 20, width: 1200, height: 800 }, wa);
  assert.ok(b.x >= -1920 && b.x + b.width <= 0, 'x 范围正确: ' + b.x);
  assert.ok(b.y >= 0 && b.y + b.height <= 1040);
});
check('越界的位置被拉回可视区', () => {
  const wa = { x: 0, y: 0, width: 1440, height: 860 };
  const b = ui.clampBounds({ x: 9999, y: -500, width: 1000, height: 700 }, wa);
  assert.ok(b.x + b.width <= wa.width, '右侧不越界');
  assert.ok(b.y >= 0, '顶部不越界');
});
check('不低于最小尺寸（工作区足够大时）', () => {
  const wa = { x: 0, y: 0, width: 2560, height: 1400 };
  const b = ui.clampBounds({ width: 100, height: 100 }, wa);
  assert.strictEqual(b.width, ui.MIN_WINDOW.width);
  assert.strictEqual(b.height, ui.MIN_WINDOW.height);
});
check('工作区比最小尺寸还小时不反超', () => {
  const wa = { x: 0, y: 0, width: 800, height: 500 };
  const b = ui.clampBounds({ width: 1440, height: 900 }, wa);
  assert.strictEqual(b.width, 800);
  assert.strictEqual(b.height, 500);
});

console.log('\n[2] 状态读写');
check('文件缺失 → 返回空对象，不抛错', () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  assert.deepStrictEqual(ui.loadState(), {});
});
check('saveState 合并写入、不覆盖未传字段', () => {
  ui.saveState({ window: { x: 1, y: 2, width: 800, height: 600 } });
  ui.saveState({ hud: { right: 20, top: 30, collapsed: false } });
  const s = ui.loadState();
  assert.strictEqual(s.window.x, 1);
  assert.strictEqual(s.hud.right, 20);
});
check('损坏的 JSON → 回落为空对象', () => {
  fs.writeFileSync(process.env.DSH_DESKTOP_UI_STATE, '{ 坏掉的', 'utf8');
  assert.deepStrictEqual(ui.loadState(), {});
});

console.log('\n[3] HUD 位置与开关');
check('默认：开启、吸附、未折叠、无手动坐标', () => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  assert.deepStrictEqual(ui.loadHud(), {
    left: null,
    top: null,
    collapsed: false,
    enabled: true,
    anchored: true,
  });
});
check('保存后能读回（跨端口不变，这是改用文件的核心目的）', () => {
  ui.saveHud({ left: 300, top: 480, collapsed: true, enabled: true, anchored: false });
  const h = ui.loadHud();
  assert.strictEqual(h.left, 300);
  assert.strictEqual(h.top, 480);
  assert.strictEqual(h.collapsed, true);
  assert.strictEqual(h.enabled, true, '悬浮小卡开关未持久化');
  assert.strictEqual(h.anchored, false, '拖动后应记住已解除吸附');
});
check('enabled 只有显式 false 才关闭（默认开启）', () => {
  assert.strictEqual(ui.normalizeHud({}).enabled, true);
  assert.strictEqual(ui.normalizeHud({ enabled: false }).enabled, false);
  assert.strictEqual(ui.normalizeHud({ enabled: true }).enabled, true);
});
check('anchored 只有显式 false 才解除（默认吸附）', () => {
  assert.strictEqual(ui.normalizeHud({}).anchored, true);
  assert.strictEqual(ui.normalizeHud({ anchored: false }).anchored, false);
});
check('旧版本结构（只有 right/top）升级后小卡仍显示', () => {
  const migrated = ui.normalizeHud({ right: 12, top: 12, collapsed: false });
  assert.strictEqual(migrated.enabled, true, '旧结构应迁移为默认开启');
  assert.strictEqual(migrated.anchored, true);
  assert.strictEqual(migrated.left, null);
});
check('非法值被归一化', () => {
  const h = ui.normalizeHud({ left: 'abc', top: NaN, collapsed: 'yes' });
  assert.strictEqual(h.left, null);
  assert.strictEqual(h.top, null);
  assert.strictEqual(h.collapsed, false);
});
check('超大坐标被夹到合理上限、负值被夹到 0', () => {
  const h = ui.normalizeHud({ left: 999999, top: -50 });
  assert.ok(h.left <= 8000, 'left=' + h.left);
  assert.strictEqual(h.top, 0, 'top=' + h.top);
});
check('saveHud 不影响 window 段', () => {
  ui.saveState({ window: { x: 7, y: 8, width: 900, height: 700 } });
  ui.saveHud({ left: 5, top: 6, collapsed: false });
  assert.strictEqual(ui.loadState().window.x, 7, 'window 段被 HUD 覆盖了');
});

fs.rmSync(SANDBOX, { recursive: true, force: true });
delete process.env.DSH_DESKTOP_UI_STATE;

console.log('\n=== 结果 ===');
console.log('通过 ' + passed + ' / ' + (passed + failed));
if (failed > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');
