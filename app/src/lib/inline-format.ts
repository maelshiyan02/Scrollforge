/**
 * E6：块级可视编辑的内联格式处理。
 *
 * 三件事：
 * 1. previewHtml 把图片/图形换成不可编辑占位，写回前再按原顺序还原；
 * 2. paste/apply 统一走白名单（em/strong/i/b/a/span/br/img，属性仅
 *    href/title/src/alt/class），其余标签剥离并回报数量；
 * 3. 输出用 XMLSerializer 生成 XHTML 片段，保证 & < 与空元素自闭合合法。
 *
 * 这里不碰 CSS / OPF：可视视图只处理正文块。
 */

export const BLOCK_TAGS = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const
export type BlockTag = (typeof BLOCK_TAGS)[number]

export function isBlockTag(tag: string): tag is BlockTag {
  return (BLOCK_TAGS as readonly string[]).includes(tag)
}

export const BLOCK_TAG_LABELS: Record<string, string> = {
  p: '正文',
  h1: '标题 1',
  h2: '标题 2',
  h3: '标题 3',
  h4: '标题 4',
  h5: '标题 5',
  h6: '标题 6',
}

const MEDIA_PLACEHOLDER = '<span class="blk-img" contenteditable="false">［图片］</span>'
const SHAPE_PLACEHOLDER = '<span class="blk-img" contenteditable="false">［图形］</span>'
const PLACEHOLDER_RE =
  /<span class="blk-img" contenteditable="false">(?:［图片］|［图形］)<\/span>/g

/** 把一段块的 innerHTML 变成可显示 HTML，同时记住被替换掉的原始标签 */
export function splitPreview(inner: string): { html: string; originals: string[] } {
  const originals: string[] = []
  const html = inner.replace(
    /<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<img\b[^>]*\/?>|<svg\b[\s\S]*?<\/svg>/gi,
    (match) => {
      if (/^<(script|style)\b/i.test(match)) return ''
      originals.push(match)
      return /^<svg\b/i.test(match) ? SHAPE_PLACEHOLDER : MEDIA_PLACEHOLDER
    },
  )
  return { html, originals }
}

/** 写回前把占位按顺序换回原始 img/svg 标签 */
export function restorePreview(inner: string, originals: string[]): string {
  let index = 0
  return inner.replace(PLACEHOLDER_RE, () => originals[index++] ?? '')
}

const ALLOWED_TAGS = new Set(['em', 'strong', 'i', 'b', 'a', 'span', 'br', 'img'])
const ALLOWED_ATTRS = new Set(['href', 'title', 'src', 'alt', 'class'])
/** 连同内容一起丢弃的危险标签 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'head',
  'title', 'form', 'input', 'button', 'select', 'textarea', 'video', 'audio',
  'canvas', 'svg', 'math', 'base',
])

function safeHref(value: string): boolean {
  const url = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  if (!url) return false
  return !/^(?:javascript|vbscript|data):/i.test(url)
}

function safeSrc(value: string): boolean {
  const url = value.trim().replace(/[\u0000-\u001f\u007f]/g, '')
  if (!url) return false
  if (/^data:/i.test(url)) return /^data:image\//i.test(url)
  return !/^(?:javascript|vbscript):/i.test(url)
}

function cleanNode(node: Node, removedTags: string[], removedAttrs: string[]): Node | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.textContent ?? '')
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null

  const el = node as Element
  const tag = el.tagName.toLowerCase()

  if (DROP_WITH_CONTENT.has(tag)) {
    removedTags.push(tag)
    return null
  }
  if (!ALLOWED_TAGS.has(tag)) {
    removedTags.push(tag)
    const frag = document.createDocumentFragment()
    el.childNodes.forEach((child) => {
      const cleaned = cleanNode(child, removedTags, removedAttrs)
      if (cleaned) frag.appendChild(cleaned)
    })
    return frag
  }

  const out = document.createElement(tag)
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    if (!ALLOWED_ATTRS.has(name)) {
      removedAttrs.push(name)
      continue
    }
    if (name === 'href' && !safeHref(attr.value)) {
      removedAttrs.push('href(危险协议)')
      continue
    }
    if (name === 'src' && !safeSrc(attr.value)) {
      removedAttrs.push('src(危险协议)')
      continue
    }
    out.setAttribute(name, attr.value)
  }
  el.childNodes.forEach((child) => {
    const cleaned = cleanNode(child, removedTags, removedAttrs)
    if (cleaned) out.appendChild(cleaned)
  })
  return out
}

export type SanitizeResult = {
  /** 可直接插入 contenteditable 的 HTML */
  html: string
  /** 可直接写回 XHTML 的合法片段 */
  xml: string
  removedTags: string[]
  removedAttrs: string[]
}

/**
 * 白名单过滤 + XML 合法性校验。
 * XML 不合法时抛错，调用方应中止写回并提示用户。
 */
export function sanitizeInline(input: string): SanitizeResult {
  const removedTags: string[] = []
  const removedAttrs: string[] = []

  const htmlDoc = document.implementation.createHTMLDocument('')
  const src = htmlDoc.createElement('div')
  src.innerHTML = input

  const out = htmlDoc.createElement('div')
  src.childNodes.forEach((child) => {
    const cleaned = cleanNode(child, removedTags, removedAttrs)
    if (cleaned) out.appendChild(cleaned)
  })

  // HTML 序列化会把不换行空格写成 &nbsp;，XML 不认这个实体；
  // 直接用 XMLSerializer 序列化节点树：空元素自闭合、&nbsp; 输出为字符本身。
  const html = out.innerHTML
  const serialized = new XMLSerializer().serializeToString(out)
  const startTag = /^<div\b[^>]*>/.exec(serialized)?.[0] ?? ''
  const xml = startTag ? serialized.slice(startTag.length).replace(/<\/div>$/, '') : ''
  const xdoc = new DOMParser().parseFromString(
    `<div xmlns="http://www.w3.org/1999/xhtml">${xml}</div>`,
    'application/xhtml+xml',
  )
  const parserError = xdoc.querySelector('parsererror')
  if (parserError) {
    throw new Error(parserError.textContent?.replace(/\s+/g, ' ').trim() || 'XML 不合法')
  }

  return { html, xml, removedTags, removedAttrs }
}

/**
 * contenteditable 回车会生成 <div>/<p>；Word 粘贴也带整段标签。
 * 白名单里没有块标签，先把块边界统一换成换行，避免文字被粘成一行。
 */
export function normalizeBlockBreaks(html: string): string {
  return html
    .replace(/<\/\s*(?:div|p|h[1-6]|li|blockquote|tr|section|article)\s*>/gi, '<br/>')
    .replace(/<\s*(?:div|p|h[1-6]|li|blockquote|tr|section|article)\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>\s*<br\s*\/?>/gi, '<br/>')
}

/** 纯文本粘贴：转义后按行换成 <br/> */
export function textToInline(text: string): string {
  return text
    .split(/\r\n|\n|\r/)
    .map((line) => line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .join('<br/>')
}
