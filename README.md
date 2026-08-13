<p align="center">
  <img src="./docs/assets/serenook-readme-hero.png" alt="Hello, Serenook" width="100%">
</p>

# Serenook

一个安静、简洁的 Windows 工作台，它保存本地应用、在线网址与常用文档入口，并在点击时交给对应程序或默认浏览器打开。

## 当前范围

- 添加、修改和移除本地应用、在线网址或常用文档入口
- 早晨根据本机星期显示问候语，其余时段仅显示对应的时间问候，并在时间分界点自动更新
- 自动读取 Windows 应用自身图标，并在本地提取轮廓生成简笔线稿
- 在线网址统一使用本机 Microsoft Edge 的线稿图标与低对比度标记
- 以 650 毫秒间隔依次启动当前工作台中的全部入口，避免瞬间并发
- 每 10 秒按完整路径轻量检测本地 `.exe` 运行状态，已运行应用不再重复启动
- 首次运行状态检测期间锁定“全开”，关闭工作台后不保留后台检测
- 可将暂时不用的应用移入默认折叠的睡眠区，并随时苏醒
- 新增入口可通过独立睡眠开关决定保存到打开区或睡眠区
- 左侧设置栏支持自定义右下角签名、一键睡眠与一键苏醒
- 全新安装首次运行时柔和邀请用户阅读使用说明，已有旧版设置的用户不会重复看到
- 设置中提供安静简洁的使用说明与开机自启开关
- 睡眠区和签名编辑器带有柔和的展开、收起动效
- 页脚书本、新芽与手写名称会在启动时缓慢自动绘制
- 自定义标题栏支持最小化、最大化/还原与关闭窗口
- 支持 `.exe`、`.lnk`、`.bat`、`.cmd`、`.url`、`.txt`、`.csv`、`.xlsx` 以及 `http://`、`https://` 网址
- 将快捷方式配置保存在 Windows 当前用户的应用配置目录
- 初次沿用系统外观，并可在设置中切换、记忆浅色或深色模式
- 启动后轻量检查 GitHub Releases；发现新版本时可查看说明、下载、安装并重新打开 Serenook
- 用户可见软件名为 Serenook；内部标识符继续沿用旧值，以兼容原有 JuvenileScholar 配置
- 不包含账号、云同步、最近记录、拖动排序或应用内控制

## 资源占用

以下数据来自 Windows 本机对本轮发布构建的静置采样，实际数值会因 Windows、Microsoft Edge WebView2 版本、已导入入口数量和页面状态而变化：

- Serenook 主进程静置工作集约 `28–31 MB`，私有内存约 `8–9 MB`。
- 将 WebView2 子进程全部计入时，本次启动峰值工作集约 `366 MB`，私有内存约 `224 MB`。
- 本次采样共包含 1 个 Serenook 主进程与 6 个 WebView2 子进程；关闭 Serenook 两秒后，相关 WebView2 子进程为 0。
- 当前安装包约 `3.1 MB`，主程序约 `12.7 MB`；应用运行依赖 Windows 已安装的 Microsoft Edge WebView2 Runtime。
- CPU 在完成启动与运行状态检查后基本保持空闲；本次连续采样中主进程累计 CPU 时间稳定在约 `0.05` 秒。
- 日常运行建议预留约 `500 MB` 可用内存与单个空闲 CPU 核心。批量打开的其他应用不属于 Serenook 自身占用，并会以 650 毫秒间隔依次启动。

这里的“峰值”是本次实测峰值，不是覆盖所有机器的硬性上限；正式发布前可以继续在更多 Windows 设备上补充基准。

## 开发环境

项目使用 Tauri 2、TypeScript 和 Vite。仓库中的脚本不包含开发者用户名或固定工具目录；需要将 `cargo`、`pnpm` 与 Node.js 放入 `PATH`。如需让依赖与编译缓存避开系统盘，可在本机自行设置 `CARGO_HOME`、`RUSTUP_HOME`、`CARGO_TARGET_DIR` 和 pnpm store。然后运行：

```powershell
.\scripts\dev.ps1
.\scripts\build.ps1
```

## 发布与应用内更新

仓库包含 Windows Release 工作流。推送形如 `v0.9.0` 的版本标签，或在 GitHub Actions 中手动运行 `Release Serenook`，会构建、测试并创建一个草稿 Release，包含 NSIS 安装包、更新签名与 `latest.json`。

首次使用前，需要在 GitHub 仓库的 `Settings → Secrets and variables → Actions` 中添加：

- `TAURI_SIGNING_PRIVATE_KEY`：Tauri 更新签名私钥的完整内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码；无密码密钥可留空，但正式发布更推荐使用带密码密钥。

签名私钥不得提交到仓库。若私钥遗失，已经安装旧公钥版本的用户将无法验证后续更新。

## 参考

- [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md) — Apple、Claude 等产品设计语言的 Markdown 资料集合，为 Serenook 的视觉探索提供参考。
