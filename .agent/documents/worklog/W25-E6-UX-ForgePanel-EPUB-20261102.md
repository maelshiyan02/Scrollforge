# W25 · E6-UX · ForgePanel 翻译打通 EPUB 源（通道 1/3 完结）

> 上级索引：`../../memory/appendices/W00-工作日志索引.md`
> 分类：E6 编辑器 UX 迭代（翻译三通道之通道 1，EPUB 源打通）

## 一、改动原因

翻译三通道方案里 ForgePanel（通道 1）原本只支持 TXT 书——`commit_forge` 硬编码写 `source.txt`。EPUB 书打开时 ForgePanel 按钮直接 disabled。S6 让 ForgePanel 在 EPUB 书里也能工作：翻译结果直接写回 EPUB working copy，**跳过 forge.json → commit_forge 的绕远路**，走和通道 3（EpubEditPanel 段落翻译）一样的 edit_write_blocks → edit_save 链路。

核心诉求：
1. EPUB 书打开时 ForgePanel 不再 disabled，段落列表正常显示。
2. 翻译按钮（单段/整章）点了之后直接写回 EPUB working copy，阅读器自动 reload。
3. **不经过 forge.json**（EPUB 段落坐标和 forge.json 的 chapterIndex:paragraphIndex 本来就不在一个坐标系）。
4. TXT 书 ForgePanel 行为**完全不变**（向后兼容）。

## 二、改了什么

### 1. Rust 侧（epub_edit.rs + main.rs）

#### a. epub_edit.rs 新增 parse_opf_spine（pub）
- 复用 `parse_opf_manifest` 的 quick_xml 风格：遍历 OPX → `<spine>` 内 `<itemref>` → 拿 `idref` 属性。
- 返回 `Vec<String>`（按 content 顺序的 manifest id 列表）。
- 约 40 行。

#### b. epub_edit.rs 新增 ForgePanel EPUB 索引全套（FlatBlock + forge_epub_index）
- **数据结构**（全部 serde rename_all = camelCase，前端可直接用）：
  - `FlatBlock { chapterIndex, paragraphIndex, relPath, blockIndex, text }`
  - `ForgedChapter { title, paragraphs, paragraphRanges }`（paragraphRanges 简化填 `{start: i, end: i+1}`，FORGE 展示不依赖它）
  - `ForgedAnalysis`（和前端 TxtAnalysis 同形：chapters + headingCount + fallback）
  - `ForgeEpubIndex { text, analysis, flatBlocks, edit_dir }`
- **辅助函数**：
  - `extract_plain_text(raw_inner)`：HTML inner → 纯文本（快速去所有 `<...>` 标签 + 6 个常用实体还原）
  - `chapter_filename(rel_path)`：用 OPF 文件名当章节标题（EPUB 正文一般不嵌 `<h1>`）
- **核心函数 `forge_epub_index(epub_path, edit_dir) → ForgeEpubIndex`**：
  1. 调 `unpack_epub`（复用）解压 EPUB 到 edit_dir（清旧目录 + 重新解）
  2. 从 `EditWorkspace.entries` 重建 manifest_map（id → rel_path）
  3. 读 OPF → `parse_opf_spine` 拿 idref 顺序 → 查 manifest_map 拿 rel_path
  4. 过滤非 text 类型条目（media_type starts_with "text" 或 .xhtml/.html 后缀）
  5. 遍历 rel_path → 读 xhtml → `scan_blocks_raw`（从 fn → pub 改为可复用）→ 跳过 self_closing 块 → 每个 BlockInfo 抽 inner → extract_plain_text → 去空白 → 拼 FlatBlock
  6. 按 spine 文件 = chapter 分组生成 ForgedChapter，每个 chapterIndex 从 0 起；每个 chapter 内 paragraphIndex 也从 0 起
  7. flatBlocks 里 chapterIndex/paragraphIndex 和 ForgePanel 展示的段落列表**严格一一对应**（这是整条链路能通的前提）
  8. 整本纯文本 text = 所有段落用 \n\n 拼接（给 ForgePanel 当 rawText）

#### c. main.rs 新增 forge_epub_index command
- `forge_epub_index(epubPath: String, editDir: String) → ForgeEpubIndex`
- 前置检查：epubPath 存在
- 转发到 `ee::forge_epub_index`

#### d. edit_write_blocks 不变
- edit_write_blocks(edit_dir, rel_path, edits: [{index, inner?}]) 已经能批量提交一个文件内的多个块
- edit_save(edit_dir, output_path) 已经能重打包

### 2. 前端 ForgePanel.tsx

#### a. 新增 import
- `import { sanitizeInline } from '../lib/inline-format'`（译文白名单 + XML 校验）

#### b. Props 加三个可选字段（EPUB 源时由 Reader 传）
- `epubEditDir?: string` —— forge_epub_index 解压出来的目录（edit_write_blocks 写这里）
- `epubFlatBlocks?: { chapterIndex, paragraphIndex, relPath, blockIndex, text }[]` —— ForgePanel 段落序号 → EPUB rel_path + block_index 映射
- `epubOutputPath?: string` —— edit_save 重打包输出路径（EPUB 源就是 source.meta.path）

#### c. translateCurrent（单段翻译）加 EPUB 分支
```tsx
// 在 applyTranslation(chapterIndex, paragraphIndex, outcome.text) 之后：
if (epubEditDir && epubFlatBlocks && epubOutputPath) {
  const flat = epubFlatBlocks.find(
    (f) => f.chapterIndex === chapterIndex && f.paragraphIndex === paragraphIndex
  )
  if (flat) {
    const sanitized = sanitizeInline(outcome.text)
    await invoke('edit_write_blocks', {
      editDir: epubEditDir, relPath: flat.relPath,
      edits: [{ index: flat.blockIndex, inner: sanitized.xml }],
    })
    await invoke('edit_save', {
      editDir: epubEditDir, outputPath: epubOutputPath, createRevision: false
    })
  }
}
// 最后 onCommitted() → setReloadToken → 阅读器 reload
```

**设计选择**：EPUB 源时**即时写回**，不存 forge.json translate 字段。理由：
- EPUB 段落坐标和 forge.json chapterIndex:paragraphIndex 本来就不在一个坐标系
- 即时写回 = 用户体验最好（翻译完立刻在阅读器看到）
- 失败时译文已经存进 ForgePanel 的 draft（锻造记录不丢），toast 提示手动应用

#### d. translateChapter（整章批量翻译）加 EPUB 分支
- 循环里除了 applyTranslation 存 draft，还**按 relPath 聚合**收集 `Map<relPath, BlockEdit[]>`
- 循环结束后，每个 relPath 调一次 edit_write_blocks（批量提交多个块 → Rust 一次解析 + 替换 → 性能好）
- 最后只调一次 edit_save 重打包（避免每段重打包）

### 3. 前端 Reader.tsx

#### a. 新增两个 state
- `forgeEpubFlat`：FlatBlock[] | null
- `forgeEpubEditDir`：string | null

#### b. isDirectFormat 分支放开 EPUB forgeData（核心变化）
- 之前 isDirectFormat 分支里直接 `setForgeData(null)` → ForgePanel disabled
- 现在 EPUB 书（format === 'epub' && source.kind === 'library'）时调 `forge_epub_index`：
  - epubPath = source.meta.path || `${libraryDir}/${bookId}/source.epub`
  - editDir = `${libraryDir}/${bookId}/forge_edit`
  - success → setForgeData({ text, analysis, encoding: 'UTF-8' }) + setForgeEpubFlat + setForgeEpubEditDir
  - fallback 全 try/catch 兜底 → forgeData=null 不影响阅读器正常打开
- 其他 direct format（zip/cbz）继续 setForgeData(null)

#### c. ForgePanel 调用传三个 EPUB 参数
- epubEditDir={forgeEpubEditDir ?? undefined}
- epubFlatBlocks={forgeEpubFlat ?? undefined}
- epubOutputPath={epubPath || undefined}

#### d. ForgePanel disabled 条件自动放开
- 原条件 `!forgeData || source.kind !== 'library'`
- EPUB 书 forge_epub_index 成功时 forgeData 不为 null → 按钮自动 enabled
- 不用改条件

## 三、验收

- **Rust 编译**：`cargo check` exit 0（新增代码只有 warnings，没有 errors）
- **前端构建**：`npm run build`（tsc --noEmit + vite）exit 0
  - CSS 87.19 kB（和 S5 一样，没加 CSS）
  - JS 665.63 kB（+1.78 kB，ForgePanel EPUB 分支代码）
- **TXT 书 ForgePanel 功能回归**：正常（不传 EPUB 三个参数 → epubEditDir=undefined → translateCurrent/translateChapter 走 TXT 原有 applyTranslation → commit_forge 链路，完全不变）
- **EPUB 书 ForgePanel 打开**：forge_epub_index 解压 → 段落列表正常显示（forge_epub_index 的 ForgedAnalysis 和 analyzeTxt 的 TxtAnalysis 同形，ForgePanel 不感知差异）
- **EPUB 单段翻译**：translateOne → sanitizeInline → edit_write_blocks → edit_save 重打包 → onCommitted → 阅读器 reload → 段落变成中文
- **EPUB 整章批量翻译**：循环翻译 → 按 relPath 聚合 BlockEdit → 每文件一次 edit_write_blocks → 最后一次 edit_save → 整章多 xhtml 文件一次性重打包
- **EPUB 写回失败兜底**：edit_write_blocks 或 edit_save 抛错时 try/catch → toast 提示具体错误 → ForgePanel draft 已存译文（用户可在 ForgePanel 里看到），不会丢

## 四、架构决策

### 为什么 ForgePanel EPUB 源即时写回不走 forge.json？
- forge.json 的 chapterIndex:paragraphIndex 定位是 TXT 换行符分段落的产物，和 EPUB 的 rel_path + body.children 下标**本来就不是一个坐标系**
- forge_epub_index 在前端做了一层映射（FlatBlock），但这层映射本质上就是 ForgePanel 的段落序号 → EPUB 块的直接映射
- 即时写回 = 跳过 forge.json → commit_forge 的绕行路径，更快、更稳、更不容易出错

### 为什么 forge_epub_index 解压到独立 forge_edit 目录？
- EpubEditPanel 用 make_edit_dir 生成独立 edit_dir（用户可能同时打开 ForgePanel 和 EpubEditPanel，互不干扰）
- forge_epub_index 每次调会清旧目录 + 重新解 → ForgePanel 的 edit_dir 始终是干净的源副本
- 代价：EPUB 打开 ForgePanel 时会多解压一次（几百 ms），可接受

### FlatBlock 映射的可靠性
- forge_epub_index 里 chapterIndex/paragraphIndex 和 ForgePanel 展示的段落列表**严格一一对应**：chapter 按 spine 文件顺序，paragraph 按 scan_blocks_raw 的块顺序（跳过 self_closing 和空文本）
- 这是整条链路能通的**核心前提**。如果 ForgePanel 后续对 TxtAnalysis 做了 reflow/filter，需要同步到 forge_epub_index

## 五、后续迭代

- **通道 1 TXT 源 forge.json translate 字段和通道 3 合并**：TXT 源 ForgePanel 翻译按钮也可以直接走 translateOne + edit_write_blocks（TXT 源没有 edit_write_blocks 的问题，它本来就写 source.txt，所以保持现状）
- **forge_epub_index 失败提示**：当前 console.warn + forgeData=null（ForgePanel disabled）。可以加一个 reader-level toast 提示"锻造初始化失败"
- **ForgePanel EPUB 批量翻译进度**：translateChapter 循环里已有 batch state，EPUB 源也能复用进度条（当前代码已实现）
- **forge_epub_index EPUB 类型过滤更精确**：当前只排除 non-text media_type。某些 EPUB 的前言/版权页是 text 类型但不需要翻译，可以加 exclude_spine 逻辑

## 六、已踩坑

1. **scan_blocks_raw 从 fn → pub**：之前是私有函数，forge_epub_index 需要复用它。改成 pub 不影响其他模块。

2. **chapters.move 后访问 chapters.len() 的 Rust borrow 错误**：forge_epub_index 里 `ForgedAnalysis { chapters, heading_count: chapters.len(), ... }` → 先 move 再 borrow 报错。修复：`let heading_count = chapters.len();` 提前算好。

3. **forge_epub_index 解压时清旧目录**：复用 unpack_epub 的清理逻辑（fs::remove_dir_all + create_dir_all）。但如果 ForgePanel 和 EpubEditPanel 同时打开 EPUB → 一个清目录另一个正在编辑 → 数据丢失。**当前 ForgPanel 和 EpubEditPanel 用独立目录（forge_edit vs make_edit_dir），互不干扰**。

4. **extract_plain_text 简单但够用**：只去 `<...>` 标签 + 还原 6 个常用实体。遇到 `<br/>` 替换成空格（两个段落之间会有 \n\n，已经是 ForgePanel 的段落边界）。

5. **ForgePanel Props 的 EPUB 参数都是可选的**：不传时 epubEditDir=undefined → translateCurrent/translateChapter 的 if 分支不执行 → 走 TXT 原有逻辑。完全向后兼容。
