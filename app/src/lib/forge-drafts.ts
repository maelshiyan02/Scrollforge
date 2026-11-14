import { invoke } from '@tauri-apps/api/core'

/** 锻造译文草稿：与原文结构一一对应的占位文件。target 为空占位，source 只读不改。 */

export type ForgeBlockKind = 'heading' | 'paragraph' | 'blank'

export type ForgeBlockDraft = {
  index: number
  kind: ForgeBlockKind
  source: string
  target: string
  /** 母本这一段被改写过：译文保留，但需要重新对校；重新输入译文后自动清除 */
  stale?: boolean
}

export type ForgeChapterDraft = {
  chapterIndex: number
  title: string
  blocks: ForgeBlockDraft[]
}

/** 重新对齐时被删掉、但译文/注释仍在的段落，保留在草稿孤儿区备查 */
export type ForgeOrphanBlock = {
  chapterIndex: number
  oldIndex: number
  source: string
  target: string
  note?: string
}

export type ForgeDraftDoc = {
  version: 1
  chapters: ForgeChapterDraft[]
  orphans?: ForgeOrphanBlock[]
}

const cache = new Map<string, ForgeDraftDoc>()
const timers = new Map<string, number>()

export function forgeBlockKind(text: string): ForgeBlockKind {
  if (!text.trim()) return 'blank'
  return looksLikeHeading(text) ? 'heading' : 'paragraph'
}

function looksLikeHeading(text: string): boolean {
  const value = text.trim()
  if (!value) return false
  if (/^第[0-9一二三四五六七八九十百千零〇两]+[章节卷篇回部]/.test(value)) return true
  if (value.length <= 24 && !/[。！？.!?…]/.test(value)) return true
  return false
}

/** 用阅读器分析结果生成镜像草稿：每段一条，target 统一为空占位 */
export function buildForgeDraft(
  chapters: { title?: string; paragraphs: string[] }[],
): ForgeDraftDoc {
  return {
    version: 1,
    chapters: chapters.map((chapter, chapterIndex) => ({
      chapterIndex,
      title: chapter.title ?? '',
      blocks: chapter.paragraphs.map((text, index) => ({
        index,
        kind: forgeBlockKind(text),
        source: text,
        target: '',
      })),
    })),
  }
}

export function cacheForgeDraft(bookId: string, doc: ForgeDraftDoc) {
  cache.set(bookId, doc)
}

export function cachedForgeDraft(bookId: string): ForgeDraftDoc | null {
  return cache.get(bookId) ?? null
}

export async function loadForgeDraft(bookId: string): Promise<ForgeDraftDoc | null> {
  if (cache.has(bookId)) return cache.get(bookId) ?? null
  try {
    const raw = await invoke<string>('read_forge_draft', { id: bookId })
    if (!raw) return null
    const parsed = JSON.parse(raw) as ForgeDraftDoc
    if (!parsed || !Array.isArray(parsed.chapters)) return null
    cache.set(bookId, parsed)
    return parsed
  } catch {
    return null
  }
}

function schedule(bookId: string) {
  const doc = cache.get(bookId)
  if (!doc) return
  const prev = timers.get(bookId)
  if (prev) window.clearTimeout(prev)
  const timer = window.setTimeout(() => {
    timers.delete(bookId)
    void invoke('write_forge_draft', { id: bookId, json: JSON.stringify(doc) }).catch(() => null)
  }, 400)
  timers.set(bookId, timer)
}

export function setForgeTarget(
  bookId: string,
  chapterIndex: number,
  paragraphIndex: number,
  target: string,
): ForgeDraftDoc | null {
  let doc = cache.get(bookId)
  if (!doc) return null
  const chapter = doc.chapters.find((item) => item.chapterIndex === chapterIndex)
  const block = chapter?.blocks.find((item) => item.index === paragraphIndex)
  if (!block) return doc
  const stale = block.stale === true
  if (block.target === target && !stale) return doc
  block.target = target
  // 重新输入/翻译过译文，视为已对校过新原文
  if (stale) delete block.stale
  schedule(bookId)
  return doc
}

export function forgeTargetOf(
  bookId: string,
  chapterIndex: number,
  paragraphIndex: number,
): string {
  const doc = cache.get(bookId)
  const chapter = doc?.chapters.find((item) => item.chapterIndex === chapterIndex)
  return chapter?.blocks.find((item) => item.index === paragraphIndex)?.target ?? ''
}

export function flushForgeDraft(bookId: string) {
  const timer = timers.get(bookId)
  if (timer) window.clearTimeout(timer)
  timers.delete(bookId)
  const doc = cache.get(bookId)
  if (doc) void invoke('write_forge_draft', { id: bookId, json: JSON.stringify(doc) }).catch(() => null)
}
