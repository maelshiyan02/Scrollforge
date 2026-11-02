# Phase 2 · 转换向导 + 脚注气泡 + 标注（v0.3.0）

> 上级索引：`../../memory/appendices/A04-功能范围与优先级.md`
> 目标：把 Phase 1 的"只读 TXT"补成"能把 TXT 锻成标准 EPUB"，并让阅读页具备注释能力。
> **状态：已完成（2026-10-28，v0.3.0）**

## 1. 验收项（缺一不可）

| # | 验收 | 判定方式 |
|---|---|---|
| 1 | 书架可进入转换向导 | 顶部「转换为 EPUB」按钮、右键菜单项都能打开向导 |
| 2 | 来源二选一 | 书架 TXT / 磁盘 TXT 都能读入并预览章节 |
| 3 | 预览真实 | 显示编码、识别方式（章节/分块）、章节数与章节列表 |
| 4 | 元信息可改 | 书名、作者、语言可编辑，默认值来自书目 |
| 5 | 生成合规 EPUB3 | 产物通过结构校验：`mimetype` 为首项且未压缩、`META-INF/container.xml`、OPF（dc:title/identifier/language/dcterms:modified）、`nav.xhtml`、`toc.ncx`、spine 顺序与章节一一对应 |
| 6 | 第三方阅读器可打开 | 用本机 Thorium 打开产物，能显示正文与目录（不接受"只有我们自己的阅读器能开"） |
| 7 | 脚注气泡 | 打开 `footnotes-zh.epub`，点击脚注引用弹出中文气泡，可关闭，不跳走正文位置 |
| 8 | 划词标注 | 选中文字弹出中文工具条；黄/绿/蓝三色高亮、写笔记、删除；重开书仍显示 |
| 9 | 全中文 | 按钮、tooltip、错误提示无英文 |
| 10 | 产物可交付 | `build/Scrollforge.exe` 双击启动并完成 1~9 |

## 2. 本期范围

### 2.1 转换向导（预览 → 确认 → 生成）

- 第 1 步：选来源（书架 TXT 列表 / 从磁盘选 TXT），自动解码并识别章节，右侧实时预览。
- 第 2 步：确认书名、作者、语言与排版选项（首行缩进、章节标题居中），点击「开始生成」。
- 保存路径由系统保存框决定，Rust 端 `save_epub(path, base64)` 解码写盘。
- 成功后可「立即打开」产物，走 Phase 0 的 EPUB 阅读路径。

### 2.2 EPUB 产物结构

```
mimetype                       application/epub+zip（首项、存储、无额外字段）
META-INF/container.xml
OEBPS/content.opf              EPUB 3.0；含 toc.ncx 兼容项
OEBPS/nav.xhtml                epub:type=toc + landmarks
OEBPS/toc.ncx                  EPUB 2 阅读器兜底
OEBPS/style.css               中文字体栈、行高、缩进可关
OEBPS/text/ch0001.xhtml …     每章一个 XHTML，epub:type=chapter
```

### 2.3 脚注气泡

- 复用 vendor `footnotes.js` 的 `FootnoteHandler`：监听 `foliate-view` 的 `link` 事件，`epub:type="noteref"` 命中后由它自行抽片段。
- 我们自己只负责：在 `before-render` 阶段把临时 `foliate-view` 挂进右下角气泡（气泡常驻、用 `visibility` 隐藏，保证有真实尺寸），`render` 后显示中文标题（脚注/尾注/注释/词义/参考条目）、关闭按钮、`Esc` 关闭。
- 正文在 iframe 中，`keydown` 不会冒泡到顶层窗口 → 每个载入的文档各挂一份监听转发，Esc 才能生效。
- TXT 没有脚注，此功能只对 EPUB 生效。

### 2.4 标注

- 划词 → 工具条：黄色高亮 / 绿色高亮 / 蓝色高亮 / 写笔记 / 取消。
- 点击已有高亮 → 工具条：查看笔记 / 修改笔记 / 删除标注 / 关闭。
- 存储：`localStorage`，key `scrollforge:annotations:<进度 key>`，字段 `{value(CFI), color, note, index, text, createdAt, updatedAt}`。
- 绘制：vendor `overlayer.js`；有颜色用 `highlight`，只有笔记用 `underline`。
- 重开同一本书时按 CFI 复原；不同书的标注互不串。

## 3. 明确不做

- 不做 EPUB 导入书架、封面生成、图片/公式。
- 不做自定义章节正则、批量转换、转换队列。
- 不做标注导出/同步、全文搜索、书签。
- 不复制任何 AGPL/GPL 代码；ZIP 打包与 EPUB 写出按规范自行实现。
- 不引入压缩算法：ZIP 用 store（不压缩）方式，仍为合法 EPUB。

## 4. 技术要点

- 零依赖：vendor 里的 `fflate.js` 只导出 `unzlibSync`，没有 `zipSync` → 自写 `zip-store.ts`（CRC32 + 本地头/中央目录/EOCD）。
- `mimetype` 必须是压缩包第一个本地文件、method=0、无 extra field，否则阅读器识别失败。
- 章节数据直接复用 `analyzeTxt()` 的 `TxtChapter[]`，保证"预览所见 = 产物所得"，不二次解析。
- 文档标题/正文必须 XML 转义，并剔除 XML 1.0 非法控制字符。
- `dcterms:modified` 必须为 `YYYY-MM-DDTHH:MM:SSZ`（不带毫秒）。
- 前端生成的二进制用分块 `btoa` 转 base64 交给 Rust（避免 JSON 数字数组膨胀）。
- 标注事件链：`create-overlay`（新节渲染）→ 按 `index` 重新 `view.addAnnotation`；`draw-annotation` → 选择 `Overlayer.highlight/underline`；`show-annotation` → 弹工具条。
- 划词坐标换算：`iframe.getBoundingClientRect() + range.getBoundingClientRect()`，工具条用 `position: fixed`。

## 5. 验收证据（`_testdata/shots/`）

| 验收 | 证据 |
|---|---|
| 向导入口 | `phase2-wizard-open.png` |
| 向导第 1 步（预览） | `phase2-wizard-preview.png` |
| 向导第 2 步（元信息/选项） | `phase2-wizard-confirm.png` |
| 保存文件框 | `phase2-save-dialog.png` |
| 生成成功 + 立即打开 | `phase2-wizard-done.png`、`phase2-converted-reader.png` |
| 第三方阅读器 | `phase2-thorium-open.png`（Thorium 打开 `红楼梦.epub`，标题 `Thorium - 红楼梦`） |
| EPUB 结构校验 | `_testdata\红楼梦.epub` 经 `C:\Temp\verify_file.mjs` 16 项全 PASS（120 章、126 条目） |
| 脚注气泡 | `phase2-footnote.png` |
| 划词工具条 | `phase2-annotation-toolbar.png` |
| 三色高亮 + 笔记 | `phase2-annotation-highlight.png`、`phase2-annotation-colors.png`、`phase2-annotation-note-saved.png` |
| 删除标注 | `phase2-annotation-deleted.png` |
| 标注持久化 | `phase2-annotation-resume.png` |
| 交付 exe | `phase2-final-exe.png`（v0.3.0，3,460,608 字节，无远程调试端口） |

## 6. 背景自动化纪律

所有点击/截图在后台完成：WMI `Invoke-CimMethod Win32_Process Create` 启动进程脱离 shell 任务树；需要交互时临时在 `tauri.conf.json` 加 `additionalBrowserArgs: "--remote-debugging-port=9333"` 重构建，用 CDP over WebSocket 做 `Runtime.evaluate` / `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Page.captureScreenshot`；交付前删掉该字段并重构建，最终抓图用 `PrintWindow`。不使用 `SetForegroundWindow`、`SendInput`、真实鼠标移动，不占用用户显示器、鼠标与键盘（A07 §2、§7）。
