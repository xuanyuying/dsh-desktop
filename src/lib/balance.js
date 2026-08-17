/**
 * DeepSeek 余额查询模块（纯 Node，可脱离 Electron 测试）
 *
 * API Key 解析优先级（通用版）：
 *   1. 环境变量 DEEPSEEK_API_KEY
 *   2. 应用配置文件：$DSH_DESKTOP_CONFIG 指定的 JSON / 或 ~/.dsh-desktop/config.json
 *      （格式: { "apiKey": "sk-..." }）
 *   3. 兼容读取 DeepSeek Harness 凭据：$DSH_HOME/.credentials.yaml
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const BALANCE_API = 'https://api.deepseek.com/user/balance';

/** 读取应用自有配置文件中的 apiKey（JSON: { "apiKey": "sk-..." }） */
function readApiKeyFromAppConfig() {
  const candidates = [];
  if (process.env.DSH_DESKTOP_CONFIG) {
    candidates.push(process.env.DSH_DESKTOP_CONFIG);
  }
  candidates.push(path.join(os.homedir(), '.dsh-desktop', 'config.json'));
  for (const file of candidates) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      const json = JSON.parse(text);
      if (typeof json.apiKey === 'string' && json.apiKey.trim()) {
        return json.apiKey.trim();
      }
    } catch {
      /* 忽略单个配置文件的读取/解析错误 */
    }
  }
  return null;
}

/** 兼容读取 DeepSeek Harness 凭据文件 */
function readApiKeyFromHarnessCredentials() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const credFile = path.join(home, '.credentials.yaml');
  try {
    const text = fs.readFileSync(credFile, 'utf8');
    const match = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*["']?([^"'\s]+)/m);
    if (match && match[1]) return match[1].trim();
  } catch {
    /* 忽略读取错误 */
  }
  return null;
}

/** 解析 DEEPSEEK API Key（通用版，无任何个人硬编码） */
function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  const fromAppConfig = readApiKeyFromAppConfig();
  if (fromAppConfig) return fromAppConfig;
  return readApiKeyFromHarnessCredentials();
}

/** 调用 DeepSeek 余额 API */
function fetchBalance(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      BALANCE_API,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        timeout: 15000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            resolve(json);
          } catch {
            reject(new Error(`余额接口返回非法数据: ${body.slice(0, 120)}`));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('余额接口请求超时'));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 拉取并整理余额（供 UI 消费的纯数据） */
async function getBalanceData(apiKey) {
  if (!apiKey) {
    return {
      ok: false,
      error:
        '未配置 DEEPSEEK_API_KEY（请设置环境变量，或创建 ~/.dsh-desktop/config.json 填入 { "apiKey": "sk-..." }）',
    };
  }
  try {
    const json = await fetchBalance(apiKey);
    if (!json || json.is_available === undefined) {
      return { ok: false, error: '余额接口返回异常' };
    }
    return {
      ok: true,
      isAvailable: json.is_available,
      balances: Array.isArray(json.balance_infos) ? json.balance_infos : [],
      fetchedAt: Date.now(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  BALANCE_API,
  resolveApiKey,
  fetchBalance,
  getBalanceData,
};
