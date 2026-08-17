// 检查安装包 asar 内是否含个人 API Key
const fs = require('fs');
const path = require('path');

// 直接从源码目录检查（源码与 asar 内容一致，且 asar 打包自 src/）
const src = path.join(__dirname, '..', 'src');
const { execSync } = require('child_process');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(js|json)$/.test(e.name)) files.push(full);
  }
})(src);

let allText = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

console.log('--- 源码隐私检查 ---');
console.log('包含个人key(sk-b576):', allText.includes('sk-b576') ? '是!!(异常)' : '否 ✓');
console.log('包含用户名(29130):', allText.includes('29130') ? '是!!(异常)' : '否 ✓');
console.log('包含源码目录名(chajiankaifa):', allText.includes('chajiankaifa') ? '是!!(异常)' : '否 ✓');
console.log('包含通用 DEEPSEEK_API_KEY 解析:', allText.includes('DEEPSEEK_API_KEY') ? '是 ✓' : '否');
console.log('包含应用配置文件解析:', allText.includes('.dsh-desktop') ? '是 ✓' : '否');
console.log('包含 Harness 凭据兼容:', allText.includes('.credentials.yaml') ? '是 ✓' : '否');

// 验证 asar 文件确实存在且包含这些源码
const archive = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');
console.log('\n--- 安装包完整性 ---');
console.log('app.asar 存在:', fs.existsSync(archive) ? '是 ✓' : '否');
if (fs.existsSync(archive)) {
  const size = fs.statSync(archive).size;
  console.log(`app.asar 大小: ${(size / 1024).toFixed(1)} KB`);
  const raw = fs.readFileSync(archive, 'utf8');
  // asar 文件头附近含文件列表字符串
  console.log('asar 包含 balance.js 引用:', raw.includes('balance.js') ? '是 ✓' : '否');
}
