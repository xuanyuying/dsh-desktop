/**
 * 检查 agent preset 的插件 config 是否与当前 dsh 版本的 schema 兼容。
 * 用法: node scripts/check-preset.js [presetId]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const presetId = process.argv[2] || 'lite';
const presetDir = path.join(DSH_HOME, '.agent-presets', presetId);

// dsh 全局安装的 node_modules（插件所在）
const dshRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh');
const pluginRoots = [
  path.join(dshRoot, 'node_modules', '@deepseek-ai'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai'),
];

const PRESET_FILE = path.join(presetDir, 'agent.cordis.yml');
if (!fs.existsSync(PRESET_FILE)) {
  console.error('未找到 preset 文件: ' + PRESET_FILE);
  process.exit(1);
}

const text = fs.readFileSync(PRESET_FILE, 'utf8');

/** 从插件源码提取 Config 允许的字段名 */
function getPluginConfigFields(pkgName) {
  const short = pkgName.replace('@deepseek-ai/', '');
  for (const root of pluginRoots) {
    const pkgDir = path.join(root, short);
    const indexFile = path.join(pkgDir, 'lib', 'index.js');
    if (!fs.existsSync(indexFile)) continue;
    const src = fs.readFileSync(indexFile, 'utf8');
    // const Config = z.object({ ... })
    const m = src.match(/const Config\s*=\s*z\.object\(\{([\s\S]*?)\}\)/);
    if (!m) {
      // 没有 Config（无配置的插件）
      return { found: true, fields: null, pkgDir };
    }
    const body = m[1];
    const fields = [];
    const re = /(\w+):\s*z\./g;
    let mm;
    while ((mm = re.exec(body))) fields.push(mm[1]);
    return { found: true, fields, pkgDir };
  }
  return { found: false, fields: null };
}

/**
 * 粗解析 preset：提取每个 `- id:` 行块里的 name 与 config 字段。
 * 逐行扫描，遇到顶层 `- id:` 开始新块。
 */
function parseBlocks(src) {
  const lines = src.split('\n');
  const blocks = [];
  let cur = null;
  let inConfig = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\t/g, '  ');
    const mId = line.match(/^-\s+id:\s*(\S+)/);
    if (mId) {
      if (cur) blocks.push(cur);
      cur = { id: mId[1], name: null, configKeys: [], line: i + 1, disabled: false };
      inConfig = false;
      continue;
    }
    if (!cur) continue;
    const mName = line.match(/^\s+name:\s*['"]?([^'"\s]+)['"]?/);
    if (mName && !line.includes('id:')) cur.name = mName[1];
    if (/^\s+disabled:/.test(line)) cur.disabled = true;
    if (/^\s+config:\s*$/.test(line)) {
      inConfig = true;
      continue;
    }
    if (inConfig) {
      // config 下的键（缩进 4 空格）
      const mKey = line.match(/^ {4}(\w+):/);
      if (mKey) cur.configKeys.push(mKey[1]);
      // 遇到同级或更浅的键（如 - id: / name:）结束 config
      if (/^ {0,2}\S/.test(line) && line.trim() !== '') inConfig = false;
    }
  }
  if (cur) blocks.push(cur);
  return blocks;
}

const blocks = parseBlocks(text);
console.log('=== Preset 兼容性检查：' + presetId + ' ===\n');
console.log('文件: ' + PRESET_FILE + '\n');

let problems = 0;
for (const b of blocks) {
  if (!b.name || !b.name.startsWith('@deepseek-ai/')) continue;
  const info = getPluginConfigFields(b.name);
  if (!info.found) {
    console.log('[未安装] ' + b.id + ' → ' + b.name);
    continue;
  }
  if (b.configKeys.length === 0) continue; // 无 config，无需检查

  if (info.fields === null) {
    console.log('[!] ' + b.id + ' (' + b.name + ') 传了 config 但插件无 Config schema');
    console.log('    行 ' + b.line + ' config keys: ' + b.configKeys.join(', '));
    problems++;
    continue;
  }
  const bad = b.configKeys.filter((k) => !info.fields.includes(k));
  if (bad.length) {
    console.log('[X] ' + b.id + ' (' + b.name + ') 无效字段: ' + bad.join(', '));
    console.log('    行 ' + b.line + ' | 该版本允许: ' + info.fields.join(', '));
    problems++;
  } else {
    console.log('[OK] ' + b.id + ' (' + b.name + ')');
  }
}

console.log('\n=== 结果 ===');
if (problems === 0) {
  console.log('所有插件 config 与当前 dsh 版本兼容 ✓');
} else {
  console.log('发现 ' + problems + ' 处不兼容，需要修正');
}
process.exit(problems > 0 ? 1 : 0);
