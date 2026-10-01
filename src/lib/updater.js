/**
 * DSH Desktop 自身更新（纯逻辑 + 网络，可在 Node 下单测）。
 *
 * 走 GitHub Releases：查最新 release → 比版本 → 下载安装包 → 交给调用方启动。
 * 不引入 electron-updater 依赖，避免打包时多一层 node_modules 收集与签名约束。
 */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { URL } = require('node:url');

/** 按 URL 协议选择传输模块（http 用于本地测试/镜像） */
function transportFor(url) {
  return url.protocol === 'http:' ? http : https;
}

const REPO = 'xuanyuying/dsh-desktop';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const USER_AGENT = 'DSH-Desktop-Updater';

/** 解析版本号为可比较的分段 */
function parseVersion(v) {
  const s = String(v || '')
    .trim()
    .replace(/^v/i, '');
  const [core, pre = ''] = s.split('-');
  const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
  while (nums.length < 3) nums.push(0);
  return { nums, pre };
}

/**
 * 比较版本。
 * @returns {number} a>b → 1；a<b → -1；相等 → 0
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const x = pa.nums[i] || 0;
    const y = pb.nums[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  // 正式版 > 预发布版
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && !pb.pre) return -1;
  if (pa.pre === pb.pre) return 0;
  return pa.pre > pb.pre ? 1 : -1;
}

/** remote 是否比 local 新 */
function isNewer(local, remote) {
  return compareVersions(remote, local) > 0;
}

/** 从 release 的 assets 里挑出 Windows 安装包 */
function pickInstallerAsset(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const exes = list.filter(
    (a) => a && typeof a.name === 'string' && /\.exe$/i.test(a.name) && !/blockmap/i.test(a.name)
  );
  if (exes.length === 0) return null;
  // 优先 electron-builder 的 "Xxx Setup 1.2.3.exe"
  const setup = exes.find((a) => /setup/i.test(a.name));
  return setup || exes[0];
}

/**
 * 解析 GitHub release JSON 为更新信息。
 * @returns {{version:string, tag:string, htmlUrl:string, notes:string,
 *   installer:{name:string, url:string, size:number}|null}}
 */
function parseRelease(json) {
  const tag = String((json && json.tag_name) || '');
  const version = tag.replace(/^v/i, '');
  const asset = pickInstallerAsset(json && json.assets);
  return {
    version,
    tag,
    htmlUrl: String((json && json.html_url) || ''),
    notes: String((json && json.body) || '').slice(0, 4000),
    installer: asset
      ? {
          name: asset.name,
          url: asset.browser_download_url,
          size: Number(asset.size) || 0,
        }
      : null,
  };
}

/** 简单 GET，返回解析后的 JSON */
function httpGetJson(url, { timeoutMs = 15000, headers = {} } = {}) {
  return new Promise((resolve) => {
    let req;
    try {
      const parsed = new URL(url);
      req = transportFor(parsed).get(
        parsed,
        { headers: { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT, ...headers } },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              resolve({ ok: false, error: `HTTP ${res.statusCode}` });
              return;
            }
            try {
              resolve({ ok: true, json: JSON.parse(body) });
            } catch (e) {
              resolve({ ok: false, error: '响应不是合法 JSON: ' + e.message });
            }
          });
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: '请求超时' });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.setTimeout(timeoutMs);
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/** 查询最新 release */
async function fetchLatestRelease(opts = {}) {
  const r = await httpGetJson(opts.apiUrl || API_LATEST, opts);
  if (!r.ok) return r;
  return { ok: true, release: parseRelease(r.json) };
}

/**
 * 下载安装包（跟随跳转）。
 * @param {string} url
 * @param {string} dest
 * @param {{timeoutMs?:number, onProgress?:(received:number,total:number)=>void, redirects?:number}} opts
 * @returns {Promise<{ok:boolean, path?:string, bytes?:number, error?:string}>}
 */
function downloadFile(url, dest, opts = {}) {
  const { timeoutMs = 10 * 60 * 1000, onProgress, redirects = 5 } = opts;
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      resolve({ ok: false, error: '非法 URL: ' + e.message });
      return;
    }
    let req;
    try {
      req = transportFor(parsed).get(
        parsed,
        { headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream' } },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirects <= 0) {
              resolve({ ok: false, error: '跳转次数过多' });
              return;
            }
            const nextUrl = new URL(res.headers.location, parsed).href;
            downloadFile(nextUrl, dest, { ...opts, redirects: redirects - 1 }).then(resolve);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            resolve({ ok: false, error: `HTTP ${res.statusCode}` });
            return;
          }
          const total = Number(res.headers['content-length']) || 0;
          let received = 0;
          try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
          } catch {
            /* 目录已存在 */
          }
          const out = fs.createWriteStream(dest);
          res.on('data', (c) => {
            received += c.length;
            if (typeof onProgress === 'function') {
              try {
                onProgress(received, total);
              } catch {
                /* 进度回调失败不影响下载 */
              }
            }
          });
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve({ ok: true, path: dest, bytes: received })));
          out.on('error', (e) => resolve({ ok: false, error: e.message }));
          res.on('error', (e) => resolve({ ok: false, error: e.message }));
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: '下载超时' });
      });
      req.setTimeout(timeoutMs);
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
    } catch (e) {
      resolve({ ok: false, error: e.message });
    }
  });
}

/** 安装包落地路径 */
function installerPath(dir, version, name) {
  const safe = String(name || `DSH Desktop Setup ${version}.exe`).replace(/[\\/:*?"<>|]/g, '_');
  return path.join(dir, safe);
}

module.exports = {
  REPO,
  API_LATEST,
  parseVersion,
  compareVersions,
  isNewer,
  pickInstallerAsset,
  parseRelease,
  fetchLatestRelease,
  downloadFile,
  installerPath,
  httpGetJson,
};
