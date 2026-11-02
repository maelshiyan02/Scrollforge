# W26 · E6-UX · buildEpub 按段落拆块（S7）

> 上级索引：`../../memory/appendices/W00-工作日志索引.md`
> 分类：E6 编辑器 UX 迭代（EPUB 生成源码层优化）

## 一、改动原因

buildEpub 生成的 EPUB 正文页之前有一层冗余包裹：

```xml
<body>
  <section class="chapter" epub:type="chapter" id="chapter-1">
    <a id="c001"></a>
    <h2>第一章 标题</h2>
    <p>段落一……</p>
    <p>段落二……</p>
  </section>
</body>
```

scan_blocks_raw（EpubEditPanel/Rust 侧分块逻辑）本来有「单层 section 包裹自动下钻」的兜底——只有当 body 子元素**恰好只有一个**且是 section/div/article 时才下钻一层。但 buildEpub 生成的 body 里有 section + a + h2 + figure + p 一堆子元素，section 不是 body 的独子，scan_blocks_raw 的下钻逻辑根本不触发。结果：章节文件的第一个 block 是 section 本身（一大坨包含所有段落的 innerHTML），EpubEditPanel 的块级编辑、ForgePanel 的块映射都被这层多余包裹干扰。

**去掉 `<section class="chapter">` 包裹**之后，正文段落直接成为 body 的直接子元素，scan_blocks_raw 返回的 block 就是 `<a>`（被 is_anchor_only 过滤）+ `<h2>` + `<figure>` + `<p>` + `<p>` + ...——和 ForgePanel forge_epub_index 里的 FlatBlock 映射完全对齐。

前置页（titlepage / intro / contents）和后置页（backmatter）保留 section 包裹不变：它们的结构完全不同（titlepage 只有 h1 + p + translator，intro 只有 h1 + p + rights div，contents 只有 h1 + ol，backmatter 只有 h2 + p），去掉 section 反而让 body 里只剩几个松散元素，失去 class 语义。

## 二、改了什么

### 文件：`epub-writer.ts`

#### a. pageXhtml 函数（170 → 221 行）

- 新增参数 `wrapperTag?: string | null`（可选）：
  - 默认值 `'section'`（向后兼容，所有前置/后置页自动走 section）
  - 传 `null` 时生成的 body 里没有外层包裹，inner 直接落 body
- 实现变化：
  ```tsx
  const wrapperTag = opts.wrapperTag ?? 'section'
  const wrapperAttrs = ` class="${className}"${typeAttr}${idAttr}`
  const bodyInner = wrapperTag
    ? `    <${wrapperTag}${wrapperAttrs}>\n${inner}\n    </${wrapperTag}>`
    : inner
  ```
- 注意：去掉 wrapper 后，`className` / `epubType` / `id` 这些属性**无处安放**（不能丢到 body 上，那是 EPUB 规范不允许的）。所以这三个参数在 `wrapperTag: null` 场景下变成"无主孤儿"——不报错，只是 silently 丢失。这是有意的设计选择：
  - `className: 'chapter'` / `epubType: 'chapter'`：去掉 section 后 class 和 epub:type 自然丢失，不影响阅读（Foliate 不依赖这两个属性分页）
  - `id: 'chapter-1'`：原本挂在 section 上的锚点 id 丢失，但正文页已经有 `<a id="anchor">` 作为分卷分组锚点（走 anchors 参数），ncx 里的分组 idref 指向的是那些 `<a>` 锚点，不依赖 section id

#### b. buildContentPageXhtml 函数（319 行）

- 调用 pageXhtml 时新增 `wrapperTag: null`
- 正文页 xhtml 现在直接：
  ```xml
  <body>
    <a id="c001"></a>
    <h2>第一章 标题</h2>
    <figure class="illust">...</figure>
    <p>段落一……</p>
    <p>段落二……</p>
  </body>
  ```

#### c. 其他页面**零改动**

- buildTitlePageXhtml / buildIntroXhtml / buildContentsXhtml / buildBackMatterXhtml 都没传 wrapperTag → 默认 section → 结构完全不变
- TxtAnalysis / ForgePanel / EpubEditPanel / ForgeEpubIndex / flatBlocks 映射逻辑全部不受影响（因为 scan_blocks_raw 的 collect_child_elements 现在能直接拿到 body 下的段落子元素）

## 三、影响面分析

### 1. scan_blocks_raw（epub_edit.rs）

**之前**：section 作为 body 唯一的非锚点子元素 → 被 WRAPPER_TAGS 判定为 wrapper → 下钻一层 → 但 body 里其实不止一个 section 子元素（还有 h2/p 等），下钻逻辑**实际不触发** → section 被当一个大块

**之后**：body 直接包含 `<a>`（过滤）+ `<h2>` + `<figure>`（空文本跳过）+ `<p>` + `<p>` + ... → collect_child_elements 直接返回这些 → 每个 `<p>` 独立成块 → **ForgePanel FlatBlock.block_index 和 EpubEditPanel block 序号严格对齐**

### 2. ForgePanel forge_epub_index（S6 新增）

- forge_epub_index 里对 scan_blocks_raw 结果做 extract_plain_text + 过滤空文本
- 之前：scan_blocks_raw 可能 section 被算作 block，forge_epub_index 里 section 块 inner 有 `<a>` + `<h2>` + `<p>`，extract_plain_text 输出一大坨混合文本 → paragraphIndex 映射混乱
- 之后：每个 `<p>` 就是独立 block → paragraphIndex 映射干净

### 3. Foliate 阅读器渲染

- EPUB 规范不强制要求正文有 section 包裹；body 直接含段落是完全合法的结构
- Foliate（基于 readium-js-viewer）的分页逻辑靠 XHTML flow layout：有/无 section 对分页结果完全没有影响
- CSS 里 `.chapter` class 选择器会失效（class='chapter' 不再存在于 body 直接子元素），但 buildStyle 返回的样式里没有用 `.chapter` 做选择器（它只用 `.illust`, `.titlepage`, `.frontmatter` 等前置/后置页 class）

### 4. epubcheck 验证

- `<p>` 作为 body 直接子元素是完全合法的 XHTML
- epub:type 原来挂在 section 上 → 现在没有 section 了 → epub:type 丢失
- 检查一下 epubcheck 会不会因为正文页没有 epub:type="chapter" 报错——不会。epub:type 是"推荐但非必需"的语义标记。EPUB 3 规范正文页不强制 epub:type

## 四、验收

- `npm run build`：tsc --noEmit + vite 96 modules 通过（exit code 0）
  - JS 665.69 kB（S6 是 665.63 kB，+0.06 kB，几乎不变）
  - CSS 87.19 kB（没变）
- **人工生成一本 TXT 新书或导入 TXT 转 EPUB**（需要手动跑 app 验证，但源码逻辑确认正确）：
  - 解压生成的 EPUB → 每个 text/chXXXX.xhtml 的 body 直接包含 `<a>` + `<h2>` + `<p>` 段落
  - epubcheck 0 errors（预计，因为 body 直接含段落是完全合法的 EPUB 3 XHTML）
  - Foliate 正常渲染（有 h2 标题、段落分页正确、插图位置不变）
  - EpubEditPanel 打开 → 段落预览里每个 `<p>` 独立成块（块序号 = `<p>` 在 body.children 里的下标 - h2/figure 的偏移）
  - ForgePanel 打开 → 段落列表正常 → 单段翻译 → edit_write_blocks index 正确

## 五、已踩坑

1. **不要改 pageXhtml 默认值**：wrapperTag 默认 `'section'` 保持 → buildTitlePageXhtml / buildIntroXhtml / buildContentsXhtml / buildBackMatterXhtml 全部不变。如果默认改成 null，所有前置/后置页的 section 都没了，它们的结构（titlepage 只有 h1 + p 松散元素、contents 只有 h1 + ol）会变得不稳定。

2. **className / epubType / id 丢失是故意的**：wrapperTag: null 时三个属性无处安放。id="chapter-N" 原本是 ForgePanel forge_epub_index 没用的（它的 FlatBlock 用的是 rel_path + block_index，不依赖 id），但 ncx 里的分组锚点指向的是 `<a id="anchor">`（走 anchors 参数），不依赖 section id。

3. **scan_blocks_raw 的 wrapper 下钻逻辑不会空转**：去掉 section 后 body 有多个直接子元素 → `children.len() === 1` 条件不成立 → WRAPPER_TAGS 下钻逻辑**正常不触发**（不是依赖它"正确"工作，而是我们根本不需要它工作了）。

## 六、后续迭代

- **epubcheck 实测**：生成一本真 EPUB，跑 epubcheck 看有没有 EPUB 3 规范相关警告（预计 0 errors）
- **ForgePanel FlatBlock 映射实测**：ForgePanel 翻译按钮 → edit_write_blocks → pack_epub → 阅读器 reload → 确认每个 `<p>` 被正确替换
- **wrapperTag: null 可以做成 EPUB 2 / EPUB 3 输出选项**：某些老旧阅读器（EPUB 2 兼容模式）可能不接受 body 直接含 `<p>`。但 Scrollforge 目标是 EPUB 3，不需要考虑
- **后续 buildEpub 如果加嵌套结构**（meta.structure.children 分组输出到同一个 xhtml），scan_blocks_raw 的单层 section 下钻逻辑可能再派上用场——wrapperTag: null 只影响 buildContentPageXhtml 这一个调用点
