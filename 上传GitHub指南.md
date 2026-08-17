# 上传到 GitHub 开源社区 - 操作指南

本项目的 Git 仓库已在本机初始化并完成首次提交，只差「创建 GitHub 远程仓库 + 推送」两步。
按下面步骤操作即可（全程无需 IDE，用命令行）。

---

## 第一步：创建 GitHub 仓库（网页操作，约 1 分钟）

1. 登录 https://github.com （你的账号：**xuanyuying**）
2. 点击右上角 **+** → **New repository**
3. 填写：
   - **Repository name**：建议 `dsh-desktop`（或你喜欢的名字）
   - **Description**：`DeepSeek Harness 桌面版 - Electron 桌面应用，内嵌完整 Harness UI，右下角实时显示账户余额`
   - **Public**（开源社区可见）或 **Private**（仅自己可见，之后可改）
   - **不要勾选** "Add a README / .gitignore / license"（本地已有，避免冲突）
4. 点击 **Create repository**

创建后页面会显示仓库地址，形如：
```
https://github.com/xuanyuying/dsh-desktop.git
```

---

## 第二步：关联远程仓库并推送（命令行，约 1 分钟）

打开 PowerShell，进入项目目录：

```powershell
cd D:\文档\depseek harness\chajiankaifa\dsh-desktop-desk

# 1. 关联远程仓库（把下面的地址换成你自己的）
git remote add origin https://github.com/xuanyuying/dsh-desktop.git

# 2. 推送（首次推送会自动弹窗登录 GitHub，用浏览器授权即可）
git push -u origin master
```

> 若提示分支名不同（如 `main`），执行：
> ```powershell
> git branch -M main
> git push -u origin main
> ```

推送成功后，刷新 GitHub 页面即可看到全部代码。

---

## 第三步（可选）：发布 Release 安装包

让社区用户直接下载安装程序，而不用自己编译：

1. 打开仓库页面 → **Releases** → **Draft a new release**
2. **Tag**：`v1.0.0`；**Title**：`v1.0.0`
3. 把本机安装包拖进附件区：
   ```
   D:\文档\depseek harness\chajiankaifa\dsh-desktop-desk\dist\DSH Desktop Setup 1.0.0.exe
   ```
4. 填写发布说明（功能特性、截图等）→ **Publish release**

---

## 后续更新代码

```powershell
cd D:\文档\depseek harness\chajiankaifa\dsh-desktop-desk
git add -A
git commit -m "描述本次改动"
git push
```

---

## 开源社区小贴士（提升项目吸引力）

- **README 展示**：仓库首页的 README.md 已写好，建议补一张**运行截图**（软件窗口 + 右下角余额），图片放到 `docs/` 目录后在 README 中引用
- **徽章**：README 中已含技术栈徽章，可再加 CI 构建徽章、下载量徽章
- **Issue/PR 模板**：GitHub 仓库 → Settings → 添加 `ISSUE_TEMPLATE`
- **开源协议**：已内置 MIT LICENSE，别人可放心使用
- **避免泄露 Key**：`.gitignore` 已排除 `config.json`，请勿提交任何含真实 API Key 的文件

---

## 常见问题

**Q: 推送时提示认证失败？**
A: 首次推送会弹出 GitHub 登录窗口（Git Credential Manager），用浏览器登录授权即可。若没弹窗，改用个人访问令牌（Settings → Developer settings → Personal access tokens → 勾选 repo 权限）。

**Q: 想改仓库可见性（Private ↔ Public）？**
A: 仓库页 → Settings → General → Danger Zone → Change repository visibility。

**Q: 上传了不该传的文件怎么办？**
A: 将文件加入 `.gitignore` 后执行：
```powershell
git rm -r --cached 文件名
git commit -m "remove sensitive file"
git push
```
