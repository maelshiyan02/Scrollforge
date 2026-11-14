import { editKey, myers, type ForgeEdit, type ForgeEdits } from './forge'
import {
  forgeBlockKind,
  type ForgeBlockDraft,
  type ForgeChapterDraft,
  type ForgeDraftDoc,
  type ForgeOrphanBlock,
} from './forge-drafts'

/**
 * 母本被编辑后的译本重新对齐。
 *
 * 以译文草稿里记录的旧原文为基准，和当前母本段落做序列比对：
 * - same：原文未变，译文原样跟随（可能换了位置）
 * - modified：原文被改写，译文保留但标记 `stale`，提示对校
 * - added：新增段落，没有译文
 * - removed：被删段落，译文可选择移入草稿孤儿区
 *
 * 只生成计划，不写任何文件；母本一个字节都不动。
 */

export type RealignStatus = 'same' | 'modified' | 'added' | 'removed'

export type RealignCounts = Record<RealignStatus, number>

export type RealignRow = {
  status: RealignStatus
  oldIndex: number | null
  newIndex: number | null
  oldSource: string
  newSource: string
  target: string
  note: string
  similarity: number
}

export type RealignChapterPlan = {
  chapterIndex: number
  title: string
  oldChapterIndex: number | null
  rows: RealignRow[]
  counts: RealignCounts
  moved: number
}

export type RealignPlan = {
  chapters: RealignChapterPlan[]
  counts: RealignCounts
  moved: number
  orphanCount: number
  /** 需要改动的段数（非 same + 位移） */
  changed: number
}

type PlanArgs = {
  mirror: ForgeDraftDoc
  chapters: { title?: string; paragraphs: string[] }[]
  edits: ForgeEdits
}

const MODIFIED_THRESHOLD = 0.4

function emptyCounts(): RealignCounts {
  return { same: 0, modified: 0, added: 0, removed: 0 }
}

function hasRowEdit(target: string, note: string): boolean {
  return Boolean(target.trim() || note.trim())
}

/** 短文本用编辑距离，长文本用字符二元组 Dice，避免 O(n²) 拖慢整章比对 */
function similarity(a: string, b: string): number {
  const x = a.trim()
  const y = b.trim()
  if (x === y) return 1
  if (!x || !y) return 0
  const longest = Math.max(x.length, y.length)
  if (longest <= 300) {
    return 1 - levenshtein(x, y) / longest
  }
  return diceBigrams(x.slice(0, 4000), y.slice(0, 4000))
}

function levenshtein(a: string, b: string): number {
  const n = a.length
  const m = b.length
  let prev = new Array<number>(m + 1)
  let next = new Array<number>(m + 1)
  for (let j = 0; j <= m; j += 1) prev[j] = j
  for (let i = 1; i <= n; i += 1) {
    next[0] = i
    for (let j = 1; j <= m; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      next[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      )
    }
    const swap = prev
    prev = next
    next = swap
  }
  return prev[m] ?? 0
}

function diceBigrams(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0
  const grams = new Map<string, number>()
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  let overlap = 0
  let totalB = 0
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2)
    const left = grams.get(gram) ?? 0
    if (left > 0) {
      grams.set(gram, left - 1)
      overlap += 1
    }
    totalB += 1
  }
  const totalA = a.length - 1
  return (2 * overlap) / (totalA + totalB)
}

/** 差异过大时退化为按下标配对，保证仍然能给出可用映射 */
function fallbackOps(oldTexts: string[], newTexts: string[]): ('same' | 'del' | 'add')[] {
  const ops: ('same' | 'del' | 'add')[] = []
  const shared = Math.min(oldTexts.length, newTexts.length)
  for (let i = 0; i < shared; i += 1) {
    if (oldTexts[i] === newTexts[i]) {
      ops.push('same')
    } else {
      ops.push('del')
      ops.push('add')
    }
  }
  for (let i = shared; i < oldTexts.length; i += 1) ops.push('del')
  for (let i = shared; i < newTexts.length; i += 1) ops.push('add')
  return ops
}

function alignChapter(
  chapterIndex: number,
  title: string,
  oldChapterIndex: number | null,
  oldBlocks: ForgeBlockDraft[],
  newParagraphs: string[],
  edits: ForgeEdits,
): RealignChapterPlan {
  const oldTexts = oldBlocks.map((block) => block.source)
  const ops = myers(oldTexts, newParagraphs) ?? fallbackOps(oldTexts, newParagraphs)
  const rows: RealignRow[] = []
  let oldCursor = 0
  let newCursor = 0
  let pendingOld: number[] = []
  let pendingNew: number[] = []
  /** 行位置 → 草稿里的块序号（正常是连续的，异常时仍按块序号取译文） */
  const oldIndexOf = (position: number) => oldBlocks[position]?.index ?? position

  const editOf = (oldIndex: number): ForgeEdit =>
    oldChapterIndex === null ? {} : edits[editKey(oldChapterIndex, oldIndex)] ?? {}

  const pushRemoved = (position: number) => {
    const oldIndex = oldIndexOf(position)
    const edit = editOf(oldIndex)
    rows.push({
      status: 'removed',
      oldIndex,
      newIndex: null,
      oldSource: oldTexts[position] ?? '',
      newSource: '',
      target: edit.translate ?? '',
      note: edit.note ?? '',
      similarity: 0,
    })
  }

  const pushAdded = (newIndex: number) => {
    rows.push({
      status: 'added',
      oldIndex: null,
      newIndex,
      oldSource: '',
      newSource: newParagraphs[newIndex] ?? '',
      target: '',
      note: '',
      similarity: 0,
    })
  }

  /** 同一段差异块里，旧段与新增段按顺序配对：足够像就算改写，否则一删一增 */
  const flush = () => {
    const pairs = Math.min(pendingOld.length, pendingNew.length)
    for (let i = 0; i < pairs; i += 1) {
      const oldPosition = pendingOld[i]!
      const newIndex = pendingNew[i]!
      const before = oldTexts[oldPosition] ?? ''
      const after = newParagraphs[newIndex] ?? ''
      const score = similarity(before, after)
      if (score >= MODIFIED_THRESHOLD) {
        const oldIndex = oldIndexOf(oldPosition)
        const edit = editOf(oldIndex)
        rows.push({
          status: 'modified',
          oldIndex,
          newIndex,
          oldSource: before,
          newSource: after,
          target: edit.translate ?? '',
          note: edit.note ?? '',
          similarity: score,
        })
      } else {
        pushRemoved(oldPosition)
        pushAdded(newIndex)
      }
    }
    for (let i = pairs; i < pendingOld.length; i += 1) pushRemoved(pendingOld[i]!)
    for (let i = pairs; i < pendingNew.length; i += 1) pushAdded(pendingNew[i]!)
    pendingOld = []
    pendingNew = []
  }

  for (const op of ops) {
    if (op === 'same') {
      flush()
      const oldIndex = oldIndexOf(oldCursor)
      const edit = editOf(oldIndex)
      rows.push({
        status: 'same',
        oldIndex,
        newIndex: newCursor,
        oldSource: oldTexts[oldCursor] ?? '',
        newSource: newParagraphs[newCursor] ?? '',
        target: edit.translate ?? '',
        note: edit.note ?? '',
        similarity: 1,
      })
      oldCursor += 1
      newCursor += 1
    } else if (op === 'del') {
      pendingOld.push(oldCursor)
      oldCursor += 1
    } else {
      pendingNew.push(newCursor)
      newCursor += 1
    }
  }
  flush()

  const counts = emptyCounts()
  let moved = 0
  for (const row of rows) {
    counts[row.status] += 1
    if (
      (row.status === 'same' || row.status === 'modified')
      && row.oldIndex !== null
      && row.newIndex !== null
      && row.oldIndex !== row.newIndex
    ) {
      moved += 1
    }
  }

  return { chapterIndex, title, oldChapterIndex, rows, counts, moved }
}

/** 章节对应：标题一致优先，其次同下标，最后按唯一标题兜底 */
function matchChapter(
  mirror: ForgeDraftDoc,
  chapterIndex: number,
  title: string,
  used: Set<number>,
): ForgeChapterDraft | null {
  const titleKey = title.trim()
  const byIndex = mirror.chapters.find((item) => item.chapterIndex === chapterIndex)
  if (byIndex && !used.has(byIndex.chapterIndex) && byIndex.title.trim() === titleKey) {
    used.add(byIndex.chapterIndex)
    return byIndex
  }
  if (titleKey) {
    const byTitle = mirror.chapters.filter(
      (item) => !used.has(item.chapterIndex) && item.title.trim() === titleKey,
    )
    if (byTitle.length === 1) {
      used.add(byTitle[0]!.chapterIndex)
      return byTitle[0]!
    }
  }
  if (byIndex && !used.has(byIndex.chapterIndex)) {
    used.add(byIndex.chapterIndex)
    return byIndex
  }
  return null
}

/** 生成对齐计划；只读，不落盘 */
export function buildRealignPlan({ mirror, chapters, edits }: PlanArgs): RealignPlan {
  const used = new Set<number>()
  const plans: RealignChapterPlan[] = chapters.map((chapter, chapterIndex) => {
    const title = chapter.title ?? ''
    const oldChapter = matchChapter(mirror, chapterIndex, title, used)
    return alignChapter(
      chapterIndex,
      title,
      oldChapter?.chapterIndex ?? null,
      oldChapter?.blocks ?? [],
      chapter.paragraphs,
      edits,
    )
  })

  const counts = emptyCounts()
  let moved = 0
  let orphanCount = 0
  for (const plan of plans) {
    for (const status of ['same', 'modified', 'added', 'removed'] as RealignStatus[]) {
      counts[status] += plan.counts[status]
    }
    moved += plan.moved
    for (const row of plan.rows) {
      if (row.status === 'removed' && hasRowEdit(row.target, row.note)) orphanCount += 1
    }
  }

  const changed = counts.modified + counts.added + counts.removed + moved
  return { chapters: plans, counts, moved, orphanCount, changed }
}

/** 把计划落成新草稿与新覆盖层；`keepOrphans` 决定被删段落的译文是否留在孤儿区 */
export function finalizeRealign(
  plan: RealignPlan,
  keepOrphans: boolean,
): { doc: ForgeDraftDoc; edits: ForgeEdits } {
  const chapters: ForgeChapterDraft[] = plan.chapters.map((chapter) => {
    const blocks: ForgeBlockDraft[] = chapter.rows
      .filter((row) => row.newIndex !== null)
      .sort((a, b) => (a.newIndex ?? 0) - (b.newIndex ?? 0))
      .map((row) => ({
        index: row.newIndex!,
        kind: forgeBlockKind(row.newSource),
        source: row.newSource,
        target: row.target,
        ...(row.status === 'modified' && hasRowEdit(row.target, row.note) ? { stale: true } : {}),
      }))
    return { chapterIndex: chapter.chapterIndex, title: chapter.title, blocks }
  })

  const edits: ForgeEdits = {}
  const orphans: ForgeOrphanBlock[] = []
  for (const chapter of plan.chapters) {
    for (const row of chapter.rows) {
      if (row.newIndex !== null && hasRowEdit(row.target, row.note)) {
        const edit: ForgeEdit = {}
        if (row.target.trim()) edit.translate = row.target
        if (row.note.trim()) edit.note = row.note
        edits[editKey(chapter.chapterIndex, row.newIndex)] = edit
      }
      if (keepOrphans && row.status === 'removed' && hasRowEdit(row.target, row.note)) {
        orphans.push({
          chapterIndex: chapter.chapterIndex,
          oldIndex: row.oldIndex ?? -1,
          source: row.oldSource,
          target: row.target,
          ...(row.note.trim() ? { note: row.note } : {}),
        })
      }
    }
  }

  return {
    doc: {
      version: 1,
      chapters,
      ...(orphans.length ? { orphans } : {}),
    },
    edits,
  }
}
