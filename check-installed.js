const asar = require('@electron/asar');
const archive = 'D:/deep seek harness/DSH Desktop/resources/app.asar';
const list = asar.listPackage(archive);
console.log('asar 文件:', list.join(', '));
// 用 list 中的原始路径
const mainPath = list.find(f => f.endsWith('main.js'));
const preloadPath = list.find(f => f.endsWith('preload.js'));
const pkgPath = list.find(f => f.endsWith('package.json'));
const mainSrc = asar.extractFile(archive, mainPath).toString('utf8');
console.log('\n=== main.js ===');
console.log('requestSingleInstanceLock:', mainSrc.includes('requestSingleInstanceLock') ? 'OK 有' : 'MISSING 无（问题根源）');
const preloadSrc = asar.extractFile(archive, preloadPath).toString('utf8');
console.log('preload z-index 2147483647:', preloadSrc.includes('2147483647') ? '是' : '否');
console.log('\n=== package.json ===');
console.log(asar.extractFile(archive, pkgPath).toString('utf8'));
