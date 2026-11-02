/**
 * 把 Markdown / HTML / FB2 归一化成纯文本，再交给 TXT 的章节识别器。
 * 这样多格式共用同一套分页、进度与排版内核，不需要为每种格式再写渲染器。
 */

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/<[^>]+>/g, '')
}

/** 从 HTML 文本里抽出「标题行 + 正文段落」。 */
function htmlToText(raw: string): string {
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  doc.querySelectorAll('script, style, noscript, nav, header, footer').forEach((el) => el.remove())
  const blocks: string[] = []
  const walk = (element: Element) => {
    const tag = element.tagName.toLowerCase()
    if (/^h[1-6]$/.test(tag)) {
      const text = element.textContent?.replace(/\s+/g, ' ').trim()
      if (text) blocks.push(`\n\n${text}\n\n`)
      return
    }
    if (['p', 'li', 'blockquote', 'pre', 'dd', 'dt'].includes(tag)) {
      const text = element.textContent?.replace(/\s+/g, ' ').trim()
      if (text) blocks.push(`${text}\n\n`)
      return
    }
    element.childNodes.forEach((node) => {
      if (node.nodeType === Node.ELEMENT_NODE) walk(node as Element)
      else if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.replace(/\s+/g, ' ').trim()
        if (text) blocks.push(`${text}\n\n`)
      }
    })
  }
  if (doc.body) walk(doc.body)
  return blocks.join('')
}

/** FB2 是 XML：section/title 当章节名，p 当段落。 */
function fb2ToText(raw: string): string {
  const doc = new DOMParser().parseFromString(raw, 'application/xml')
  if (doc.querySelector('parsererror')) return htmlToText(raw)
  const lines: string[] = []
  doc.querySelectorAll('body section').forEach((section) => {
    const title = Array.from(section.querySelectorAll('title > p'))
      .map((p) => p.textContent?.trim() ?? '')
      .filter(Boolean)
      .join(' ')
    if (title) lines.push(`\n\n${title}\n\n`)
    section.querySelectorAll(':scope > p').forEach((p) => {
      const text = p.textContent?.trim()
      if (text) lines.push(`${text}\n\n`)
    })
  })
  if (lines.length === 0) {
    doc.querySelectorAll('p').forEach((p) => {
      const text = p.textContent?.trim()
      if (text) lines.push(`${text}\n\n`)
    })
  }
  return lines.join('')
}

/** 统一入口：返回可以喂给 analyzeTxt 的纯文本。 */
export function toPlainText(raw: string, format: string): string {
  const ext = format.toLowerCase()
  if (ext === 'md') return stripMarkdown(raw)
  if (ext === 'html' || ext === 'htm') return htmlToText(raw)
  if (ext === 'fb2') return fb2ToText(raw)
  return raw
}

/** 文件读取失败时的兜底编码名（HTML/FB2 也走 decodeText）。 */
