import { EPUB } from '../vendor/foliate-js/epub.js'
import type { TxtChapter } from './txt-chapters'

/**
 * 把识别好的 TXT 章节包装成一本"内存里的 EPUB"。
 *
 * 不落盘、不压缩：直接用 foliate 的 EPUB 解析器 + 虚拟 loader 提供文本资源，
 * 这样分页、双页、竖排、CFI 进度全部复用 Phase 0 的内核，TXT 不需要另写一套排版。
 * Phase 2 的转换向导可以把同一份章节数据写成真正的 .epub 文件。
 */

export type VirtualTocEntry = { label: string; href: string }

export type BuiltTxtBook = {
  book: any
  toc: VirtualTocEntry[]
  /** 章节标题数量（不含前言/自动分块） */
  headingCount: number
}

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>\n'

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function chapterFile(index: number): string {
  return `text/ch${String(index).padStart(4, '0')}.xhtml`
}

function buildChapterXhtml(title: string | undefined, paragraphs: string[]): string {
  const body = paragraphs.map((p) => `      <p>${escapeXml(p)}</p>`).join('\n')
  const heading = title ? `      <h2>${escapeXml(title)}</h2>\n` : ''
  return `${XML_HEAD}<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN" xml:lang="zh-CN">
  <head>
    <title>${escapeXml(title ?? '正文')}</title>
    <link rel="stylesheet" type="text/css" href="../style.css"/>
  </head>
  <body>
    <section epub:type="chapter">
${heading}${body}
    </section>
  </body>
</html>`
}

const STYLE_CSS = `html { font-size: 18px; }
body {
  margin: 0;
  font-family: "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "SimSun", serif;
  line-height: 1.9;
  text-align: justify;
  color: #2f2b26;
}
h2 {
  margin: 1.4em 0 1em;
  font-size: 1.22em;
  font-weight: 600;
  text-align: center;
  line-height: 1.6;
}
p { margin: 0 0 0.55em; text-indent: 2em; }
`

export async function buildTxtBook(
  title: string,
  chapters: TxtChapter[],
  headingCount: number,
): Promise<BuiltTxtBook> {
  const files = new Map<string, string>()
  const toc: VirtualTocEntry[] = []

  files.set(
    'META-INF/container.xml',
    `${XML_HEAD}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
  )

  files.set('OEBPS/style.css', STYLE_CSS)

  const manifest: string[] = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
  ]
  const spine: string[] = []
  const navItems: string[] = []

  chapters.forEach((chapter, index) => {
    const href = chapterFile(index)
    const label = chapter.title ?? (chapters.length > 1 ? `片段 ${index + 1}` : '正文')
    files.set(`OEBPS/${href}`, buildChapterXhtml(chapter.title, chapter.paragraphs))
    manifest.push(
      `<item id="ch${index}" href="${href}" media-type="application/xhtml+xml"/>`,
    )
    spine.push(`<itemref idref="ch${index}"/>`)
    navItems.push(`      <li><a href="${href}">${escapeXml(label)}</a></li>`)
    // 目录里的链接相对 nav.xhtml；给 goTo 用完整路径，否则 foliate 按资源表查不到
    toc.push({ label, href: `OEBPS/${href}` })
  })

  files.set(
    'OEBPS/nav.xhtml',
    `${XML_HEAD}<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-CN">
  <head><title>目录</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目录</h1>
      <ol>
${navItems.join('\n')}
      </ol>
    </nav>
  </body>
</html>`,
  )

  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  files.set(
    'OEBPS/content.opf',
    `${XML_HEAD}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:scrollforge:txt:${escapeXml(title)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>zh-CN</dc:language>
    <dc:creator>Scrollforge</dc:creator>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine>
    ${spine.join('\n    ')}
  </spine>
</package>`,
  )

  const encoder = new TextEncoder()
  const loader = {
    loadText: async (name: string) => files.get(name) ?? null,
    loadBlob: async (name: string) =>
      new Blob([files.get(name) ?? ''], { type: 'application/octet-stream' }),
    getSize: (name: string) => encoder.encode(files.get(name) ?? '').length,
    sha1: undefined,
  }

  const book = await new EPUB(loader).init()
  return { book, toc, headingCount }
}
