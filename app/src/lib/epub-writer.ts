/**
 * 把 TXT 识别结果写成真正的 EPUB 3 文件（不压缩，结构完整）。
 *
 * 章节数据直接来自 `analyzeTxt()`：预览看到的章节就是产物里的章节，
 * 不做二次解析，避免"预览与成品不一致"。
 *
 * 也支持传入 `meta.structure`（树形节点）：新建书向导的「分卷 / 章」层级
 * 会输出嵌套 nav、ncx 与书内目录页。
 */

import type { TxtChapter } from './txt-chapters'
import { createZip, type ZipEntry } from './zip-store'

export type EpubStylePreset = 'zh-serif' | 'en-serif' | 'minimal'

export type EpubImage = {
  bytes: Uint8Array
  /** image/jpeg、image/png、image/webp */
  mediaType: string
  /** 写进 zip 的扩展名：jpg / png / webp */
  ext: string
}

/** 兼容旧调用：封面就是一张图片 */
export type EpubCover = EpubImage

export type EpubBackMatter = {
  /** 例如「番外」「作者后记」「译者后记」 */
  title: string
  paragraphs: string[]
}

/** 正文树节点：有 children 的节点是分卷分组，叶子节点是一章 */
export type EpubTreeNode = {
  title?: string
  paragraphs?: string[]
  /** 章节插图（可选，作为该页首图） */
  image?: EpubImage | null
  children?: EpubTreeNode[]
}

export type EpubMeta = {
  title: string
  author: string
  /** BCP 47，如 zh-CN / zh-TW / en / ja */
  language: string
  /** 译者（可选，写进书名页与 OPF） */
  translator?: string
  /** 简介（可选，生成「简介」前置页；换行分段） */
  description?: string
  /** 版权信息（可选，附在简介页末尾） */
  rights?: string
  /** 正文树（优先于 chapters 参数；支持分卷层级） */
  structure?: EpubTreeNode[]
  /** 番外 / 后记（可选，正文之后逐篇生成） */
  backMatter?: EpubBackMatter[]
  /** 样式预设；不传按中文衬线 */
  stylePreset?: EpubStylePreset
  /** 段落首行缩进两字（覆盖预设） */
  indent?: boolean
  /** 章节标题居中（覆盖预设） */
  centerHeading?: boolean
  /** 封面（可选，嵌入 images/cover.* 并生成封面页） */
  cover?: EpubCover | null
}

/** 目录链接节点：href 为空表示纯分组；target 是 ncx 用的落地地址 */
type Link = { label: string; href: string; target: string; children: Link[] }

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n'
const encoder = new TextEncoder()

/** XML 转义，并剔除 XML 1.0 不允许的控制字符 */
function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 按行拆段：简介、版权这类多行文本一比一段 */
function paragraphLines(text: string | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 书的语言决定前置/后置页的固定文案 */
function pageLabels(language: string) {
  const zh = /^zh/i.test(language)
  return {
    sep: zh ? '：' : ': ',
    cover: zh ? '封面' : 'Cover',
    titlePage: zh ? '书名页' : 'Title Page',
    intro: zh ? '简介' : 'About the Book',
    contents: zh ? '目录' : 'Contents',
    front: zh ? '前置' : 'Front Matter',
    body: zh ? '正文' : 'Body',
    back: zh ? '后置' : 'Back Matter',
    translator: zh ? '译者' : 'Translated by',
  }
}

function chapterFile(index: number): string {
  return `text/ch${String(index + 1).padStart(4, '0')}.xhtml`
}

/** 番外 / 后记等后置页 */
function backFile(index: number): string {
  return `text/back-${String(index + 1).padStart(2, '0')}.xhtml`
}

function chapterLabel(chapter: TxtChapter, index: number, count: number): string {
  const title = chapter.title?.trim()
  if (title) return title
  if (count === 1) return '正文'
  return `片段 ${index + 1}`
}

function styleFlags(meta: EpubMeta) {
  const preset = meta.stylePreset ?? 'zh-serif'
  return {
    preset,
    indent: meta.indent ?? (preset === 'zh-serif'),
    centerHeading: meta.centerHeading ?? (preset === 'zh-serif'),
  }
}

function buildStyle(meta: EpubMeta): string {
  const { preset, indent, centerHeading } = styleFlags(meta)
  const fonts: Record<EpubStylePreset, string> = {
    'zh-serif': '"Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", serif',
    'en-serif': 'Georgia, "Times New Roman", "Nimbus Roman", "Source Han Serif SC", serif',
    minimal: '"PingFang SC", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif',
  }
  const lineHeight = preset === 'en-serif' ? '1.65' : preset === 'minimal' ? '1.75' : '1.85'
  const align = preset === 'minimal' ? 'left' : 'justify'
  return `html { font-size: 1em; }
body {
  margin: 0;
  font-family: ${fonts[preset]};
  line-height: ${lineHeight};
  text-align: ${align};
  color: ${preset === 'minimal' ? '#333' : '#2f2b26'};
  -webkit-hyphens: ${preset === 'en-serif' ? 'auto' : 'manual'};
  hyphens: ${preset === 'en-serif' ? 'auto' : 'manual'};
}
h1, h2 {
  margin: 1.4em 0 1em;
  font-size: ${preset === 'minimal' ? '1.15em' : '1.3em'};
  font-weight: 600;
  line-height: 1.55;
  text-align: ${centerHeading ? 'center' : 'left'};
  page-break-after: avoid;
  break-after: avoid;
}
p {
  margin: 0 0 ${preset === 'minimal' ? '0.75em' : '0.5em'};
  text-indent: ${indent ? '2em' : '0'};
  orphans: 2;
  widows: 2;
}
.cover { margin: 0; padding: 0; text-align: center; page-break-after: always; break-after: page; }
.cover img { max-width: 100%; max-height: 100vh; }
.titlepage { padding: 18vh 8% 0; text-align: center; }
.titlepage h1 { font-size: 1.9em; margin: 0 0 1.4em; }
.titlepage .tp-byline { margin: 0.5em 0; text-indent: 0; text-align: center; color: #4b453c; }
.titlepage .tp-translator { color: #7a7266; font-size: 0.95em; }
.frontmatter h1, .contents-page h1, .backmatter h1 { margin-top: 1.2em; }
.frontmatter .rights { margin-top: 2.6em; font-size: 0.85em; color: #7a7266; text-align: center; text-indent: 0; }
.frontmatter .rights p { text-indent: 0; text-align: center; }
.contents-page ol { padding-left: 1.4em; }
.contents-page li { margin: 0.4em 0; }
.contents-page a { color: #2f2b26; text-decoration: none; }
.contents-page .toc-group { color: #7a7266; font-size: 0.92em; letter-spacing: 0.04em; }
.illust { margin: 0 0 1.2em; text-align: center; }
.illust img { max-width: 100%; height: auto; }
`
}

/** 统一的前置/后置页模板，保证 head 与样式引用一致 */
function pageXhtml(opts: {
  language: string
  title: string
  cssHref: string
  className: string
  epubType?: string
  id?: string
  /** ncx 分组锚点：必须落在目标页里，否则 epubcheck 报 RSC-012 */
  anchors?: string[]
  inner: string
  /** S7：正文页传 null 去掉外层 wrapper（段落直接当 body 子元素）；其他页面默认 section */
  wrapperTag?: string | null
}): string {
  const { language, title, cssHref, className, epubType, id, anchors, inner: rawInner } = opts
  const anchorXml = (anchors ?? []).map((anchor) => `      <a id="${anchor}"></a>`).join('\n')
  const inner = anchorXml ? `${anchorXml}\n${rawInner}` : rawInner
  const typeAttr = epubType ? ` epub:type="${epubType}"` : ''
  const idAttr = id ? ` id="${id}"` : ''
  const wrapperTag = opts.wrapperTag ?? 'section'
  const wrapperAttrs = ` class="${className}"${typeAttr}${idAttr}`
  const bodyInner = wrapperTag
    ? `    <${wrapperTag}${wrapperAttrs}>
${inner}
    </${wrapperTag}>`
    : inner
  return `${XML_HEAD}<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
  <head>
    <meta charset="utf-8"/>
    <title>${escapeXml(title)}</title>
    <link rel="stylesheet" type="text/css" href="${cssHref}"/>
  </head>
  <body>
${bodyInner}
  </body>
</html>`
}

function buildTitlePageXhtml(meta: EpubMeta, anchors?: string[]): string {
  const labels = pageLabels(meta.language)
  const lines = [
    `      <h1>${escapeXml(meta.title)}</h1>`,
    `      <p class="tp-byline">${escapeXml(meta.author)}</p>`,
  ]
  const translator = meta.translator?.trim()
  if (translator) {
    lines.push(
      `      <p class="tp-byline tp-translator">${escapeXml(labels.translator)}${labels.sep}${escapeXml(translator)}</p>`,
    )
  }
  return pageXhtml({
    language: meta.language,
    title: labels.titlePage,
    cssHref: 'style.css',
    className: 'titlepage',
    epubType: 'titlepage',
    anchors,
    inner: lines.join('\n'),
  })
}

function buildIntroXhtml(meta: EpubMeta, anchors?: string[]): string {
  const labels = pageLabels(meta.language)
  const lines = [`      <h1>${escapeXml(labels.intro)}</h1>`]
  paragraphLines(meta.description).forEach((paragraph) => {
    lines.push(`      <p>${escapeXml(paragraph)}</p>`)
  })
  const rights = paragraphLines(meta.rights)
  if (rights.length > 0) {
    lines.push('      <div class="rights">')
    rights.forEach((paragraph) => lines.push(`        <p>${escapeXml(paragraph)}</p>`))
    lines.push('      </div>')
  }
  return pageXhtml({
    language: meta.language,
    title: labels.intro,
    cssHref: 'style.css',
    className: 'frontmatter',
    epubType: 'frontmatter',
    anchors,
    inner: lines.join('\n'),
  })
}

function buildContentsXhtml(language: string, listXml: string, anchors?: string[]): string {
  const labels = pageLabels(language)
  return pageXhtml({
    language,
    title: labels.contents,
    cssHref: 'style.css',
    className: 'contents-page',
    epubType: 'toc',
    anchors,
    inner: `      <h1>${escapeXml(labels.contents)}</h1>
      <ol>
${listXml}
      </ol>`,
  })
}

function buildBackMatterXhtml(item: EpubBackMatter, language: string, anchors?: string[]): string {
  const paragraphs = item.paragraphs
    .map((paragraph) => `      <p>${escapeXml(paragraph)}</p>`)
    .join('\n')
  return pageXhtml({
    language,
    title: item.title,
    cssHref: '../style.css',
    className: 'backmatter',
    epubType: 'backmatter',
    anchors,
    inner: `      <h2>${escapeXml(item.title)}</h2>
${paragraphs}`,
  })
}

/** 正文页模板：可带插图与目录锚点（分卷分组在 ncx 里指向这些锚点） */
function buildContentPageXhtml(opts: {
  language: string
  label: string
  paragraphs: string[]
  imageHref?: string
  index: number
  anchors: string[]
}): string {
  const parts: string[] = []
  opts.anchors.forEach((anchor) => parts.push(`      <a id="${anchor}"></a>`))
  parts.push(`      <h2>${escapeXml(opts.label)}</h2>`)
  if (opts.imageHref) {
    parts.push(
      `      <figure class="illust"><img src="${opts.imageHref}" alt="${escapeXml(opts.label)}"/></figure>`,
    )
  }
  opts.paragraphs.forEach((paragraph) => parts.push(`      <p>${escapeXml(paragraph)}</p>`))
  return pageXhtml({
    language: opts.language,
    title: opts.label,
    cssHref: '../style.css',
    className: 'chapter',
    epubType: 'chapter',
    id: `chapter-${opts.index}`,
    inner: parts.join('\n'),
    // S7：正文段落直接作为 body 子元素，去掉 <section class="chapter"> 包裹
    wrapperTag: null,
  })
}

function newIdentifier(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (uuid) return `urn:uuid:${uuid}`
  } catch {
    // 忽略，走下面的兜底
  }
  return `urn:scrollforge:${Date.now()}`
}

function modifiedStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 链接树里第一个真实页面地址（不含分组锚点） */
function firstPageHref(links: Link[]): string {
  for (const link of links) {
    if (link.href) return link.href
    if (link.target) return link.target.split('#')[0]
    const nested = firstPageHref(link.children)
    if (nested) return nested
  }
  return ''
}

/** 链接树的最大层级（用于 ncx 的 dtb:depth） */
function linkDepth(links: Link[]): number {
  let max = 0
  links.forEach((link) => {
    const nested = link.children.length ? 1 + linkDepth(link.children) : 0
    if (nested > max) max = nested
  })
  return max + 1
}

/**
 * 生成 EPUB。章节为空时抛错，由调用方转成中文提示。
 *
 * 结构：封面 → 书名页 → 简介 → 目录页 → 正文（可分卷）→ 番外/后记；
 * nav 与 ncx 按层级输出，ncx 的分组锚点保证同一页面下 playOrder 不冲突。
 */
export function buildEpub(chapters: TxtChapter[], meta: EpubMeta): Uint8Array {
  const structure = meta.structure?.length
    ? meta.structure
    : chapters.map((chapter, index) => ({
        title: chapterLabel(chapter, index, chapters.length),
        paragraphs: chapter.paragraphs,
      }))

  const identifier = newIdentifier()
  const modified = modifiedStamp()
  const style = buildStyle(meta)
  const labels = pageLabels(meta.language)
  const language = meta.language

  const manifest: string[] = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
  ]
  const coverManifest: string[] = []
  const extraEntries: ZipEntry[] = []
  const frontSpine: string[] = []
  const bodySpine: string[] = []
  const backSpine: string[] = []
  const frontLinks: Link[] = []
  const backLinks: Link[] = []

  // 正文页计划：先收集锚点再统一渲染，保证分组锚点已落在目标页上
  const pagePlans: { label: string; paragraphs: string[]; imageHref?: string; anchors: string[] }[] = []
  const hrefToPlan = new Map<string, number>()
  const illustManifest: string[] = []
  let illustNo = 0
  let groupNo = 0

  const plainLink = (label: string, href: string): Link => ({ label, href, target: href, children: [] })

  /** 前置/后置页的锚点单独存：这些页在正文页之前生成 */
  const extraPageAnchors = new Map<string, string[]>()
  const addAnchor = (href: string, anchor: string) => {
    const index = hrefToPlan.get(href)
    if (index !== undefined) {
      pagePlans[index]!.anchors.push(anchor)
      return
    }
    const list = extraPageAnchors.get(href)
    if (list) list.push(anchor)
    else extraPageAnchors.set(href, [anchor])
  }

  let bodyLinks: Link[] = []

  function emitNodes(nodes: EpubTreeNode[], out: Link[]) {
    nodes.forEach((node) => {
      const paragraphs = (node.paragraphs ?? []).map((part) => part.trim()).filter(Boolean)
      const children = node.children ?? []
      if (paragraphs.length === 0 && !node.image && children.length === 0) return

      const isGroup = children.length > 0
      const label =
        node.title?.trim() ||
        (isGroup ? `第 ${out.filter((item) => item.children.length > 0).length + 1} 卷` : `第 ${out.length + 1} 章`)

      let href = ''
      if (!isGroup || paragraphs.length > 0 || node.image) {
        const index = pagePlans.length
        let imageHref: string | undefined
        if (node.image) {
          illustNo += 1
          const imagePath = `images/illust-${String(illustNo).padStart(2, '0')}.${node.image.ext}`
          extraEntries.push({ name: `OEBPS/${imagePath}`, data: node.image.bytes })
          illustManifest.push(
            `    <item id="illust${illustNo}" href="${imagePath}" media-type="${node.image.mediaType}"/>`,
          )
          imageHref = `../${imagePath}`
        }
        pagePlans.push({ label, paragraphs, imageHref, anchors: [] })
        href = chapterFile(index)
        hrefToPlan.set(href, index)
      }

      const link: Link = { label, href, target: '', children: [] }
      emitNodes(children, link.children)

      if (isGroup) {
        const targetPage = href || firstPageHref(link.children)
        if (!targetPage) return
        if (href) {
          // 分卷自带页面：直接指向该页，不需要片段
          link.target = href
        } else {
          groupNo += 1
          const anchor = `sf-g${groupNo}`
          addAnchor(targetPage, anchor)
          link.target = `${targetPage}#${anchor}`
        }
      } else {
        link.target = href
      }
      out.push(link)
    })
  }

  emitNodes(structure, bodyLinks)
  bodyLinks = bodyLinks.filter((link) => (link.href || link.target) && link.target)

  if (bodyLinks.length === 0) {
    throw new Error('这本书没有可转换的正文')
  }

  // ─── 前置 / 后置页链接先就位（分组锚点要落到这些页上） ───
  const coverPageHref = 'cover.xhtml'
  if (meta.cover) frontLinks.push(plainLink(labels.cover, coverPageHref))
  frontLinks.push(plainLink(labels.titlePage, 'titlepage.xhtml'))
  const introHref = 'intro.xhtml'
  const hasIntro =
    paragraphLines(meta.description).length > 0 || paragraphLines(meta.rights).length > 0
  if (hasIntro) frontLinks.push(plainLink(labels.intro, introHref))
  const contentsHref = 'contents.xhtml'
  frontLinks.push(plainLink(labels.contents, contentsHref))

  const backItems = (meta.backMatter ?? []).filter((item) => item.paragraphs?.some((p) => p.trim()))
  backItems.forEach((item, index) => backLinks.push(plainLink(item.title, backFile(index))))

  const bodyGroup: Link = { label: labels.body, href: '', target: '', children: bodyLinks }
  const groups: Link[] = [
    { label: labels.front, href: '', target: '', children: frontLinks },
    bodyGroup,
  ]
  if (backLinks.length > 0) {
    groups.push({ label: labels.back, href: '', target: '', children: backLinks })
  }

  // 合成的前置/正文/后置分组需要唯一落点，否则与首个子项同 target 会触发 RSC-005
  groups.forEach((group) => {
    const targetPage = firstPageHref(group.children)
    if (!targetPage) {
      group.target = ''
      return
    }
    groupNo += 1
    const anchor = `sf-g${groupNo}`
    addAnchor(targetPage, anchor)
    group.target = `${targetPage}#${anchor}`
  })

  // ─── 封面 ───
  if (meta.cover) {
    const imageHref = `images/cover.${meta.cover.ext}`
    extraEntries.push({ name: `OEBPS/${imageHref}`, data: meta.cover.bytes })
    extraEntries.push({
      name: `OEBPS/${coverPageHref}`,
      data: encoder.encode(
        pageXhtml({
          language,
          title: labels.cover,
          cssHref: 'style.css',
          className: 'cover',
          epubType: 'cover',
          anchors: extraPageAnchors.get(coverPageHref),
          inner: `      <img src="${imageHref}" alt="${escapeXml(meta.title)}"/>`,
        }),
      ),
    })
    coverManifest.push(
      `    <item id="cover-image" href="${imageHref}" media-type="${meta.cover.mediaType}" properties="cover-image"/>`,
    )
    manifest.push(`    <item id="cover-page" href="${coverPageHref}" media-type="application/xhtml+xml"/>`)
    frontSpine.push('    <itemref idref="cover-page"/>')
  }

  // ─── 书名页（始终生成：没有封面时也能看到书名与作者） ───
  extraEntries.push({
    name: 'OEBPS/titlepage.xhtml',
    data: encoder.encode(buildTitlePageXhtml(meta, extraPageAnchors.get('titlepage.xhtml'))),
  })
  manifest.push('    <item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>')
  frontSpine.push('    <itemref idref="titlepage"/>')

  // ─── 简介 / 版权（有内容才生成，避免空白页） ───
  if (hasIntro) {
    extraEntries.push({
      name: `OEBPS/${introHref}`,
      data: encoder.encode(buildIntroXhtml(meta, extraPageAnchors.get(introHref))),
    })
    manifest.push(`    <item id="intro" href="${introHref}" media-type="application/xhtml+xml"/>`)
    frontSpine.push('    <itemref idref="intro"/>')
  }

  // ─── 番外 / 后记 ───
  backItems.forEach((item, index) => {
    const href = backFile(index)
    extraEntries.push({
      name: `OEBPS/${href}`,
      data: encoder.encode(buildBackMatterXhtml(item, language, extraPageAnchors.get(href))),
    })
    manifest.push(`    <item id="back${index + 1}" href="${href}" media-type="application/xhtml+xml"/>`)
    backSpine.push(`    <itemref idref="back${index + 1}"/>`)
  })

  // ─── 书内目录页（与分卷层级一致） ───
  const contentsList = (links: Link[], indent: string): string =>
    links
      .map((link) => {
        const head = link.href
          ? `<a href="${link.href}">${escapeXml(link.label)}</a>`
          : `<span class="toc-group">${escapeXml(link.label)}</span>`
        if (link.children.length > 0) {
          return `${indent}<li>${head}
${indent}  <ol>
${contentsList(link.children, `${indent}    `)}
${indent}  </ol>
${indent}</li>`
        }
        return `${indent}<li>${head}</li>`
      })
      .join('\n')

  extraEntries.push({
    name: `OEBPS/${contentsHref}`,
    data: encoder.encode(
      buildContentsXhtml(
        language,
        [contentsList(bodyLinks, '        '), contentsList(backLinks, '        ')].filter(Boolean).join('\n'),
        extraPageAnchors.get(contentsHref),
      ),
    ),
  })
  manifest.push(`    <item id="contents" href="${contentsHref}" media-type="application/xhtml+xml"/>`)
  frontSpine.push('    <itemref idref="contents"/>')

  // ─── nav：前置 / 正文（可再嵌分卷）/ 后置 ───
  const navList = (links: Link[], indent: string): string =>
    links
      .map((link) => {
        const head = link.href
          ? `<a href="${link.href}">${escapeXml(link.label)}</a>`
          : `<span>${escapeXml(link.label)}</span>`
        if (link.children.length > 0) {
          return `${indent}<li>${head}
${indent}  <ol>
${navList(link.children, `${indent}    `)}
${indent}  </ol>
${indent}</li>`
        }
        return `${indent}<li>${head}</li>`
      })
      .join('\n')

  const nav = `${XML_HEAD}<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
  <head>
    <meta charset="utf-8"/>
    <title>${escapeXml(labels.contents)}</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>${escapeXml(labels.contents)}</h1>
      <ol>
${navList(groups, '        ')}
      </ol>
    </nav>
    <nav epub:type="landmarks" id="landmarks" hidden="hidden">
      <ol>
${meta.cover ? `        <li><a epub:type="cover" href="cover.xhtml">${escapeXml(labels.cover)}</a></li>\n` : ''}        <li><a epub:type="toc" href="${contentsHref}">${escapeXml(labels.contents)}</a></li>
        <li><a epub:type="bodymatter" href="${chapterFile(0)}">${escapeXml(labels.body)}</a></li>
      </ol>
    </nav>
  </body>
</html>`

  // ─── ncx：按链接树递归；分组锚点已在建页前分配 ───

  // ─── 正文页（锚点齐了再渲染，按文档顺序落盘、进 spine） ───
  const chapterEntries: ZipEntry[] = []
  pagePlans.forEach((plan, index) => {
    const href = chapterFile(index)
    chapterEntries.push({
      name: `OEBPS/${href}`,
      data: encoder.encode(
        buildContentPageXhtml({
          language,
          label: plan.label,
          paragraphs: plan.paragraphs,
          imageHref: plan.imageHref,
          index: index + 1,
          anchors: plan.anchors,
        }),
      ),
    })
    manifest.push(`    <item id="ch${index + 1}" href="${href}" media-type="application/xhtml+xml"/>`)
    bodySpine.push(`    <itemref idref="ch${index + 1}"/>`)
  })

  let navOrder = 0
  const navPointOf = (link: Link, indent: string): string => {
    navOrder += 1
    const id = `np${navOrder}`
    const lines = [
      `${indent}<navPoint id="${id}" playOrder="${navOrder}">`,
      `${indent}  <navLabel><text>${escapeXml(link.label)}</text></navLabel>`,
      `${indent}  <content src="${link.target}"/>`,
    ]
    if (link.children.length > 0) {
      lines.push(link.children.map((child) => navPointOf(child, `${indent}  `)).join('\n'))
    }
    lines.push(`${indent}</navPoint>`)
    return lines.join('\n')
  }

  const ncxPoints = groups
    .filter((group) => group.target)
    .map((group) => navPointOf(group, '    '))
    .join('\n')
  const depth = Math.max(1, ...groups.filter((group) => group.target).map((group) => 1 + linkDepth(group.children)))

  const ncx = `${XML_HEAD}<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="${language}">
  <head>
    <meta name="dtb:uid" content="${escapeXml(identifier)}"/>
    <meta name="dtb:depth" content="${depth}"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${escapeXml(meta.title)}</text></docTitle>
  <navMap>
${ncxPoints}
  </navMap>
</ncx>`

  // ─── OPF ───
  const translator = meta.translator?.trim()
  const description = (meta.description ?? '').trim()
  const rights = (meta.rights ?? '').trim()
  const contributor = translator
    ? `    <dc:contributor id="translator">${escapeXml(translator)}</dc:contributor>
    <meta refines="#translator" property="role" scheme="marc:relators">trl</meta>
`
    : ''
  const descMeta = description ? `    <dc:description>${escapeXml(description)}</dc:description>\n` : ''
  const rightsMeta = rights ? `    <dc:rights>${escapeXml(rights)}</dc:rights>\n` : ''

  const opf = `${XML_HEAD}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${language}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(meta.title)}</dc:title>
    <dc:creator>${escapeXml(meta.author)}</dc:creator>
${contributor}${descMeta}${rightsMeta}    <dc:language>${language}</dc:language>
    ${meta.cover ? '<meta name="cover" content="cover-image"/>' : ''}
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
${[...manifest, ...coverManifest, ...illustManifest].join('\n')}
  </manifest>
  <spine toc="ncx">
${[...frontSpine, ...bodySpine, ...backSpine].join('\n')}
  </spine>
</package>`

  const container = `${XML_HEAD}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`

  const entries: ZipEntry[] = [
    // 必须是第一个条目、不压缩、无额外字段
    { name: 'mimetype', data: encoder.encode('application/epub+zip') },
    { name: 'META-INF/container.xml', data: encoder.encode(container) },
    { name: 'OEBPS/content.opf', data: encoder.encode(opf) },
    { name: 'OEBPS/nav.xhtml', data: encoder.encode(nav) },
    { name: 'OEBPS/toc.ncx', data: encoder.encode(ncx) },
    { name: 'OEBPS/style.css', data: encoder.encode(style) },
    ...extraEntries,
    ...chapterEntries,
  ]

  return createZip(entries)
}

/** 分块转 base64，避免大文件触发 String.fromCharCode 参数上限 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
