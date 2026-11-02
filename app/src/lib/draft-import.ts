/**
 * 新建书的章节导入：TXT 复用现有识别，Markdown / HTML 做轻量解析。
 *
 * 只产出「标题 + 纯文字自然段」，与 `analyzeTxt()` 的数据结构一致，
 * 这样预览里的章节与最终产物里的章节不会二次解析出错。
 */

import { analyzeTxt, type TxtChapter } from './txt-chapters'

export type DraftFormat = 'txt' | 'md' | 'html'

export function draftFormatOf(fileName: string): DraftFormat {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  if (ext === 'md' || ext === 'markdown') return 'md'
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'html'
  return 'txt'
}

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 去掉最常见的 Markdown 行内标记，只留文字 */
function stripInline(text: string): string {
  return tidy(
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
      .replace(/([*_~]{1,3})([^*_~]+)([*_~]{1,3})/g, '$2')
      .replace(/^[>\s]*/, '')
      .replace(/^[-+*]\s+/, '')
      .replace(/^\d+[.)]\s+/, ''),
  )
}

/** 只保留有正文的章节，同时把空段落剔除 */
function tidyChapters(chapters: TxtChapter[]): TxtChapter[] {
  return chapters
    .map((chapter) => ({
      ...chapter,
      paragraphs: chapter.paragraphs.map(tidy).filter(Boolean),
    }))
    .filter((chapter) => chapter.paragraphs.length > 0)
}

function parseMarkdown(text: string): TxtChapter[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const chapters: TxtChapter[] = []
  let current: TxtChapter | null = null
  let buffer: string[] = []

  const flushParagraph = () => {
    const paragraph = stripInline(buffer.join(' '))
    buffer = []
    if (!paragraph) return
    if (!current) current = { paragraphs: [] }
    current.paragraphs.push(paragraph)
  }
  const flushChapter = () => {
    flushParagraph()
    if (current) chapters.push(current)
    current = null
  }

  for (const raw of lines) {
    const line = raw.trim()
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushChapter()
      current = { title: stripInline(heading[2]) || undefined, paragraphs: [] }
      continue
    }
    if (!line) {
      flushParagraph()
      continue
    }
    buffer.push(line)
  }
  flushChapter()
  return tidyChapters(chapters)
}

function parseHtml(html: string): TxtChapter[] {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const body = doc.body
  if (!body) return []

  const chapters: TxtChapter[] = []
  let current: TxtChapter | null = null
  const textOf = (el: Element) => tidy(el.textContent ?? '')
  const isHeading = (el: Element) => /^(h1|h2|h3)$/i.test(el.tagName)

  const flushChapter = () => {
    if (current) chapters.push(current)
    current = null
  }

  for (const el of Array.from(body.children)) {
    if (isHeading(el)) {
      flushChapter()
      current = { title: textOf(el) || undefined, paragraphs: [] }
      continue
    }
    const blocks = Array.from(el.querySelectorAll('p, li, blockquote'))
    const paragraphs = (blocks.length > 0 ? blocks : [el]).map(textOf).filter(Boolean)
    if (paragraphs.length === 0) continue
    if (!current) current = { paragraphs: [] }
    current.paragraphs.push(...paragraphs)
  }
  flushChapter()
  return tidyChapters(chapters)
}

/**
 * 按文件类型解析成章节。无法识别时退回「整篇作为一章」。
 */
export function parseDraft(fileName: string, text: string): TxtChapter[] {
  const format = draftFormatOf(fileName)
  try {
    if (format === 'md') {
      const chapters = parseMarkdown(text)
      if (chapters.length > 0) return chapters
    } else if (format === 'html') {
      const chapters = parseHtml(text)
      if (chapters.length > 0) return chapters
    } else {
      const chapters = tidyChapters(analyzeTxt(text).chapters)
      if (chapters.length > 0) return chapters
    }
  } catch {
    // 解析失败走兜底
  }
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n+/)
    .map((line) => tidy(line))
    .filter(Boolean)
  return paragraphs.length > 0 ? [{ paragraphs }] : []
}
