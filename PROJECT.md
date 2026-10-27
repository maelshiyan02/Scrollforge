# Scrollforge

> 电子书阅读器 · 不只是阅读，更是锻造

**官网**：待补充  
**GitHub**：https://github.com/maelshiyan02/Scrollforge  
**许可**：MIT  
**平台**：Windows 10/11（优先）→ macOS / Linux（后续）

---

## 项目简介

Scrollforge 是一款面向深度阅读者的电子书阅读器。名字来自 **Scroll**（卷轴）+ **Forge**（锻造炉）——一本好书像一卷古籍，而阅读不只是翻阅，更是锻造：改错别字、翻译人名、加注释、做高亮、AI 摘要、格式转换、朗读配音……把原始文本锻造成属于你自己的版本。

### 核心理念

| 传统阅读器 | Scrollforge |
|------------|-------------|
| 翻页看故事 | 锻造你的版本 |
| 只读不写 | 边读边改边标注 |
| 脚注跳转记页码 | 脚注气泡当场显示 |
| 格式单一 | TXT / EPUB / MOBI / PDF 互通互转 |
| 读完就忘 | AI 记住一切，随时回忆 |

### 目标用户

- 大量阅读轻小说 / 网文 / 四大名著的中文读者
- 需要对文本做标注、翻译校对的深度阅读者
- 讨厌脚注跳转的古典文学爱好者
- 想把 TXT 转成 EPUB 的自制电子书人

---

## 技术栈

| 层 | 选择 | 理由 |
|----|------|------|
| **桌面壳** | Tauri v2 | 安装包 ~10MB，内存 ~50MB，Rust 安全，比 Electron 轻 15 倍 |
| **前端** | React 19 + Vite | 活生态，组件多，比 Next.js 轻 |
| **后端** | Rust | 格式解析性能；SQLite (rusqlite)；搜索 (tantivy) |
| **格式解析** | Rust 自写 EPUB/MOBI + Python 备用 | Readest 已有先例 |
| **EPUB 渲染** | Readium.js | Web Components，EPUB 3 标准实现 |
| **数据库** | SQLite (rusqlite) | 本地优先，零配置 |
| **AI 后端** | Rust + HTTP API | 可切换本地模型 / 云端 API |

### 可参考的开源骨架

| 项目 | 参考什么 | GitHub |
|------|----------|--------|
| **ReadAware** | Tauri + React + Rust + SQLite 整体架构 | `ahpxex/read-aware` |
| **Readest** | Rust 格式解析 (epub_parser / mobi_parser) | `readest/readest` |
| **Calibre** | 脚注气泡 CSS 交互模式 | Python + Qt，**不要重写** |
| **月读 yuedu** | TXT 章节识别、连续滚动、段落级进度记忆 | `vsh5dvsch7-png/yuedu` |
| **Koodo Reader** | React 前端架构成熟实践 | `koodo-reader/koodo-reader` |

---

## 功能路线图

### Phase 1 — 最小可用阅读器（2-3 周）

| # | 功能 | 复杂度 | 参考 |
|---|------|--------|------|
| 1 | 书架管理 + 本地导入 (TXT/EPUB) | 低 | ReadAware |
| 2 | TXT 自动章节识别（第X章 + --- 分隔线） | 低 | 月读 |
| 3 | EPUB 渲染 + 目录导航 | 中 | Readium.js |
| 4 | 连续滚动 + 翻页模式切换 | 低 | 月读 |
| 5 | 段落级进度记忆（改字号不跑位） | 低 | 月读 |
| 6 | 主题切换（5-8 种：护眼/夜间/羊皮纸...） | 低 | 月读 |
| 7 | 字号/行距/缩进调整 | 低 | 通用 |

### Phase 2 — 进阶阅读体验（2-3 周）

| # | 功能 | 复杂度 | 参考 |
|---|------|--------|------|
| 8 | **Calibre 风格脚注气泡**（点击引用，视口内弹出，不跳转） | 低 | Calibre `body.calibre-footnote-container` |
| 9 | 高亮 + 笔记（选中文本 → 弹窗标注） | 中 | ReadAware |
| 10 | 正文搜索（SQLite FTS5） | 中 | 通用 |
| 11 | TTS 朗读 | 中 | 系统 TTS API |
| 12 | 老板键 / 透明窗口 | 中 | 月读 |

### Phase 3 — "锻造"核心（4-6 周）

| # | 功能 | 复杂度 | 说明 |
|---|------|--------|------|
| 13 | **文本编辑**：改错别字、修人名翻译 | 高 | 需版本管理 |
| 14 | **段落翻译**：选中翻译 + 一键替换 | 高 | AI 后端接入 |
| 15 | **AI 摘要**：章节级 / 全书级摘要 | 中 | AI 后端接入 |
| 16 | **注释气泡**：你自己加的注释，和脚注气泡一样 | 低 | 复用脚注气泡实现 |
| 17 | 格式转换：TXT → EPUB，EPUB → TXT | 中 | ebooklib (Python) 或自写 Rust |
| 18 | 导出 EPUB（含封面 + 目录 + 注释） | 中 | ebooklib |

### Phase 4 — 高级功能（按需）

| # | 功能 |
|---|------|
| 19 | AI Agent（ReadAware 模式：问书、记书、回忆书） |
| 20 | 联网搜书（兼容 so-novel 书源格式） |
| 21 | WebDAV / 本地局域网同步 |
| 22 | TXT / EPUB / MOBI / PDF 统一渲染管线 |
| 23 | 配音（角色语音 + TTS） |

---

## 技术细节备忘

### TXT 章节识别逻辑（已验证）

```python
# 真正章节 = 第X章 正则 + 下一行是 --- 分隔线
for i in range(len(lines) - 1):
    if re.match(r'^第(\d+)章\s*(.*)', lines[i].strip()) \
       and re.match(r'^-{3,}$', lines[i+1].strip()):
        # 这才是真章节
```

### 段落处理

```python
# 轻小说格式：每行一句、空行分段 → 非空行直接是独立段落
paragraphs = [line.strip() for line in lines if line.strip()]
```

### Calibre 风格脚注气泡

```javascript
document.addEventListener('click', (e) => {
  const link = e.target.closest('a.footnote, a[href^="#fn"]');
  if (!link) return;
  e.preventDefault();
  const footnote = document.getElementById(link.getAttribute('href').slice(1));
  // 创建 fixed DIV 气泡，注入 footnote.innerHTML
});
```

### Tauri v2 项目结构

```
Scrollforge/
├── Cargo.toml              # Rust 后端
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── parser/         # EPUB/TXT 格式解析
│   │   ├── db/             # SQLite 操作
│   │   └── ai/             # AI API 桥接
│   └── tauri.conf.json
├── src/                    # React 前端
│   ├── components/
│   │   ├── Shelf/          # 书架
│   │   ├── Reader/         # 阅读器（核心）
│   │   ├── Settings/       # 设置
│   │   └── Forge/          # 编辑/翻译/AI 面板
│   └── App.tsx
├── package.json
└── README.md
```

---

## 参考项目

| 项目 | 技术栈 | 体积 | 可借鉴 |
|------|--------|------|--------|
| ReadAware | Tauri v2 + React + Rust + SQLite | ~10MB | 整体骨架、IPC、DB schema |
| Readest | Tauri v2 + Next.js + Rust | ~10MB | Rust 格式解析 |
| Koodo Reader | Electron + React | ~150MB | 前端架构经验 |
| 月读 | Electron 33 + 纯 JS | ~100MB | 章节识别、连续滚动 |
| Calibre | Python + Qt | ~100MB | 脚注气泡交互 |
| Wenku8_Flutter | Flutter | - | 轻小说体验细节 |

---

## 命名溯源

**Scrollforge** = Scroll（卷轴/古籍）+ Forge（锻造炉）

- Scroll 比 Book/Tome 更有东方古籍的质感，暗示"穿越时光的阅读"
- Forge 强调"加工"而非"观看"——不只是读，还要改、要翻译、要 AI 摘要
- 和 Celstack（动画追番器）的 Cel（赛璐璐）同属行业内部术语，取巧但精准

---

*文档版本：v1.0 · 2026-10-27 · 基于《灭门家族的重生者》EPUB 转换实践 + GitHub 开源项目调研*
