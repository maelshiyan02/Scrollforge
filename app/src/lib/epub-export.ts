/**
 * EPUB → 纯文本 / Markdown / HTML（文字提取）。
 *
 * 直接用 foliate-js 解析 EPUB：每个 spine 小节都能 createDocument()，
 * 用 DOM 抽取标题与自然段，避免自己再写一套 XML 解析。
 */

export type ExportFormat = 'txt' | 'md' | 'html'

type Chapter = { title: string; paragraphs: string[] }

const SKIP_RE =
  /(^|\/)(nav|toc|contents|cover|cover[-_.]?\w*|title_?page|titlepage)\.(xhtml|html|htm)$/i

function hrefKey(href: string | undefined | null): string {
  if (!href) return ''
  let value = href
  try {
    value = decodeURIComponent(value)
  } catch {
    // 非法编码按原样
  }
  return value.split('#')[0] ?? ''
}

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 先收集段落级元素；没有就用 body 文本兜底 */
function collectParagraphs(doc: Document): string[] {
  doc.querySelectorAll('script, style, nav, noscript').forEach((el) => el.remove())
  const blocks = doc.querySelectorAll('p, li, blockquote, dd, dt, figcaption')
  if (blocks.length > 0) {
    return Array.from(blocks)
      .map((el) => tidy(el.textContent ?? ''))
      .filter(Boolean)
  }
  return (doc.body?.textContent ?? '')
    .split(/\r?\n+/)
    .map(tidy)
    .filter(Boolean)
}

function firstHeading(doc: Document): string {
  const heading = doc.querySelector('h1, h2, h3')
  return tidy(heading?.textContent ?? '')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function flattenToc(items: any[] | undefined, out: Map<string, string>): void {
  items?.forEach((item) => {
    const key = hrefKey(item?.href)
    if (key && item?.label) out.set(key, tidy(String(item.label)))
    flattenToc(item?.subitems, out)
  })
}

async function readChapters(file: File): Promise<Chapter[]> {
  const { makeBook } = await import('../vendor/foliate-js/view.js')
  const book: any = await makeBook(file)
  if (!book?.sections?.length) throw new Error('无法解析这本 EPUB')

  const labels = new Map<string, string>()
  flattenToc(book.toc, labels)

  const chapters: Chapter[] = []
  for (const section of book.sections) {
    if (typeof section.createDocument !== 'function') continue
    const key = hrefKey(section.id)
    if (SKIP_RE.test(key)) continue
    let doc: Document | null = null
    try {
      doc = await section.createDocument()
    } catch {
      continue
    }
    if (!doc) continue
    const paragraphs = collectParagraphs(doc)
    if (paragraphs.length === 0) continue
    const title = firstHeading(doc) || labels.get(key) || ''
    chapters.push({ title, paragraphs })
  }
  if (chapters.length === 0) throw new Error('这本书没有可提取的文字')
  return chapters
}

/** 生成目标格式的完整文件内容 */
export async function epubToText(file: File, format: ExportFormat, bookTitle: string): Promise<string> {
  const chapters = await readChapters(file)
  if (format === 'md') {
    const parts = chapters.map((chapter) =>
      `${chapter.title ? `## ${chapter.title}\n\n` : ''}${chapter.paragraphs.join('\n\n')}`,
    )
    return `# ${bookTitle}\n\n${parts.join('\n\n')}\n`
  }
  if (format === 'html') {
    const body = chapters
      .map((chapter) => {
        const head = chapter.title ? `<h2>${escapeHtml(chapter.title)}</h2>` : ''
        const paragraphs = chapter.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join('\n')
        return `${head}\n${paragraphs}`
      })
      .join('\n\n')
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(bookTitle)}</title>
<style>body{max-width:42em;margin:2em auto;line-height:1.8;font-family:serif;padding:0 1em} p{text-indent:2em;margin:0 0 .8em} h2{margin:2em 0 1em}</style>
</head>
<body>
${body}
</body>
</html>
`
  }
  const parts = chapters.map((chapter) =>
    `${chapter.title ? `${chapter.title}\n\n` : ''}${chapter.paragraphs.join('\n\n')}`,
  )
  return `${parts.join('\n\n\n')}\n`
}
