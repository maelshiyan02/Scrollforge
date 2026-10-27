# Scrollforge 对话开场白

> 用于 Trae 新会话的启动模板。直接复制粘贴即可开始对应开发。
> 本文件顶部的「参考项目与骨架」是每次新会话必读的固定上下文——避免模型重新摸索、重复造轮子。

---

# 零、参考项目与骨架（先读这段）

## 0.1 骨架选择：fork Readest，而不是从零搭

**结论：Scrollforge 以 [readest/readest](https://github.com/readest/readest) 为骨架进行改造。**

理由：它是 Foliate 的现代重写，技术栈与我们计划完全一致（Tauri v2 + Next.js 16 + React + TypeScript），已经实现了我们要从零写的大部分底层能力。

| 项 | 值 |
| --- | --- |
| 仓库 | `readest/readest` |
| 规模 | 约 2.57 万 star |
| 技术栈 | Next.js 16 + Tauri v2 + TypeScript（monorepo） |
| 许可证 | **AGPL-3.0** |
| 已支持格式 | EPUB / PDF / MOBI / KF8(AZW3) / FB2 / CBZ / TXT / HTML / Markdown |
| 已支持功能 | 滚动+翻页双模式、全文搜索（书内与全库）、高亮/书签/笔记、词典与维基查询、双栏并行阅读、字体排版与主题色定制、代码高亮、文件关联 |

**改造清单（fork 后要做的减法与加法）**：

| 动作 | 内容 |
| --- | --- |
| 减法 | 移除云端同步、订阅/商店相关模块；裁掉不需要的平台构建目标（先只留 Windows） |
| 减法 | 清理原项目品牌（app 名、图标、About 页、官网链接、更新检查地址） |
| 换装 | 替换 `src-tauri/icons/` 全套图标为仓库根目录的 `icon.png`；配色取自最终图标实测值：外框橙 `#E37B26`、书封内页 `#FFAD2C`、线条淡青白 `#CEFFF7` |
| 加法 | 新增「锻造」编辑层：段落级改写、翻译替换、注释绑定、版本快照（本项目的差异化核心） |
| 加法 | TXT 章节识别改用我们在 EPUB 转换里验证过的规则（`第X章` + 下一行 `---`） |

**关键路径**（以仓库实际结构为准）：`apps/readest-app/src-tauri/`（Rust 端）、`apps/readest-app/src/`（前端）。

> 备选路线（仅当不愿受 AGPL 约束时启用）：`create-tauri-app` 官方脚手架 → 渲染内核用 foliate-js(MIT) → 排版 CSS 用 readium/css(BSD-3)。这条路线授权最干净，但书架、进度、注释、搜索都要自己写。

## 0.2 参考项目清单（已核验 star 与许可证）

| 项目 | star | 语言 | 许可证 | 我们拿它做什么 |
| --- | --- | --- | --- | --- |
| `readest/readest` | 25.7k | TypeScript | AGPL-3.0 | **骨架**：整套 Tauri 阅读器架构直接改造 |
| `johnfactotum/foliate-js` | 1.1k | JavaScript | **MIT** | **渲染内核**（自建路线）：EPUB/MOBI/KF8/FB2/CBZ/PDF，纯 JS、模块化、无硬依赖、不整本读入内存。官方建议以 git submodule 引入（无正式 release，API 会变） |
| `koodo-reader/koodo-reader` | 28.6k | JavaScript | AGPL-3.0 | **UI/交互参照**：书架布局、阅读工具栏、主题系统。我们本机已安装，可直接对照真实交互 |
| `ahpxex/read-aware` | 479 | TypeScript | AGPL-3.0 | **功能架构蓝本**：自进化 Agent 的跨书记忆 + 沙箱插件系统，正是我们要的「编辑/翻译/摘要」扩展形态 |
| `vsh5dvsch7-png/yuedu`（月读） | 34 | HTML | NOASSERTION | **TXT 阅读体验参照**：章节识别、连续滚动、老板键、透明桌面模式 |
| `edrlab/thorium-reader` | 2.9k | TypeScript | BSD-3-Clause | Readium 路线参照：无障碍、LCP、出版物元数据 |
| `readium/css` | 127 | HTML | BSD-3-Clause | **可直接引入**：翻页/滚动分栏、主题变量的排版样式表 |
| `futurepress/epub.js` | 7.0k | JavaScript | GitHub 标 NOASSERTION（须核对 LICENSE） | EPUB 渲染备选库，CFI 定位老牌实现 |
| `johnfactotum/foliate` | 8.8k | JavaScript/GTK | GPL-3.0 | 功能与交互对照（Linux GTK 版，代码不能移植到 Windows） |
| `kovidgoyal/calibre` | 26.3k | Python | GPL-3.0 | **脚注气泡交互参照**：`body.calibre-footnote-container` 那套弹窗脚注，我们最想要的那个特性 |
| `mikufoxxx/Wenku8_Flutter` | 986 | Dart | GPL-2.0 | TXT 轻小说的章节识别与排版参照（TXT 章节规则、段落缩进） |

## 0.3 许可证红线（每次涉及"抄代码"时必须遵守）

- **可以复制/引入代码**：`foliate-js`（MIT）、`readium/css`（BSD-3）、`thorium-reader`（BSD-3）。保留版权声明即可。
- **只能读、不能抄**：`readest`、`koodo-reader`（AGPL-3.0）、`calibre`、`foliate`（GPL-3.0）。GPL 系代码一旦进入我们的代码库，整个项目就被传染为 GPL。
- **若 fork readest**：Scrollforge 整体即成为 AGPL-3.0 衍生作品——公开分发必须提供完整源码。我们的仓库本来就公开，这一点可以接受；但**不能**把 readest 的代码搬进 Celstack 这种非 AGPL 项目。
- 跨项目共享想复用 readest 的 Rust 模块时，要么整个共享库也 AGPL，要么只参考写法、自己重写。

## 0.4 当前优先级：先做 Scrollforge

1. Scrollforge 优先启动（本机只有 Koodo Reader 可作真实交互对照，其余参考全靠上面列出的仓库）。
2. Celstack 暂缓，等 Scrollforge 的 `db / ai / config` 基建跑通后再启动，避免两套地基各写一遍。

## 0.5 ReadAware 与月读（更正：两者都真实存在，且是重要参照）

早期文档一直提到 ReadAware 和月读，我用搜索接口查不到，一度误判为不存在——实际是仓库名带连字符（`read-aware`），搜索结果里被拆词了。直接按仓库地址核验后确认：

| 项目 | star | 语言 | 许可证 | 定位 | 我们拿它做什么 |
| --- | --- | --- | --- | --- | --- |
| `ahpxex/read-aware` | 479 | TypeScript | AGPL-3.0 | 带「自进化 Agent」的阅读器：跨书阅读记忆、沙箱插件系统、EPUB/MOBI/AZW3/FB2/PDF 全离线；monorepo（`apps/` 分层） | **功能架构蓝本**：Agent 记忆层与插件系统的设计直接照它，比 readest 更接近我们「阅读 + 编辑 + 翻译 + 摘要」的设想 |
| `vsh5dvsch7-png/yuedu`（月读） | 34 | HTML | NOASSERTION | Windows 桌面小说阅读器：透明桌面模式、老板键、txt/epub、章节定位、自定义书源 | **TXT 阅读体验参照**：章节识别、连续滚动、老板键这三项 |

结论不变：**骨架仍选 readest**（成熟度与维护活跃度优先），ReadAware 作为 Agent/插件层的架构参照，月读作为 TXT 阅读体验参照。

---

## 模板 1：环境初始化（fork Readest 骨架）

```
我要启动 Scrollforge 项目开发，骨架是 fork readest/readest（Tauri v2 + Next.js 16 + React + TypeScript，AGPL-3.0）。请按顺序做：
1. 检查本地环境：Rust（含 MSVC 工具链）、Node 20+、pnpm、WebView2 运行时
2. 把 readest 克隆到 D:\AI Coding Project Management\Scrollforge\app，保留上游 git 历史，单独加 remote upstream
3. 只保留 Windows 构建目标，移除其他平台的构建脚本
4. 全局替换项目品牌：app 名 Scrollforge、标识符 com.scrollforge.app、图标替换为仓库根目录的 icon.png
5. 移除云端同步与订阅/商店相关模块，确认移除后能正常编译
6. 跑起来，确认能打开一本 EPUB 并翻页

注意：readest 是 AGPL-3.0，本项目按 AGPL-3.0 开源，不要把它当成可闭源使用的依赖。
```

## 模板 2：Phase 1 功能开发（书架 + TXT 阅读器）

```
Scrollforge Phase 1：在 readest 骨架上补齐 TXT 阅读链路。需求：
1. 书架页面：复用 readest 现有书架，只补 TXT 格式的卡片样式与封面占位
2. 本地导入 TXT（drag & drop + 文件选择）：接 readest 现有的文件导入通道
3. TXT 章节识别：换成本项目已验证的规则——`第X章` 标题行 **且下一行是 `---` 分隔线**，配 4000 字前向窗口扫描，清理标题里的方括号
4. 阅读器页面：连续滚动、段落级渲染（每个非空行一个独立 <p>，不要把多行合并成段）、字体/行距/缩进调整（复用 readest 的排版设置面板）
5. 进度存 SQLite（readest 的 Rust 端已有数据库层，沿用其封装，不要另起一套）

参考项目：readest（书架与进度实现，同仓库直接读）、foliate-js（TXT/EPUB 解析接口设计，MIT）、Wenku8_Flutter（轻小说 TXT 的章节切分与缩进处理，仅读不抄，GPL-2.0）
```

## 模板 3：Calibre 风格脚注气泡

```
Scrollforge Phase 2：实现 Calibre 风格的脚注气泡功能。需求：
1. 拦截脚注点击：在渲染框架的 document 上监听 `a[epub\:type~="noteref"]`、`a.footnote`、href 指向 `#` 的锚点，preventDefault 阻止跳转
2. 从目标节点取脚注原文：优先 `<aside epub:type="footnote">`，退化为 `<ol class="footnotes">` / `<div id="footnotes">` 里的对应条目
3. 在视口中央弹出 fixed 气泡显示原文，最大高度 60vh 可滚动，圆角半透明白底 + 阴影
4. 点气泡外部或按 ESC 关闭；连续点击多个脚注时替换内容而不是叠层
5. 注意：foliate-js / readest 用 iframe 渲染正文，气泡 DOM 要挂在宿主页面而不是 iframe 内，否则会被 iframe 裁剪或裁掉

参考 Calibre（GPL-3.0，**只读实现、不抄代码**）：`body.calibre-footnote-container a.footnote` 那套拦截 + 内联弹窗思路；它的做法是把脚注内容插进一个绝对定位容器，而不是跳转到书末。
```

## 模板 4：渲染内核与进度定位确认

```
Scrollforge：先确认渲染内核，再动进度定位。
1. 如果走 fork readest 路线：内核已经是 foliate-js 的工程化版本，不要另行接入 epub.js 或 Readium，避免两套渲染器打架
2. 如果走自建路线：渲染内核选 foliate-js（MIT，纯 JS，支持 EPUB/MOBI/KF8/FB2/CBZ/PDF），以 git submodule 引入；排版样式直接引 readium/css（BSD-3）
3. 进度定位统一用 CFI：记录到段落级，不要只存滚动像素，窗口尺寸变化后像素会失效
4. 目录导航桥接到左侧栏；章节树从 NCX 和 nav.xhtml 双向读取，取得到哪个用哪个
5. 主题切换要能同时作用于正文 iframe 与外壳 UI
```

> 说明：`epub.js` 不是 Readium 官方库，它是独立项目（futurepress），许可证在 GitHub 上标记为 NOASSERTION，引入前必须核对 LICENSE 文件。Readium 的 JS 路线对应的是 `readium/css`（样式表）与 `edrlab/thorium-reader`（Electron 实现）。

## 模板 5：文本编辑与翻译（锻造核心）

```
Scrollforge Phase 3：实现"锻造"核心——文本编辑功能。需求：
1. 在阅读器中选中文本 → 弹出浮动工具栏（修改 / 翻译 / 注释）
2. 修改：直接替换原文段落，本地 SQLite 存 diff（原文 → 修改后）
3. 翻译：选中段落 → 调用 AI API → 返回译文 → 确认替换
4. 注释：选中段落 → 写注释 → 和段落 ID 绑定，脚注气泡形式显示
5. 版本管理：每次修改都保存快照，可回滚

参考 ahpxex/read-aware（AGPL-3.0，只读设计不抄代码）：它的插件系统是"同时扩展阅读器与 Agent"的双向扩展点，插件能注册工具给 Agent 调用——我们的"锻造"层可以照这个形状设计：每个编辑动作（改错字/统一人名/加注释）都做成可被 AI 调用的工具，而不是写死一个按钮。
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

## 模板 9：对照本机 Koodo Reader 的真实交互

```
Scrollforge：本机装了 Koodo Reader，帮我用它作为真实交互对照，逐项比对并出改进清单：
1. 书架页：分组方式、排序、封面网格密度、右键菜单项
2. 阅读器：顶部/底部工具栏的按钮集合、翻页热区、快捷键
3. 设置面板：字体、行距、页边距、主题的调节粒度
4. 脚注/注解的呈现方式
只做交互与信息层级的对照，不要反编译或复制其代码（Koodo 是 AGPL-3.0）。
```

---

## 跨项目模板：和 Celstack 统一基建

```
Scrollforge 和 Celstack 共用 Tauri v2 + React + Rust + SQLite 基建。帮我把共用部分提取成共享库：
1. Rust 端：db (rusqlite 封装)、ai (AI API 桥接)、config (用户设置)
2. 前端：hooks (useSettings / useAI / useDB)、components (SettingsPanel / AIModal)
3. 设计为 npm workspace 或 git submodule，两个项目都能引用

许可证约束：共享库必须是独立重写的代码。若直接搬 readest 的 Rust 模块，共享库会一起变成 AGPL-3.0，Celstack 也会被传染——所以共享层只允许参考写法，不允许复制代码。
```
