# AGENTS.md · Scrollforge

> 项目级 agent 入口。工作区层规则见 `../AGENTS.md` 与 `../_shared/memory/GLOBAL_RULES.md`；本文件只写**本项目专属**约定，冲突时以工作区硬规则为底线。

## 1. 开工必读顺序

1. `../_shared/memory/GLOBAL_RULES.md` —— 全局硬规则
2. 本文件 —— 项目边界与命令
3. `.agent/README.md` —— 工作区目录职责、记忆分层、验收流程
4. `.agent/memory/MEMORY.md` —— 主记忆（框架 + 附录索引）
5. 按需查 `.agent/memory/appendices/W00-工作日志索引.md` 回溯任一阶段上下文

## 2. 项目身份

| 项 | 值 |
|---|---|
| 定位 | EPUB 原生格式的桌面阅读器 + 可视化编辑器 + 翻译工作流 |
| 当前版本 | **v0.13.0** |
| 技术栈 | Tauri 2 + React 19 + TypeScript 5.6 + Vite 7 + Rust |
| 许可证 | **MIT**（见 `LICENSE`） |
| 交付物 | `build/Scrollforge.exe`（Windows 双击可用） |
| 远程仓库 | `https://github.com/maelshiyan02/Scrollforge.git`（git 根 = 本目录） |

## 3. 硬约束

- 🔴 **许可证纪律**：readest / read-aware / koodo（AGPL）、wenku8 / calibre（GPL）**代码零复制**，只读架构后重写；引入新依赖前先确认许可与 MIT 兼容。
- 🔴 **证据先行**：改代码前先读现有实现；结论必须有源码或实测出处，不凭猜测。
- 🔴 **交付闭环**：前端改动必须 `cd app && npm run build`（`tsc --noEmit` + vite）通过；Rust 改动必须 `cargo check` 通过；GUI 功能必须后台启动 → 截图/读 DOM → 对照需求逐条确认，**未实测不得声称完成**。
- 🔴 **必须 `npm run tauri build`**，不能只 `cargo build`（前端资源不会进包，运行白屏）。
- 🔴 **交付前删除 `tauri.conf.json` 的 `additionalBrowserArgs`**（CDP 9222 调试端口不得留在发布产物里）。
- 🔴 **git 显式 add**：逐文件/逐目录添加，禁止 `git add -A` / `git add .`。
- 🔴 **不入库**：`build/*.exe`、`local book repository/`、`reading history/`、`final export/`、`_testdata/`、`_reference_apps/`、`_reference_src/`、`app/src-tauri/target/`、`app/dist/`、`resources/runtime/`、`resources/epubcheck/`。
- 🔴 **不写死本机绝对路径**：文档用 `<项目根>` / `<工作区>`，脚本由自身位置推导根目录。
- 🔴 **不碰同级项目**：`../Mangrove`、`../SummonerLens`、`../Novel_Store`、`../Celstack` 等各自独立；通用能力放 `../_shared/`。

## 4. 常用命令

```powershell
# 本机 Rust 环境（每开新终端需设置）
$env:CARGO_HOME='D:\dev\rust\cargo'
$env:RUSTUP_HOME='D:\dev\rust'
$env:PATH='D:\dev\rust\cargo\bin;' + $env:PATH

cd app
npm install
npm run build        # 类型检查 + 打包
npm run tauri dev    # 开发
npm run tauri build  # 生产构建
```

验收工具包在仓库外：`<工作区>/_tools/scrollforge-verify/`（`cdp.js` / `capture.exe` / `click.exe` / `screenshot-tool.exe`）。

## 5. 目录职责

| 路径 | 说明 |
|---|---|
| `app/src/` | React 源码（`components/` 界面、`lib/` 业务、`vendor/` 阅读内核） |
| `app/public/pdfjs/` | PDF 渲染运行时（构建时拷贝，需随仓库保留） |
| `app/src-tauri/src/` | `main.rs`（应用命令）、`epub_edit.rs`（EPUB 容器与块级读写） |
| `.agent/memory/` | 主记忆 + 编号附录 + 每日日志 |
| `.agent/documents/worklog/` | W01–W26 阶段工作日志 |
| `.agent/skills/` | `translate-pipeline`、`e6-block-write` 项目级 skill |
| `local book repository/` | 归档模式书库（用户内容，不入库） |
| `reading history/` | 阅读历史登记（不入库） |
| `final export/` | 导出目录（不入库） |

## 6. 阶段收尾三件套

1. 写 `documents/worklog/Wxx-<阶段名>-<YYYYMMDD>.md`（目标 → 做了什么 → 验收证据 → 偏差 → 下一步）。
2. 更新 `.agent/memory/appendices/W00-工作日志索引.md` 与当日 `memory/YYYY-MM-DD.md`。
3. 新踩的坑经实测确认后写入 `appendices/A07-踩坑与规则.md`（现象 → 根因 → 正确做法）。

## 7. 文档入口

| 文档 | 读者 |
|---|---|
| `README.md` | 所有人：定位、能力、边界 |
| `BUILDING.md` | 开发者：环境与构建 |
| `TRANSLATION.md` | 开发者 / 高级用户：翻译三通道 |
| `ARCHITECTURE.md` | 维护者：模块与数据流 |
| `CHANGELOG.md` | 所有人：版本与阶段一览 |
