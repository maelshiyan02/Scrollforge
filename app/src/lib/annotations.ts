/**
 * 阅读标注（高亮 / 笔记）的壳文件存档。
 *
 * 落盘位置：书目录下的 `阅读壳/annotations.json`，与母本同层，随书目录一起搬。
 * 文件名固定，不随书名变化；schemaVersion / bookId / sourceFingerprint 由后端写入。
 * 锚点模型见计划 04 §10.5：CFI 负责画线，blockIndex + textHash 负责判活与降级。
 */

import { invoke } from '@tauri-apps/api/core'

export type AnchorState = 'ok' | 'partial' | 'orphan'

export type AnnotationAnchor = {
  /** 章节文件（相对包内路径），用于跨章定位 */
  href: string
  /** 顶层段落块序号；-1 表示旧数据尚未定位 */
  blockIndex: number
  /** 段落原文归一化 hash */
  textHash: string
  /** 段落原文快照，用于改写后重算 */
  blockText: string
  /** 字符级标注：相对 blockText 的区间 */
  range?: { start: number; end: number }
  state: AnchorState
}

export type Annotation = {
  /** EPUB CFI，定位高亮范围（foliate 画线只认这个） */
  value: string
  /** 高亮颜色；只有笔记时为空，改用下划线绘制 */
  color?: string
  note?: string
  /** 用户拖动小字后的位置偏移（相对原文句首），下次打开书沿用 */
  noteOffset?: { x: number; y: number }
  /** 章节索引，换节渲染时用于快速筛选 */
  index: number
  /** 选中的原文，列表与提示用 */
  text: string
  createdAt: number
  updatedAt?: number
  /** 段落级锚点；旧数据迁移前可能缺省 */
  anchor?: AnnotationAnchor
}

export const HIGHLIGHT_COLORS = [
  { name: '黄色高亮', value: '#f2cf66' },
  { name: '橙色高亮', value: '#f2b366' },
  { name: '绿色高亮', value: '#a9d6a0' },
  { name: '蓝色高亮', value: '#9cc7e8' },
  { name: '紫色高亮', value: '#bfa6e8' },
  { name: '粉色高亮', value: '#f0a6c8' },
] as const

const PREFIX = 'scrollforge:annotations:'
const SCHEMA = 1

/** 段落文本归一化：与编辑器段落视图同一口径 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** FNV-1a 32：只用来判「段落是否还是那段」，不做安全用途 */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 归一化文本 + 原始下标 → 归一化下标映射，供选区换算与编辑器高亮定位 */
export function normalizedWithMap(raw: string): { text: string; map: number[] } {
  let out = ''
  const map: number[] = new Array(raw.length + 1)
  let lastSpace = false
  for (let i = 0; i < raw.length; i += 1) {
    map[i] = out.length
    const ch = raw[i]
    if (/\s/.test(ch)) {
      if (out && !lastSpace) {
        out += ' '
        lastSpace = true
      }
    } else {
      out += ch
      lastSpace = false
    }
  }
  map[raw.length] = out.length
  const text = out.endsWith(' ') ? out.slice(0, -1) : out
  return { text, map }
}

/**
 * 把选区换算成「所属块的归一化文本 + 块内字符区间」。
 * 块由 blockElements 给出，与编辑器段落序号同一口径。
 */
export function anchorRange(
  el: Element,
  range: Range,
): { text: string; range: { start: number; end: number } } {
  const raw = el.textContent ?? ''
  const { text, map } = normalizedWithMap(raw)
  const doc = el.ownerDocument
  const prefixLen = (node: Node, offset: number) => {
    try {
      const probe = doc.createRange()
      probe.setStart(el, 0)
      probe.setEnd(node, offset)
      return Math.min(raw.length, probe.toString().length)
    } catch {
      return 0
    }
  }
  const rawStart = prefixLen(range.startContainer, range.startOffset)
  const rawEnd = prefixLen(range.endContainer, range.endOffset)
  const start = Math.min(text.length, map[rawStart] ?? 0)
  const end = Math.min(text.length, Math.max(start, map[rawEnd] ?? start))
  return { text, range: { start, end } }
}

function isAnnotation(item: unknown): item is Annotation {
  if (!item || typeof item !== 'object') return false
  const value = item as Partial<Annotation>
  return typeof value.value === 'string' && value.value.length > 0 && typeof value.index === 'number'
}

function normalizeAnchor(raw: unknown): AnnotationAnchor | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const item = raw as Partial<AnnotationAnchor>
  if (typeof item.blockIndex !== 'number') return undefined
  const state: AnchorState =
    item.state === 'partial' || item.state === 'orphan' ? item.state : 'ok'
  return {
    href: typeof item.href === 'string' ? item.href : '',
    blockIndex: item.blockIndex,
    textHash: typeof item.textHash === 'string' ? item.textHash : '',
    blockText: typeof item.blockText === 'string' ? item.blockText : '',
    range:
      item.range && typeof item.range.start === 'number' && typeof item.range.end === 'number'
        ? { start: item.range.start, end: item.range.end }
        : undefined,
    state,
  }
}

function normalizeAnnotation(item: Annotation): Annotation {
  return {
    ...item,
    anchor: normalizeAnchor(item.anchor),
    noteOffset:
      item.noteOffset && typeof item.noteOffset.x === 'number'
        ? { x: item.noteOffset.x, y: item.noteOffset.y }
        : undefined,
  }
}

/** 读取本书标注；existed 表示壳文件是否已经存在（用于判断要不要迁移旧数据） */
export async function loadBookAnnotations(
  bookId: string,
): Promise<{ list: Annotation[]; existed: boolean }> {
  const raw = await invoke<string>('read_sidecar', { id: bookId, name: 'annotations' })
  // 外部工具（如 PowerShell）写回的 UTF-8 可能带 BOM，直接 parse 会失败
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.trim()) return { list: [], existed: false }
  try {
    const parsed = JSON.parse(text) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { annotations?: unknown })?.annotations)
        ? (parsed as { annotations: unknown[] }).annotations
        : []
    return { list: list.filter(isAnnotation).map(normalizeAnnotation), existed: true }
  } catch {
    return { list: [], existed: true }
  }
}

export async function saveBookAnnotations(bookId: string, list: Annotation[]): Promise<void> {
  await invoke('write_sidecar', {
    id: bookId,
    name: 'annotations',
    json: JSON.stringify({ schemaVersion: SCHEMA, annotations: list }),
  })
}

/** 旧版 localStorage 标注（只有 CFI + 文本），仅在首次升级时读取一次 */
export function readLegacyAnnotations(key: string): Annotation[] {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isAnnotation).map(normalizeAnnotation)
  } catch {
    return []
  }
}

export function clearLegacyAnnotations(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    // 清不掉也不影响主流程
  }
}
