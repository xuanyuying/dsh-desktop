# 代码签名与下载校验

## 现状（重要）

本项目**没有代码签名证书**，因此 Windows SmartScreen 会提示"未知发布者"，可能还需要点"更多信息 → 仍要运行"。

这是所有未签名开源 Windows 应用的共同情况，**不代表安装包有问题**。你可以用下面的办法自行核实。

## 如何核实下载的安装包

每次发布都会附上 `SHA256SUMS.txt`。下载安装包后：

```powershell
# 生成你下载文件的 SHA-256
Get-FileHash .\DSH Desktop Setup 1.3.2.exe -Algorithm SHA256 | Select-Object -ExpandProperty Hash

# 与发布页 SHA256SUMS.txt 里对应行比对（不区分大小写）
```

一致即说明文件完整且与发布者上传的完全相同。也可以用发布页的 GitHub Actions 构建产物比对。

本地生成校验和：

```powershell
node scripts\checksums.js   # 输出 dist\SHA256SUMS.txt
```

## 如果你有代码签名证书

electron-builder 原生支持通过环境变量签名，**无需改代码**：

```powershell
# PFX 文件（本地路径或 https URL 均可）
$env:CSC_LINK = 'C:\certs\my-cert.pfx'
$env:CSC_KEY_PASSWORD = '证书密码'

# 然后正常打包，electron-builder 会自动签名
node scripts\build-dist.js
```

或使用硬件令牌 / 云端签名：

```powershell
# 由自定义签名钩子接管（signtool 或云签名服务）
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'true'
```

配置好后，`dist\win-unpacked\DSH Desktop.exe` 与安装包都会被签名，SmartScreen 警告随之消失（证书需要一定信誉积累，新证书初期仍可能有提示）。

### 验证签名结果

```powershell
Get-AuthenticodeSignature '.\dist\win-unpacked\DSH Desktop.exe' |
  Format-List Status, SignerCertificate
```

`Status` 为 `Valid` 即签名成功。

## 关于本仓库的构建产物

- 安装包由 `node scripts\build-dist.js` 生成，走的是本地 Electron 发行版 + 本地 NSIS，**不下载** electron-builder 的默认工具链
- 构建脚本会打印它使用的每个工具的版本，便于复现
- CI（`.github/workflows/ci.yml`）只跑测试与打包资源校验，不产出签名安装包
