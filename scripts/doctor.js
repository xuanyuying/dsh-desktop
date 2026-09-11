/**
 * DSH Desktop 诊断工具
 * 输出运行环境、服务状态、认证状态，便于定位问题
 * 用法: node scripts/doctor.js
 */
'use strict';

const os = require('node:os');
const http = require('node:http');
const { execSync } = require('node:child_process');
const harness = require('../src/lib/harness');
const balance = require('../src/lib/balance');

function line(label, value) {
  console.log('  ' + label.padEnd(22, ' ') + value);
}

function probe(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.get(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: 6000 },
      (r) => {
        let body = '';
        r.on('data', (c) => (body += c));
        r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.code || e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, error: 'timeout' });
    });
  });
}

(async () => {
  console.log('=== DSH Desktop 诊断 ===\n');

  console.log('[环境]');
  line('操作系统', os.platform() + ' ' + os.release());
  line('Node.js', process.version);
  line('DSH_HOME', process.env.DSH_HOME || '(默认 ~/.dsh)');

  console.log('\n[dsh 安装]');
  const entry = harness.findDshEntry();
  line('入口', entry ? (entry.script || entry.command) : '未找到');
  line('版本', harness.getLocalDshVersion() || '未知');
  line('服务地址', harness.HARNESS_URL);

  console.log('\n[服务状态]');
  const portOpen = await harness.isPortOpen(harness.HARNESS_HOST, harness.HARNESS_PORT);
  line('端口监听', portOpen ? '是' : '否');
  if (portOpen) {
    const res = await probe(harness.HARNESS_URL + '/');
    if (res.status === 200) {
      line('HTTP 状态', '200 可直接访问（无需认证）');
      line('页面大小', (res.body || '').length + ' 字节');
      line('React root', (res.body || '').includes('id="root"') ? '存在' : '缺失');
    } else if (res.status === 401) {
      line('HTTP 状态', '401 需要认证（dsh 0.1.5+ 正常行为）');
      line('说明', 'DSH Desktop 会用启动时捕获的 token URL 自动认证');
    } else {
      line('HTTP 状态', res.status + (res.error ? ' (' + res.error + ')' : ''));
    }
  }

  console.log('\n[DSH Desktop 进程]');
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq DSH Desktop.exe" /NH', {
      encoding: 'utf8',
      windowsHide: true,
    });
    const count = (out.match(/DSH Desktop\.exe/g) || []).length;
    line('进程数', count + (count === 4 ? '（1 主 + 1 GPU + 1 网络 + 1 渲染 = 正常单实例）' : count === 0 ? '（未运行）' : ''));
  } catch {
    line('进程数', '查询失败');
  }

  console.log('\n[API Key]');
  const key = balance.resolveApiKey();
  line('状态', key ? '已配置 (' + key.slice(0, 6) + '...' + key.slice(-4) + ')' : '未配置');
  if (key) {
    const data = await balance.getBalanceData(key);
    line('余额查询', data.ok ? '成功' : '失败: ' + data.error);
    if (data.ok) {
      data.balances.forEach((b) => {
        line('  ' + b.currency, '总 ' + b.total_balance + '（赠 ' + b.granted_balance + ' / 充 ' + b.topped_up_balance + '）');
      });
    }
  }

  console.log('\n[代理配置]');
  const proxy = harness.getProxyEnv();
  const keys = Object.keys(proxy);
  if (keys.length) {
    keys.forEach((k) => line(k, proxy[k]));
  } else {
    line('状态', '未配置代理');
  }

  console.log('\n=== 诊断完成 ===');
  await new Promise((r) => setTimeout(r, 300));
  process.exit(0);
})();
