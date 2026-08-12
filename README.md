# JuvenileScholar

一个安静、简洁的 Windows 工作台。它保存本地应用与在线网址入口，并在点击时启动对应程序或默认浏览器。

## 当前范围

- 添加、修改和移除本地应用或在线网址入口
- 早晨根据本机星期显示问候语，其余时段仅显示对应的时间问候
- 自动读取 Windows 应用自身图标，并在本地提取轮廓生成简笔线稿
- 在线网址统一使用本机 Microsoft Edge 的线稿图标与低对比度标记
- 以 650 毫秒间隔依次启动当前工作台中的全部入口，避免瞬间并发
- 每 10 秒按完整路径轻量检测本地 `.exe` 运行状态，已运行应用不再重复启动
- 首次运行状态检测期间锁定“全开”，关闭工作台后不保留后台检测
- 可将暂时不用的应用移入默认折叠的睡眠区，并随时苏醒
- 新增入口可通过独立睡眠开关决定保存到打开区或睡眠区
- 左侧设置栏支持自定义右下角签名、一键睡眠与一键苏醒
- 睡眠区和签名编辑器带有柔和的展开、收起动效
- 页脚书本、新芽与手写名称会在启动时缓慢自动绘制
- 自定义标题栏支持最小化、最大化/还原与关闭窗口
- 支持 `.exe`、`.lnk`、`.bat`、`.cmd`、`.url` 以及 `http://`、`https://` 网址
- 将快捷方式配置保存在 Windows 当前用户的应用配置目录
- 跟随系统浅色/深色外观
- 不包含账号、云同步、最近记录、拖动排序或应用内控制

## 项目位置

- 源码与构建产物：`E:\Codex\JuvenileScholar`
- Rust 与 Cargo：`D:\DevTools\JuvenileScholar`
- pnpm 仓库与缓存：`D:\DevTools\JuvenileScholar`
- 临时构建文件：`E:\Codex\JuvenileScholar\.tmp`

## 开发环境

项目使用 Tauri 2、TypeScript 和 Vite。运行 Rust/Tauri 命令前，需要设置：

```powershell
$env:CARGO_HOME = 'D:\DevTools\JuvenileScholar\cargo'
$env:RUSTUP_HOME = 'D:\DevTools\JuvenileScholar\rustup'
$env:TEMP = 'E:\Codex\JuvenileScholar\.tmp'
$env:TMP = 'E:\Codex\JuvenileScholar\.tmp'
```

也可以直接使用已经固定好路径的脚本：

```powershell
.\scripts\dev.ps1
.\scripts\build.ps1
```
