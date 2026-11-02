# Phase 0 · 最小可跑闭环规格（v0.1.0）

> 上级索引：`../../memory/appendices/A04-功能范围与优先级.md`
> 目标：证明"Tauri 2 + foliate-js + React"这条自建路线能跑通，且产物是双击可用的 exe。
> **状态：2026-10-27 六项验收全过**（证据与偏差见 `../documents/worklog/W02-Phase0-最小可跑闭环-20261027.md`）

## 1. 验收项（缺一不可）

| # | 验收 | 判定方式 |
|---|---|---|
| 1 | `build/Scrollforge.exe` 双击能启动窗口 | 文件存在 + 手动/后台启动成功 |
| 2 | 能打开一本 EPUB | 选择本地 `.epub` 文件后正文渲染出来 |
| 3 | 分页阅读 + 上一页/下一页可用 | 翻页后正文内容变化，页码递增 |
| 4 | 竖排切换可用 | 点击"竖排"后文字自上而下、行自右向左 |
| 5 | 进度记忆 | 关闭再打开同一本书，回到上次位置 |
| 6 | 全中文界面 | 无英文按钮文案 |

## 2. 本期范围（明确不做）

- 不做书架、不做 TXT、不做转换、不做锻造层、不做 TTS。
- 进度暂存 `localStorage`，Phase 1 换 SQLite（此处是**已知技术债**，非疏漏）。
- 文件选择先用 `<input type="file">`，不引入 Tauri dialog 插件（减少 Phase 0 的 Rust 依赖与编译时间）。

## 3. 技术要点

- foliate-js 以源码形式放在 `app/src/vendor/foliate-js/`（MIT，保留 LICENSE）。
- 阅读区用 foliate `View`，`flow: 'paginated' | 'scrolled'`，`direction: 'ltr' | 'rtl'`，竖排通过给渲染文档注入 `writing-mode: vertical-rl` 的 CSS 实现。
- 进度用 `view.getProgress()` / `view.goToFraction()` + `relocate` 事件。

## 4. 后续（Phase 1 前置）

- 把 `localStorage` 换 SQLite；把文件选择换 Tauri dialog；把 foliate-js 换 git submodule 固定 commit。
