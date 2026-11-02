# 架构说明（ARCHITECTURE）

给维护者的地图：谁负责什么、数据怎么流、状态落在哪里。

## 1. 总览

```
┌─────────────────────────────────────────────┐
│  React 19 前端（app/src）                    │
│  Shelf / Reader / EpubEditPanel / ForgePanel │
└───────────────┬─────────────────────────────┘
                │ invoke()（Tauri IPC，JSON）
┌───────────────▼─────────────────────────────┐
│  Rust 后端（app/src-tauri/src）              │
│  main.rs：书库、设置、锻造、翻译、校验        │
│  epub_edit.rs：EPUB 解包/打包、块级读写       │
└───────────────┬─────────────────────────────┘
                │ 文件系统 / HTTP（ureq）/ 子进程
┌───────────────▼─────────────────────────────┐
│  应用数据目录（JSON + 书库）+ 用户目录        │
│  epubcheck 子进程（Java）                     │
└─────────────────────────────────────────────┘
```

没有数据库。所有结构化状态都是 JSON 文件，目录结构即数据模型。

## 2. 前端模块

### 组件（`app/src/components/`）

| 文件 | 职责 |
|---|---|
| `App.tsx` | 应用壳：书架 ↔ 阅读 ↔ 编辑的模式切换、全局事件 |
| `Shelf.tsx` / `Shelf3D.tsx` | 书架三视图（网格 / 列表 / 轴测 3D 书脊） |
| `Reader.tsx` | 阅读器主组件：加载 foliate，分页/滚动、章节导航、进度、锻造面板挂载 |
| `EpubEditPanel.tsx` | EPUB 编辑器：文件树 / 源码 / 元数据 / 目录 / 段落块，脏块收集与写回 |
| `ForgePanel.tsx` | 锻造器：逐段改写 / 翻译 / 注释、整章批量、术语与记忆 |
| `AnnotationTools.tsx` | 划词工具栏：高亮（6 色）/ 笔记 / 删除 / 复原 / 实时翻译 |
| `SettingsDialog.tsx` | 由功能注册表生成的设置面板（可拖动、可缩放、位置持久化） |
| `GlossaryDialog.tsx` | 术语表编辑与 CSV/JSON 导入导出 |
| `CheckDialog.tsx` | epubcheck 结果展示（按错误级别着色） |
| `ConvertWizard.tsx` / `NewBookWizard.tsx` | 转换向导 / 新建书两步向导 |
| `ImportDialog.tsx` / `ExportTextDialog.tsx` | 导入与文本导出 |
| `ImageViewer.tsx` | 插图 / 彩页全屏查看（缩放、拖拽、左右切换） |
| `HelpDialog.tsx` / `Icon.tsx` | F1 说明书 / Flutter 风格图标 |

### 库（`app/src/lib/`）

| 文件 | 职责 |
|---|---|
| `formats.ts` | **格式矩阵单一真相**：阅读 / 导入 / 转换 / 导出 / 可编辑能力全从这里取 |
| `prefs.ts` | 设备级偏好 `scrollforge:prefs`，含默认值与迁移兜底 |
| `features.ts` | 功能注册表：设置页与 F1 说明书同源生成 |
| `epub-writer.ts` | 从零构建 EPUB（OPF / nav / NCX / 分卷 / 插图 / 番外） |
| `epub-export.ts` | EPUB → TXT / MD / HTML 导出 |
| `translate.ts` | 翻译流水线：分段、术语掩码、双引擎、繁简、记忆 |
| `glossary.ts` | 术语表模型、CSV/JSON 解析、OpenCC 繁转简 |
| `forge.ts` | 锻造覆盖层模型、行级 Myers diff |
| `txt-book.ts` / `txt-chapters.ts` / `encoding.ts` | TXT 读取、编码嗅探、逐行章节识别 |
| `book-text.ts` / `typography.ts` | 文本归一化与排版参数 |
| `annotations.ts` | 高亮/笔记定位与存储 |
| `inline-format.ts` | 内联格式白名单、sanitize、XML 合法性校验 |
| `cover.ts` / `gallery.ts` / `comic-import.ts` | 封面抽取、插图画廊、CBZ/ZIP 漫画导入 |
| `draft-import.ts` | 新建书向导的 MD/HTML 章节导入 |
| `pdf-text.ts` | PDF 文字层提取 |
| `progress.ts` / `zip-store.ts` | 阅读进度、自写 ZIP store |
| `vendor/foliate-js/` | 阅读内核（MIT，vendored，不修改上游协议） |

## 3. 后端模块

### `main.rs`

一个文件承载应用层命令，按职责分组：

| 组 | 命令 |
|---|---|
| 启动与环境 | `start_args`、`default_dirs`、`open_folder`、`open_library_dir` |
| 书库 | `import_book`、`open_path`、`list_books`、`read_book`、`read_book_bytes`、`touch_book`、`delete_book`、`scan_books`、`save_cover`、`read_cover` |
| 设置 | `get_settings`、`save_settings` |
| 文本与文件 | `read_text_file`、`write_text_file`、`save_epub`、`file_exists` |
| 锻造与版本 | `read_forge_state`、`commit_forge`、`list_revisions`、`read_revision`、`restore_revision` |
| 翻译 | `translate_text`、`read_glossary`、`write_glossary`、`read_translation_memory`、`write_translation_memory` |
| EPUB 校验 | `check_epub` |
| EPUB 编辑 | `make_edit_dir`、`edit_open_epub`、`edit_list_files`、`edit_read_file`、`edit_write_file`、`edit_save`、`edit_check`、`edit_update_metadata`、`edit_read_toc`、`edit_write_toc`、`edit_rename_file`、`edit_scan_report`、`edit_list_revisions`、`edit_restore_revision`、`edit_scan_blocks`、`edit_write_blocks`、`edit_validate`、`preview_image`、`forge_epub_index` |

### `epub_edit.rs`

只做 EPUB 容器与 XHTML 的底层操作，不感知业务语义：

- 解包（mimetype 校验、路径穿越防护）、打包（保留 mimetype 首条 store）。
- `scan_blocks_raw` → `BlockInfo`：按字节区间定位每个可编辑块（段落、标题、figure）。
- `write_blocks`：**按起始字节倒序替换**，避免前面的替换移动后面块的偏移。
- 目录读写：同时维护 `nav.xhtml` 与 `toc.ncx`，并同步 OPF spine 顺序。
- 全书扫描：未使用图片、孤儿文件、重复 id、断链、目录与 spine 顺序不一致。
- 修订：`edit-projects/<timestamp>/edit/revisions/` 快照与回滚。

## 4. EPUB 编辑数据流

```
原始 EPUB
  → make_edit_dir / edit_open_epub     解包到工作目录（含 mimetype、META-INF、OEBPS）
  → edit_scan_blocks                   扫描单页 → Vec<BlockInfo>（index + 字节区间 + 标签 + 纯文本）
  → 前端块级编辑（段落/标题/删除标记/内联格式）
  → edit_write_blocks                  只提交 dirty 块，倒序字节替换
  → edit_save                          重新打包，可选生成 revision
  → edit_check                         epubcheck 校验（0 error 才允许交付）
```

`buildEpub` 生成的正文页也遵循同一约定：`pageXhtml` 的 `wrapperTag: null` 让正文段落直接成为 `body` 子元素，从而与 `scan_blocks_raw` 的块序号严格对齐。

## 5. 锻造层与 EPUB 源

TXT 书：正文在 `source.txt`，改动写成 `forge.json` 覆盖层，`commit_forge` 先快照再写回。

EPUB 书：`forge_epub_index` 完成三件事——

1. `parse_opf_spine`：按 OPF 的 itemref 顺序拿到真实的 spine 文件列表；
2. 逐文件 `scan_blocks_raw` + `extract_plain_text`；
3. 建立 `(chapterIndex, paragraphIndex) → (relPath, blockIndex)` 映射，返回与 TXT 书同形的 `FlatBlock` 列表。

前端因此不需要区分书源类型；写回时按映射调用 `edit_write_blocks` + `edit_save`，绕开 `forge.json` 再提交的绕远路。

## 6. 状态与存储

| 位置 | 内容 |
|---|---|
| `app_data_dir/settings.json` | 应用级设置（书库/历史/导出目录等） |
| `app_data_dir/history.json` | 阅读历史登记（history 模式的书籍路径与进度） |
| `app_data_dir/history_covers/` | 历史模式封面缓存 |
| `app_data_dir/books/<id>/` | 归档模式书目：`meta.json`、`source.epub`、`forge.json`、`revisions/` |
| `app_data_dir/translate/glossary.json` | 术语表 |
| `app_data_dir/translate/memory.json` | 翻译记忆 |
| `app_data_dir/edit-projects/<ts>/edit/` | 外部 EPUB 的编辑工作副本 |
| `localStorage: scrollforge:prefs` | 设备级偏好（含翻译引擎配置） |

`app_data_dir` 由 Tauri 的 `path().app_data_dir()` 解析，标识符为 `com.scrollforge.app`；不在代码里写死绝对路径。

## 7. 关键约束

- 前端不直接读写文件系统；所有落盘经由 Rust 命令。
- 编辑只对 EPUB 成立；非 EPUB 进入编辑器前会复制/转换为工作副本。
- 写回必须保留未改动段落的原始字节，禁止整页重写。
- epubcheck 以子进程调用，参数顺序有坑（`--json` 必须在目标文件之前），改动时参考 `.agent/memory/appendices/A07`。
- 生产构建不得保留 CDP 调试端口（`additionalBrowserArgs`）。
