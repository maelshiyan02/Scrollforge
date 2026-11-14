/**
 * 编辑档富文本视图里的阅读标注渲染（只读）。
 *
 * 数据来自书目录 `阅读壳/annotations.json`，这里只负责把「章节 + 块序号 + 归一化区间」
 * 还原成 DOM Range，并用 CSS Custom Highlight API 画出来：
 * - 不改 contentEditable 的 DOM，所以高亮不会被写回章节 XHTML；
 * - 源码视图天然没有标注；
 * - 正文被删改后 Range 收缩或 hash 不匹配，标注自动消失（阅读端会标 partial/orphan）。
 */

import { hashText, normalizedWithMap, type Annotation } from './annotations'

export type ChapterMark = { range: Range; color?: string }

/** 字符在 DOM 里的位置（逐个文本节点累加，跳过图片/图形占位符） */
type CharPos = { node: Text; offset: number }

const PREFIX = 'sf-ann-'
const STYLE_ID = 'sf-ann-highlight-style'
const DEFAULT_COLOR = '#f2cf66'
/** 笔记（没有高亮色）用下划线表示 */
const NOTE_RULE =
  '::highlight(sf-ann-note) { background-color: transparent; text-decoration: underline; ' +
  'text-decoration-color: #c4553b; text-decoration-thickness: 2px; text-underline-offset: 3px; }'

type HighlightRegistryLike = {
  keys(): Iterable<string>
  set(name: string, highlight: unknown): void
  delete(name: string): void
}
type HighlightCtor = new (...ranges: Range[]) => unknown

function highlightRegistry(): HighlightRegistryLike | null {
  const css = CSS as unknown as { highlights?: HighlightRegistryLike }
  return css?.highlights ?? null
}

function highlightCtor(): HighlightCtor | null {
  const ctor = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight
  return typeof ctor === 'function' ? ctor : null
}

function isHexColor(color: string): boolean {
  return /^#[0-9a-f]{3,8}$/i.test(color)
}

/** anchor.href 是包内相对路径，currentFile.relPath 是 zip 内完整路径，按后缀对齐 */
export function sameChapterHref(href: string, relPath: string): boolean {
  if (!href || !relPath) return false
  const clean = (value: string) => {
    let out = value.split('#')[0].replace(/\\/g, '/').toLowerCase()
    try {
      out = decodeURIComponent(out)
    } catch {
      // 非法转义保持原样
    }
    return out
  }
  const a = clean(href)
  const b = clean(relPath)
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/** 收集块内可见字符；图片占位符不参与定位，否则区间会整体偏移 */
function collectChars(root: Element): { raw: string; chars: CharPos[] } {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const chars: CharPos[] = []
  let raw = ''
  let node = walker.nextNode() as Text | null
  while (node) {
    if (!node.parentElement?.classList.contains('blk-img')) {
      const data = node.data
      for (let i = 0; i < data.length; i += 1) {
        chars.push({ node, offset: i })
        raw += data[i]
      }
    }
    node = walker.nextNode() as Text | null
  }
  return { raw, chars }
}

/** 归一化下标 → 原始下标（归一化折叠空白，一个原始位置可能对应多个归一化位置） */
function rawIndexOf(map: number[], norm: number, rawLen: number): number {
  for (let i = 0; i < rawLen; i += 1) {
    if (map[i] >= norm) return i
  }
  return rawLen
}

function buildRange(
  chars: CharPos[],
  rawLen: number,
  textLen: number,
  map: number[],
  range: { start: number; end: number },
): Range | null {
  if (!chars.length) return null
  const start = Math.max(0, Math.min(range.start, textLen))
  const end = Math.max(start, Math.min(range.end, textLen))
  if (end <= start) return null
  const rawStart = rawIndexOf(map, start, rawLen)
  const rawEnd = rawIndexOf(map, end, rawLen)
  if (rawEnd <= rawStart) return null
  const doc = chars[0].node.ownerDocument
  if (!doc) return null
  const out = doc.createRange()
  const s = chars[Math.min(rawStart, chars.length - 1)]
  out.setStart(s.node, s.offset)
  if (rawEnd >= chars.length) {
    const last = chars[chars.length - 1]
    out.setEnd(last.node, last.offset + 1)
  } else {
    const e = chars[rawEnd]
    out.setEnd(e.node, e.offset)
  }
  return out
}

/** 当前章节可渲染的标注：块还在、文本 hash 一致才画，否则交给阅读端标 partial/orphan */
export function collectChapterMarks(
  container: HTMLElement,
  annotations: Annotation[],
  relPath: string,
): ChapterMark[] {
  if (!annotations.length) return []
  const byBlock = new Map<number, Annotation[]>()
  for (const annotation of annotations) {
    const anchor = annotation.anchor
    if (!anchor || anchor.state === 'orphan' || !anchor.range) continue
    if (!sameChapterHref(anchor.href, relPath)) continue
    const list = byBlock.get(anchor.blockIndex)
    if (list) list.push(annotation)
    else byBlock.set(anchor.blockIndex, [annotation])
  }
  if (!byBlock.size) return []
  const marks: ChapterMark[] = []
  for (const [index, list] of byBlock) {
    const body = container.querySelector<HTMLElement>(
      `.blk[data-blk-index="${index}"] .blk-body`,
    )
    if (!body) continue
    const { raw, chars } = collectChars(body)
    if (!raw || !chars.length) continue
    const { text, map } = normalizedWithMap(raw)
    for (const annotation of list) {
      const anchor = annotation.anchor
      if (!anchor?.range) continue
      if (hashText(text) !== anchor.textHash) continue
      const range = buildRange(chars, raw.length, text.length, map, anchor.range)
      if (range) marks.push({ range, color: annotation.color })
    }
  }
  return marks
}

function ensureStyle(rules: string[]): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.appendChild(style)
  }
  style.textContent = rules.join('\n')
}

/** 清掉本模块注册的所有高亮（换章、切源码视图、卸载时调用） */
export function clearChapterMarks(): void {
  const registry = highlightRegistry()
  if (!registry) return
  for (const key of Array.from(registry.keys())) {
    if (key.startsWith(PREFIX)) registry.delete(key)
  }
  const style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (style) style.textContent = ''
}

export function applyChapterMarks(marks: ChapterMark[]): void {
  const registry = highlightRegistry()
  const Ctor = highlightCtor()
  if (!registry || !Ctor) return
  clearChapterMarks()
  if (!marks.length) {
    ensureStyle([])
    return
  }
  const groups = new Map<string, { color?: string; ranges: Range[] }>()
  for (const mark of marks) {
    const key = mark.color && isHexColor(mark.color) ? mark.color.slice(1).toLowerCase() : 'note'
    const group = groups.get(key)
    if (group) group.ranges.push(mark.range)
    else groups.set(key, { color: mark.color, ranges: [mark.range] })
  }
  const rules: string[] = []
  for (const [key, group] of groups) {
    const name = PREFIX + key
    registry.set(name, new Ctor(...group.ranges))
    if (group.color && isHexColor(group.color) && key !== 'note') {
      rules.push(`::highlight(${name}) { background-color: ${group.color}; }`)
    } else {
      rules.push(NOTE_RULE)
    }
  }
  ensureStyle(rules)
}
