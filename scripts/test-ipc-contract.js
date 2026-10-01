/**
 * IPC 契约测试。
 *
 * 这类 bug 在无 GUI 的环境里最难发现：preload 调了一个主进程没注册的通道，
 * 或者主进程推的事件没人监听 —— 表现就是"按钮点了没反应"，而所有单元测试
 * 都能通过。这里用静态交叉比对把它们拦下来。
 *
 * 方向 A（渲染进程 → 主进程）：ipcRenderer.invoke/send/sendSync 必须有 ipcMain.handle/on
 * 方向 B（主进程 → 渲染进程）：webContents.send 必须有某个 preload 的 ipcRenderer.on
 *
 * 最后一段是**反向对照**：故意造出不匹配，确认这套检查确实能发现它们
 * （避免"检查永远通过"这种假保险）。
 *
 * 用法: node scripts/test-ipc-contract.js
 */
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'src', 'main.js');
const RENDERER_SCRIPTS = [
  path.join(ROOT, 'src', 'preload.js'),
  path.join(ROOT, 'src', 'panel-preload.js'),
];

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

const read = (f) => fs.readFileSync(f, 'utf8');

/** 收集所有匹配的捕获组 */
function collect(text, re) {
  const out = new Set();
  let m;
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = rx.exec(text)) !== null) out.add(m[1]);
  return out;
}

/**
 * 分析一组源码，返回注册/调用/监听集合与不匹配项。
 * 抽成纯函数以便用合成输入做反向对照。
 */
function analyze(mainText, rendererTexts) {
  const mainHandlers = new Set([
    ...collect(mainText, /ipcMain\.handle\(\s*'([^']+)'/g),
    ...collect(mainText, /ipcMain\.on\(\s*'([^']+)'/g),
  ]);
  const mainEmits = collect(mainText, /webContents\.send\(\s*'([^']+)'/g);

  const calls = new Set();
  const listens = new Set();
  for (const t of rendererTexts) {
    for (const c of collect(t, /ipcRenderer\.(?:invoke|send|sendSync)\(\s*'([^']+)'/g)) calls.add(c);
    for (const c of collect(t, /ipcRenderer\.on\(\s*'([^']+)'/g)) listens.add(c);
  }

  return {
    mainHandlers,
    mainEmits,
    calls,
    listens,
    missingHandlers: [...calls].filter((c) => !mainHandlers.has(c)).sort(),
    unheardEmits: [...mainEmits].filter((c) => !listens.has(c)).sort(),
  };
}

const mainSrc = read(MAIN);
const rendererTexts = RENDERER_SCRIPTS.map(read);
const real = analyze(mainSrc, rendererTexts);

console.log('=== IPC 契约测试 ===\n');
console.log('主进程注册通道 (' + real.mainHandlers.size + '): ' + [...real.mainHandlers].sort().join(', '));
console.log('主进程推送事件 (' + real.mainEmits.size + '): ' + [...real.mainEmits].sort().join(', '));
console.log('渲染进程调用   (' + real.calls.size + '): ' + [...real.calls].sort().join(', '));
console.log('渲染进程监听   (' + real.listens.size + '): ' + [...real.listens].sort().join(', '));
console.log('');

console.log('[1] 渲染进程调用的通道都已在主进程注册');
check(
  '无「调用未注册通道」的情况' + (real.missingHandlers.length ? '：' + real.missingHandlers.join(', ') : ''),
  () => assert.deepStrictEqual(real.missingHandlers, [], '未注册: ' + real.missingHandlers.join(', '))
);

console.log('\n[2] 主进程推送的事件都有渲染进程监听');
check(
  '无「推送无人监听」的情况' + (real.unheardEmits.length ? '：' + real.unheardEmits.join(', ') : ''),
  () => assert.deepStrictEqual(real.unheardEmits, [], '无人监听: ' + real.unheardEmits.join(', '))
);

console.log('\n[3] 关键通道存在性（防止误删）');
const REQUIRED_CALLS = [
  'balance:refresh',
  'peak:refresh',
  'peak:allow-temporarily',
  'peak:set-guard',
  'ui:get-hud',
  'ui:set-hud',
  'app:info',
  'app:quit',
  'settings:status',
  'settings:save-key',
  'settings:set-auto-launch',
  'settings:set-minimize-to-tray',
  'settings:open-config',
  'logs:read',
  'logs:clear',
  'logs:open-folder',
];
for (const ch of REQUIRED_CALLS) {
  check('渲染进程仍在使用 ' + ch, () => assert.ok(real.calls.has(ch), 'preload 未调用 ' + ch));
}
for (const ch of ['app:quit', 'settings:save-key', 'logs:read']) {
  check('主进程仍注册 ' + ch, () => assert.ok(real.mainHandlers.has(ch), 'main 未注册 ' + ch));
}

console.log('\n[4] 未使用的注册（仅提示，不算失败）');
const unused = [...real.mainHandlers].filter((c) => !real.calls.has(c)).sort();
console.log(unused.length ? '  note: ' + unused.join(', ') : '  （无）');

console.log('\n[5] 同步通道配对（sendSync 需要 ipcMain.on）');
check('ui:get-hud 用 ipcMain.on 注册', () =>
  assert.ok(/ipcMain\.on\(\s*'ui:get-hud'/.test(mainSrc), 'sendSync 对应的是 ipcMain.on'));
check('ui:get-hud 用 sendSync 调用', () =>
  assert.ok(
    rendererTexts.some((t) => /ipcRenderer\.sendSync\(\s*'ui:get-hud'/.test(t)),
    'preload 未用 sendSync 读取 HUD 位置'
  )
);

console.log('\n[6] 反向对照：这套检查必须能发现故意造出的不匹配');
const bogus = analyze(mainSrc, ["ipcRenderer.invoke('this:channel:does:not:exist')"]);
check('能发现「调用了未注册的通道」', () =>
  assert.ok(
    bogus.missingHandlers.includes('this:channel:does:not:exist'),
    '漏报了未注册通道: ' + JSON.stringify(bogus.missingHandlers)
  )
);
const bogus2 = analyze("mainWindow.webContents.send('nobody:listens', 1)", rendererTexts);
check('能发现「推送了无人监听的事件」', () =>
  assert.ok(
    bogus2.unheardEmits.includes('nobody:listens'),
    '漏报了无人监听事件: ' + JSON.stringify(bogus2.unheardEmits)
  )
);
check('反向对照不会误报正常源码', () => {
  const ok = analyze("ipcMain.handle('a:b', () => {})", ["ipcRenderer.invoke('a:b')"]);
  assert.deepStrictEqual(ok.missingHandlers, []);
});

console.log('\n=== 结果 ===');
console.log('通过 ' + passed + ' / ' + (passed + failed));
if (failed > 0) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');
