/**
 * DeepSeek 余额查询模块（纯 Node，可脱离 Electron 测试）
 *
 * API Key 解析优先级（通用版）：
 *   1. 环境变量 DEEPSEEK_API_KEY
 *   2. 应用配置文件：$DSH_DESKTOP_CONFIG 指定的 JSON / 或 ~/.dsh-desktop/config.json
 *      支持两种字段：
 *        "apiKey"          —— 明文（向后兼容）
 *        "apiKeyEncrypted" —— base64(safeStorage 加密结果)，由设置面板写入
 *   3. 兼容读取 DeepSeek Harness 凭据：$DSH_HOME/.credentials.yaml
 *
 * 加密由 Electron 的 safeStorage 完成；本模块不依赖 electron，
 * 通过 setDecryptAdapter 注入解密函数，保证纯 Node 下可测。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');

const BALANCE_API = 'https://api.deepseek.com/user/balance';

/** 解密适配器（由 main.js 注入 safeStorage.decryptString） */
let decryptAdapter = null;

/**
 * 注入解密函数。
 * @param {(buf:Buffer)=>string} fn
 */
function setDecryptAdapter(fn) {
  decryptAdapter = typeof fn === 'function' ? fn : null;
}

/** 应用配置文件路径 */
function configFilePath() {
  if (process.env.DSH_DESKTOP_CONFIG) return process.env.DSH_DESKTOP_CONFIG;
  if (process.env.DSH_DESKTOP_DATA_DIR) {
    return path.join(process.env.DSH_DESKTOP_DATA_DIR, 'config.json');
  }
  return path.join(os.homedir(), '.dsh-desktop', 'config.json');
}

/** 配置文件里允许出现的字段（说明文字放 README/docs，不写进 JSON） */
const CONFIG_KEYS = ['apiKey', 'apiKeyEncrypted'];

/** 首次运行时创建配置文件（此前只能靠用户照报错手搓） */
function ensureConfigFile() {
  const file = configFilePath();
  if (fs.existsSync(file)) return { created: false, path: file };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 只写真实字段：JSON 没有注释，带 `_` 前缀的"说明字段"会被当成真实配置，
    // 既可能被下游误读，也让"这个文件里允许有什么"变得含糊。
    fs.writeFileSync(file, JSON.stringify({ apiKey: '' }, null, 2), 'utf8');
    return { created: true, path: file };
  } catch (e) {
    return { created: false, path: file, error: e.message };
  }
}

/** 读取配置文件（容错） */
function readConfig() {
  try {
    const raw = fs.readFileSync(configFilePath(), 'utf8');
    const json = JSON.parse(raw);
    return json && typeof json === 'object' ? json : {};
  } catch {
    return {};
  }
}

/** 从配置里取加密的 key */
function readEncryptedKey() {
  const cfg = readConfig();
  const b64 = cfg.apiKeyEncrypted;
  if (typeof b64 !== 'string' || !b64.trim()) return null;
  if (!decryptAdapter) return null;
  try {
    return String(decryptAdapter(Buffer.from(b64, 'base64'))).trim() || null;
  } catch {
    return null;
  }
}

/** 读取应用自有配置文件中的明文 apiKey */
function readApiKeyFromAppConfig() {
  const cfg = readConfig();
  if (typeof cfg.apiKey === 'string' && cfg.apiKey.trim()) return cfg.apiKey.trim();
  return null;
}

/** 描述当前 key 的来源（绝不回传 key 本身） */
function describeApiKeySource() {
  if (process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY.trim()) {
    return 'env:DEEPSEEK_API_KEY';
  }
  if (readEncryptedKey()) return 'config:encrypted';
  if (readApiKeyFromAppConfig()) return 'config:plaintext';
  if (readApiKeyFromHarnessCredentials()) return 'harness:.credentials.yaml';
  return null;
}

/** 系统加密是否可用于保存 */
function isEncryptedKeyAvailable() {
  return Boolean(decryptAdapter);
}

/**
 * 保存 API Key 到配置文件。
 * @param {string} value
 * @param {(s:string)=>Buffer} [encrypt] - 加密函数；提供时写 apiKeyEncrypted，否则写明文
 */
function saveApiKey(value, encrypt) {
  const key = String(value || '').trim();
  if (!key) return { ok: false, error: 'API Key 不能为空' };
  if (!/^sk-[A-Za-z0-9_-]{8,}$/.test(key)) {
    return { ok: false, error: '格式看起来不对，DeepSeek API Key 通常以 sk- 开头' };
  }
  const file = configFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const cfg = readConfig();
    delete cfg.apiKey;
    delete cfg.apiKeyEncrypted;
    if (typeof encrypt === 'function') {
      cfg.apiKeyEncrypted = encrypt(key).toString('base64');
    } else {
      cfg.apiKey = key;
    }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
    return { ok: true, path: file, encrypted: typeof encrypt === 'function' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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
  const enc = readEncryptedKey();
  if (enc) return enc;
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
  CONFIG_KEYS,
  resolveApiKey,
  fetchBalance,
  getBalanceData,
  setDecryptAdapter,
  configFilePath,
  ensureConfigFile,
  readConfig,
  readEncryptedKey,
  describeApiKeySource,
  isEncryptedKeyAvailable,
  saveApiKey,
};
