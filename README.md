# Scrollforge

> EPUB 原生格式的桌面阅读器 + 可视化编辑器 + 翻译工作流。
> 当前版本 **v0.13.0** ｜ Windows 桌面端（Tauri 2）｜ MIT

Scrollforge 不是又一个「能打开 EPUB」的阅读器。它把**读、改、译**放在同一个工作台上：读到不顺的段落可以直接改，改完能立刻校验 EPUB 规范，译完能写回原书，每一轮改动都有可回滚的版本快照。

---

## 能做什么

| 模块 | 能力 |
|---|---|
| **书架** | 11 种格式导入（EPUB / MOBI / AZW / AZW3 / FB2 / CBZ / ZIP / PDF / TXT / MD / HTML）；网格、列表、仿文库 3D 书架三种视图；分组与排序；EPUB 封面自动抽取缓存；两种存储模式（复制进固定书库 / 仅登记原文件路径） |
| **阅读器** | foliate-js 内核，保留原书排版与插图；分页 / 滚动两种阅读方式；单页 / 双页 / 竖排；目录跳转、上一章 / 下一章、可点击拖拽的进度条；脚注气泡；插图点击放大 + 画廊翻页；6 色高亮与笔记（笔记小字常驻原文旁，可拖动，位置可记忆）；划词实时翻译 |
| **编辑器（E6）** | 仅 EPUB 可直接编辑；文件树 / 源码 / 元数据 / 目录 / 段落块五种视图；块级可视编辑（段落、标题、删除标记）；内联格式工具条（粗体 / 斜体 / 链接 / 标题级别）；Word 粘贴白名单过滤；只替换 dirty 块、未改段落逐字节保留；修订列表与回滚；epubcheck 校验；阅读↔编辑位置自动对齐 |
| **锻造器 ForgePanel** | 逐段改写 / 翻译 / 注释，可整章批量；TXT 与 EPUB 双源；EPUB 源直接写回工作副本并即时重打包；术语表 + 翻译记忆参与 |
| **新建书** | 两步向导：书名 / 作者 / 语言 / 封面 / 3 套样式预设 → 三层树形结构（正文 / 分卷 / 章）编辑，同层拖拽、升降级、合并拆分、插图、番外与后记；TXT / MD / HTML 导入；产物可被 epubcheck 零错误验证 |
| **格式转换** | TXT / MD / HTML / FB2 / CBZ / ZIP / PDF → EPUB；EPUB → TXT / MD / HTML 导出 |
| **设置与说明书** | 功能注册表驱动的设置页（8 张功能卡、20 个设置项，即时生效并持久化）；F1 说明书与注册表同源生成，不会与界面漂移 |

## 不能做什么（诚实边界）

- **编辑能力只对 EPUB 成立**。其它格式进入编辑器前会先转成工作副本（working.epub），不会直接写回原始格式。
- **PDF 只做只读渲染 + 文字层提取转 EPUB**，不做流式重排；扫描件没有文字层时无法提取正文。
- **不做在线漫画 / 小说抓取**。CBZ / ZIP 仅支持本地导入。
- **翻译不内置模型**。需要用户自己填在线 OpenAI 兼容接口，或本地 Ollama / LM Studio 地址；Key 只存本机。
- **仅桌面端**。Windows 已打包验证；Mac / Linux 理论可构建，未做验收。
- **TTS 未上线**（已排期，未实现）。

## 技术栈

| 层 | 选型 |
|---|---|
| 壳 | Tauri 2（Windows 上以 WebView2 承载前端） |
| 前端 | React 19 + TypeScript 5.6 + Vite 7 |
| 阅读内核 | [foliate-js](app/src/vendor/foliate-js/)（MIT，已 vendored 进仓库）+ pdf.js（PDF 只读渲染） |
| 后端 | Rust（`zip` / `quick-xml` / `serde_json` / `ureq`），无数据库，状态以 JSON 落盘 |
| 校验 | epubcheck 4.2.6 + 内置运行时（见 [BUILDING.md](BUILDING.md)） |

## 目录结构

```
<项目根>
├─ app/                 前端 + Tauri 工程
│  ├─ src/              React 源码（components / lib / vendor）
│  ├─ public/pdfjs/     PDF 渲染运行时要（构建时拷贝）
│  └─ src-tauri/        Rust 后端（main.rs / epub_edit.rs）
├─ build/               交付产物 Scrollforge.exe（不进 git）
├─ .agent/              agent 工作区：记忆、附录、工作日志、规格、skills
├─ local book repository/  用户书库副本（不进 git）
├─ reading history/        阅读历史登记（不进 git）
├─ final export/           导出目录（不进 git）
└─ icon.png             应用图标源文件
```

## 快速开始（开发者）

```powershell
cd app
npm install
npm run tauri dev
```

生产构建与产物位置见 [BUILDING.md](BUILDING.md)。

## 文档

| 文档 | 读者 | 内容 |
|---|---|---|
| [BUILDING.md](BUILDING.md) | 开发者 | 环境要求、构建命令、内置资源、常见问题 |
| [TRANSLATION.md](TRANSLATION.md) | 开发者 / 高级用户 | 翻译三通道、术语表、翻译记忆、引擎配置 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 维护者 | 模块划分、Tauri 命令、EPUB 数据流 |
| [CHANGELOG.md](CHANGELOG.md) | 所有人 | 版本演进与阶段日志索引 |
| [.agent/README.md](.agent/README.md) | AI agent / 维护者 | 工作区约定、记忆体系、验收流程 |

## 第三方许可

- **foliate-js** —— MIT，见 [LICENSE](app/src/vendor/foliate-js/LICENSE)；为阅读内核，已 vendored 并保持原许可。
- **pdf.js / pdfjs-dist** —— Apache-2.0，`app/public/pdfjs/` 内附许可文件。
- **readium/css** —— BSD-3-Clause，用于排版样式思路，代码未直接复制。
- **zip / quick-xml / serde_json / ureq** —— MIT / Apache-2.0（Rust crate，见 `Cargo.lock`）。

本项目采用 **MIT** 许可。架构参考过 readest / read-aware / koodo（AGPL）、wenku8 / calibre（GPL），但**未复制任何一行代码**，只读架构后重写。
