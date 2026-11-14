import { invoke } from '@tauri-apps/api/core'

/** 一条划词译文草稿。按 cfi 去重，跟随原书位置。 */
export type TranslateDraft = {
  cfi: string
  text: string
  translation: string
  index: number
  /** 原文所在顶层段落块序号（与编辑器 blockElements 同口径） */
  block?: number
  /** 原文所在章节文件（相对 OPF 或包内路径），编辑器据此匹配 */
  relPath?: string
  /** 生成草稿时该段的纯文本，用于判断草稿是否仍适用于当前段落 */
  blockText?: string
  /** 用户拖动译文浮条后的偏移 */
  offset?: { x: number; y: number }
  updatedAt: number
}

export type TranslateDraftTable = Record<string, TranslateDraft>

type Listener = (drafts: TranslateDraftTable) => void

const cached = new Map<string, TranslateDraftTable>()
const pending = new Set<string>()
const listeners = new Map<string, Set<Listener>>()
const timers = new Map<string, number>()

/** 路径比较：统一分隔符与小写，允许「相对 OPF」和「包内全路径」互为后缀 */
export function samePath(a?: string, b?: string): boolean {
  if (!a || !b) return false
  const x = a.split('#')[0].replace(/\\/g, '/').toLowerCase()
  const y = b.split('#')[0].replace(/\\/g, '/').toLowerCase()
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

function normalizeTable(raw: unknown): TranslateDraftTable {
  if (!raw || typeof raw !== 'object') return {}
  const table: TranslateDraftTable = {}
  for (const [cfi, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const item = value as Partial<TranslateDraft>
    if (typeof item.translation !== 'string') continue
    table[cfi] = {
      cfi: typeof item.cfi === 'string' ? item.cfi : cfi,
      text: typeof item.text === 'string' ? item.text : '',
      translation: item.translation,
      index: typeof item.index === 'number' ? item.index : 0,
      block: typeof item.block === 'number' ? item.block : undefined,
      relPath: typeof item.relPath === 'string' ? item.relPath : undefined,
      blockText: typeof item.blockText === 'string' ? item.blockText : undefined,
      offset: item.offset && typeof item.offset === 'object' ? item.offset : undefined,
      updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
    }
  }
  return table
}

function emit(bookId: string) {
  const drafts = cached.get(bookId) ?? {}
  listeners.get(bookId)?.forEach((fn) => {
    try { fn(drafts) } catch { /* 单个订阅异常不影响其它订阅 */ }
  })
}

/** 读取书级草稿（进程内缓存，一次读取多次使用） */
export async function loadBookDrafts(bookId: string): Promise<TranslateDraftTable> {
  const hit = cached.get(bookId)
  if (hit) return hit
  let table: TranslateDraftTable = {}
  try {
    const raw = await invoke<string>('read_sidecar', { id: bookId, name: 'translate-drafts' })
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as unknown
      const payload = parsed && typeof parsed === 'object' && 'drafts' in parsed
        ? (parsed as { drafts: unknown }).drafts
        : parsed
      table = normalizeTable(payload)
    }
  } catch (err) {
    console.warn('读取译文草稿失败', err)
  }
  const concurrent = cached.get(bookId)
  if (concurrent) return concurrent
  cached.set(bookId, table)
  return table
}

/** 同步取已加载的草稿表（未加载过返回 null） */
export function draftsOf(bookId: string): TranslateDraftTable | null {
  return cached.get(bookId) ?? null
}

export function subscribeDrafts(bookId: string, fn: Listener): () => void {
  const set = listeners.get(bookId) ?? new Set<Listener>()
  set.add(fn)
  listeners.set(bookId, set)
  return () => {
    set.delete(fn)
    if (!set.size) listeners.delete(bookId)
  }
}

function schedulePersist(bookId: string) {
  if (timers.has(bookId)) return
  const timer = window.setTimeout(() => {
    timers.delete(bookId)
    void flushDrafts(bookId)
  }, 300)
  timers.set(bookId, timer)
}

export async function flushDrafts(bookId: string): Promise<void> {
  if (!pending.has(bookId)) return
  pending.delete(bookId)
  const drafts = cached.get(bookId) ?? {}
  try {
    await invoke('write_sidecar', {
      id: bookId,
      name: 'translate-drafts',
      json: JSON.stringify({ version: 1, drafts }),
    })
  } catch (err) {
    console.warn('保存译文草稿失败', err)
    pending.add(bookId)
  }
}

export function upsertDraft(bookId: string, draft: Omit<TranslateDraft, 'updatedAt'>) {
  const table = cached.get(bookId)
    ? { ...(cached.get(bookId) as TranslateDraftTable) }
    : {}
  table[draft.cfi] = { ...draft, updatedAt: Date.now() }
  cached.set(bookId, table)
  pending.add(bookId)
  emit(bookId)
  schedulePersist(bookId)
}

export function updateDraftOffset(bookId: string, cfi: string, offset: { x: number; y: number }) {
  const table = cached.get(bookId)
  const draft = table?.[cfi]
  if (!table || !draft) return
  cached.set(bookId, { ...table, [cfi]: { ...draft, offset, updatedAt: Date.now() } })
  pending.add(bookId)
  emit(bookId)
  schedulePersist(bookId)
}

/** 整表替换：撤销/重做时把草稿恢复到操作前后的快照 */
export function replaceDrafts(bookId: string, table: TranslateDraftTable) {
  cached.set(bookId, table)
  pending.add(bookId)
  emit(bookId)
  schedulePersist(bookId)
}

export function removeDraft(bookId: string, cfi: string) {
  const table = cached.get(bookId)
  if (!table || !table[cfi]) return
  const next = { ...table }
  delete next[cfi]
  cached.set(bookId, next)
  pending.add(bookId)
  emit(bookId)
  schedulePersist(bookId)
}

/** 编辑器保存成功、译文已写进书里：清掉这个文件对应的草稿 */
export function clearDraftsForFile(bookId: string, relPath: string) {
  const table = cached.get(bookId)
  if (!table) return
  let changed = false
  const next = { ...table }
  for (const [cfi, draft] of Object.entries(next)) {
    if (samePath(draft.relPath, relPath)) {
      delete next[cfi]
      changed = true
    }
  }
  if (!changed) return
  cached.set(bookId, next)
  pending.add(bookId)
  emit(bookId)
  schedulePersist(bookId)
}
