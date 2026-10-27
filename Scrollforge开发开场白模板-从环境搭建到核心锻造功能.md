# Scrollforge 对话开场白

> 用于 Trae 新会话的启动模板。直接复制粘贴即可开始对应开发。

---

## 模板 1：环境初始化（第一次启动 Tauri 项目）

```
我要启动 Scrollforge 项目开发。先帮我检查本地 Tauri v2 开发环境（Rust / Node / pnpm / VS Code Tauri 插件），然后用官方脚手架在当前目录初始化一个最小的 Tauri v2 + React + Vite 项目骨架。参考 ReadAware 的技术选型。
```

## 模板 2：Phase 1 功能开发（书架 + TXT 阅读器）

```
Scrollforge Phase 1：在已有的 Tauri v2 + React 骨架上，开发最小可用的 TXT 阅读器。需求：
1. 书架页面（左侧列表 + 右侧空态引导）
2. 本地导入 TXT 文件（drag & drop + 文件选择）
3. TXT 章节识别（第X章 + --- 分隔线，复用之前 EPUB 转换验证过的正则）
4. 阅读器页面：连续滚动、段落级渲染（每行一句独立 <p>）、字体/行距/缩进调整
5. SQLite 存书架 + 进度（rusqlite，React 端用 Tauri invoke 桥接）

参考项目：ReadAware（整体架构）、月读（TXT 章节识别）
```

## 模板 3：Calibre 风格脚注气泡

```
Scrollforge Phase 2：实现 Calibre 风格的脚注气泡功能。需求：
1. 渲染 EPUB 时，检测所有 <a.footnote> 和引用脚注的 <a> 标签
2. 点击脚注引用时，preventDefault，在视口中央弹出一个 fixed DIV 气泡
3. 气泡内显示脚注原文（从 <ol class="footnotes"> 或 <div id="footnotes"> 中提取）
4. 点击气泡外部关闭，或按 ESC 关闭
5. 气泡样式：圆角半透明白底、阴影、最大高度 60vh 可滚动

参考 Calibre CSS：body.calibre-footnote-container a.footnote
```

## 模板 4：EPUB 渲染接入 Readium.js

```
Scrollforge：接入 Readium.js 实现 EPUB 3 标准渲染。需求：
1. 把 epub.js（Readium 官方 JS 库）作为前端依赖
2. 实现 React 组件 EpubReader，props 接收 EPUB 文件路径
3. 支持 CFI 定位（段落级进度记忆）
4. 目录导航桥接到书架侧栏
5. 支持 Readium 的 theme API（高亮/注释等扩展点）
```

## 模板 5：文本编辑与翻译（锻造核心）

```
Scrollforge Phase 3：实现"锻造"核心——文本编辑功能。需求：
1. 在阅读器中选中文本 → 弹出浮动工具栏（修改 / 翻译 / 注释）
2. 修改：直接替换原文段落，本地 SQLite 存 diff（原文 → 修改后）
3. 翻译：选中段落 → 调用 AI API → 返回译文 → 确认替换
4. 注释：选中段落 → 写注释 → 和段落 ID 绑定，脚注气泡形式显示
5. 版本管理：每次修改都保存快照，可回滚
```

## 模板 6：格式转换（TXT → EPUB）

```
Scrollforge：实现格式转换管线。需求：
1. TXT → EPUB：复用之前 EPUB 转换脚本的章节识别 + 段落处理逻辑
2. 自动提取封面（从图片文件或下载 URL）
3. 自动生成目录（nav.xhtml）
4. 支持把用户添加的注释气泡也导出到 EPUB 的 footnotes
5. Rust 端实现 EPUB 打包（用 zip 压缩 + 写 OPF/NCX）
```

## 模板 7：SQLite Schema 设计

```
Scrollforge：设计完整的 SQLite 数据库 Schema。需要覆盖：
1. 书架（books: id, title, author, cover_path, file_path, format, added_at）
2. 章节（chapters: book_id, chapter_index, title, file_offset, length）
3. 进度（progress: book_id, chapter_index, paragraph_index, scroll_offset, updated_at）
4. 高亮（highlights: book_id, text, chapter_index, paragraph_index, color, note, created_at）
5. 注释/修改（annotations: book_id, chapter_index, paragraph_index, original_text, edited_text, type, created_at, version）
6. 阅读统计（stats: book_id, words_read, reading_time, last_opened）
```

## 模板 8：项目结构检查与规范

```
帮我快速审视一下 Scrollforge 当前目录结构，检查：
1. Tauri v2 标准布局是否完整（Cargo.toml / tauri.conf.json / src-tauri/src/）
2. React 前端是否有清晰的 components / pages / hooks / lib 分层
3. 有没有 .gitignore 遗漏的文件（如 /data / cache / .env）
4. 检查 package.json 的依赖版本是否有已知的安全漏洞
5. 给出改进建议
```

---

## 跨项目模板：和 Celstack 统一基建

```
Scrollforge 和 Celstack 共用 Tauri v2 + React + Rust + SQLite 基建。帮我把共用部分提取成共享库：
1. Rust 端：db (rusqlite 封装)、ai (AI API 桥接)、config (用户设置)
2. 前端：hooks (useSettings / useAI / useDB)、components (SettingsPanel / AIModal)
3. 设计为 npm workspace 或 git submodule，两个项目都能引用
```
