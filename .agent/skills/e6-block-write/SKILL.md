---
title: E6 块级写回工作流
description: Scrollforge 项目专用：EPUB 编辑器的「所见即所得 → 只替换 dirty 块 → 未改动段逐字节保留」端到端工作流。以后加 E6 子功能（脚注块、代码块、新建书拆块、翻译直接写回编辑器段落）时复用此 skill。
scope: Scrollforge 项目
version: 1.0
tags: [e6, epub-edit, block-write, wysiwyg, sanitize, epubcheck]
created: 2026-11-02
refs:
  - file: src-tauri/src/epub_edit.rs
    lines: 1-330
    desc: Rust 块扫描 scan_blocks_raw + 倒序替换 apply_block_edits
  - file: src/lib/inline-format.ts
    lines: 1-260
    desc: sanitizeInline 白名单 + XMLSerializer XML 合法性校验
  - file: src/components/EpubEditPanel.tsx
    lines: 1-700
    desc: EpubEditPanel 段落视图 + 只提交 dirty 块的 applyBlocks
---

# E6 块级写回工作流

## 一、核心原则

**三个不可违反的约束**（违反任意一个就不是 E6 了）：

1. **只替换 dirty 块**：前端 `applyBlocks` 只给 `inner` 改过的、`tagChanged` 的或 `deletedIdx` 里的块 push payload；后端 `apply_block_edits` 对这些块做区间替换，**其他块连字节级都不碰**。
2. **前后端扫描规则 1:1 对齐**：Rust `scan_blocks_raw` 和前端 `blockElements(doc)` 必须对同一个 xhtml 文件产出完全相同的块索引；扫描器做了「单层包裹容器下钻」和「跳过空 `<a id>` 锚点」，两边都要做。
3. **块内写回必须合法 XML**：`sanitizeInline` 白名单清洗 → XMLSerializer 序列化节点树 → DOMParser 校验；**不能用 innerHTML 做校验**（`<br>` 未闭合、`&nbsp;` 不是 XML 预定义实体会导致假失败）。

## 二、工作流时序

```
用户在 EpubEditPanel 段落视图里编辑
    │
    ▼
前端 blockEdits.current[i] = 新 innerHTML
    │
    ▼
点「应用改动」→ applyBlocks()
    │
    ├─ 收集 dirty 块（inner 改动 / tag 改动 / delete）
    ├─ sanitizeInline(restorePreview(编辑, originals))
    │   └─ 白名单清洗 + XMLSerializer + XML 校验
    ▼
invoke edit_write_blocks({ opfAbs, href, payload: [{index, inner?, tag?, delete?}] })
    │
    ▼
Rust apply_block_edits
    ├─ 从后往前 sort_by(|a,b| b.index.cmp(&a.index))
    ├─ 每个块：replace_range(start..end, new_string)
    ├─ 区间重叠立即报错
    ├─ 最后 validate_xml（quick-xml）
    ▼
返回 replaced / deleted / total / bytesBefore / bytesAfter
    │
    ▼
pack_epub → run_epubcheck → 前端 toast 显示
```

## 三、扫描规则（前后端同步参考）

**body 子元素 → 单层下钻 → 过滤锚点**：

```
body.children
    └─ 如果只有一个 section/div/article 且 children > 0
        └─ 取它的 children 作为候选列表
    否则直接取 body.children
    └─ filter(el => !isAnchorOnly(el))
```

**isAnchorOnly 判定**：`el.tagName.toLowerCase() === 'a' && !el.firstElementChild && !el.textContent?.trim()`

**块类型**（Rust scan_blocks_raw 正则）：`p / h1..h6 / div / blockquote / li`；`<aside>` 和 `<pre>` 目前跳过，后续扩展时注意两边同步加。

## 四、内联白名单（inline-format.ts）

**允许标签**：`em strong i b a span br img`
**允许属性**：`href title src alt class`
**剥离协议**：`javascript: vbscript: data:`

**sanitizeInline 输出校验**：
```ts
const serialized = new XMLSerializer().serializeToString(out)
const xdoc = new DOMParser().parseFromString(
  `<div xmlns="http://www.w3.org/1999/xhtml">${xml}</div>`,
  'application/xhtml+xml',
)
if (xdoc.querySelector('parsererror')) throw new Error('XML 不合法')
```

**绝对禁止用 innerHTML 做 XML 校验**——innerHTML 保留 `<br>` 未闭合形式、保留 `&nbsp;` 非预定义实体，对 XML DOMParser 会直接抛 "Unexpected closing tag" 错误。

## 五、tag 改动时 payload 必须只带 tag

前端 `changeBlockTag` **绝对不能**同时存 innerHTML 到 `blockEdits.current[i]`。否则 payload 里同时出现 `{index, tag:'h2', inner:<原 innerHTML>}` → Rust `apply_block_edits` 会用 inner 重写块内内容 → 即使 inner 与原字节相同，块内的缩进 / 换行风格 / XML 实体写法等字节级细节都会丢失。

**正确做法**：只 `setBlocks(prev => prev.map((r,i) => i===index ? {...r, tag:'h2'} : r))`，**不写 blockEdits**。`applyBlocks` 里 tagChanged 判断靠 `row.tag !== row.origTag`，不依赖 blockEdits。

## 六、epubcheck 参数顺序

CLI 必须：
```
java -jar epubcheck.jar --json <temp-report.json> <input.epub>
```

**不能**：`--json <epub>`——epubcheck 会把 EPUB 当成 JSON 输出文件，stdout 空，应用层静默"假通过"。

报告解析：读 temp-report.json → `parse_epubcheck_json` 提取 `messages[]`，按 `level === 'ERROR' || level === 'FATAL'` 过滤。

## 七、端到端验收 checklist

真实样本 EPUB 上必须通过：

- [ ] 改 1 段 inner → 其余 N 段原文逐字节存在
- [ ] 改 1 段 tag=h2 → 重扫确认 tag 已变 h2
- [ ] 删 1 段 → 重扫确认该段消失
- [ ] 改 h2 的 payload 只有 `{index, tag:'h2'}` **没有 inner 字段**（Playwright 断言）
- [ ] pack_epub → run_epubcheck → 0 fatal / 0 error / 0 warning
- [ ] 坏 epub 能产出非空 epubcheck 消息（证明报告真跑了）

## 八、已踩过的坑（防重犯）

1. **epubcheck `--json` 参数位置**（A07 #239）：必须 `--json <文件> <epub>`，不能直接跟 EPUB
2. **sanitizeInline XML 校验用 innerHTML**（A07 #240）：`<br>` 未闭合 + `&nbsp;` 实体导致假失败
3. **changeBlockTag 多提交 inner**（A07 #241）：块内字节丢失；payload 只能有 tag
4. **新建书 buildEpub 整章一个 section**：扫描器单层下钻能算对，但源码层还是 section 包裹；后续拆块时改生成器直接输出段落
5. **vite 监听 IPv6 [::1]:1420**：Playwright 走 127.0.0.1 连不上 → 用 `--host 127.0.0.1`

## 九、后续 E6 子功能扩展点

| 扩展 | 改哪里 | 要点 |
|---|---|---|
| `<aside>` 脚注块可编辑 | Rust scan_blocks_raw 正则 + 前端 blockElements | 两边同步加；块类型列表加 aside |
| `<pre>` 代码块可编辑 | 同上 | 代码块不能走 contentEditable（会吞空格/换行），需 textarea |
| 新建书 buildEpub 按段落拆块 | `lib/epub-writer.ts` pageXhtml | 去掉 `<section class="chapter">` 包裹，段落直接作 body 子元素 |
| 编辑器段落直接翻译 | EpubEditPanel 每块加「翻译这段」按钮 | 调 translateOne → blockEdits.current[i] = innerHTML → 走同一条写回链路 |
