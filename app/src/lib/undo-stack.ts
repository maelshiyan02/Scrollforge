/**
 * 通用撤销栈（阅读档）。
 *
 * 设计要点：
 * - 按 kind + target 记录操作前后的完整快照（标注列表 / 译文草稿表），
 *   这样删除、改写、撤销后重做都能原样还原，不依赖逐字段 diff。
 * - 内存深度可配（默认 40），落盘只保留最近 N 步（默认 20），写进
 *   书目录 `阅读壳/history.json`，重启应用后仍能撤销。
 * - 可选合并窗口：同一 target 在窗口内的连续变更合并成一步（当前阅读层
 *   不合并，保证「连续改译文可逐步回退」；锻造层可按需打开）。
 */

import { invoke } from '@tauri-apps/api/core'

export type UndoKind = 'annotations' | 'drafts'

export type UndoRecord = {
  id: string
  kind: UndoKind
  /** 目标 key：标注/草稿的 cfi；整表操作可用 'book' */
  target: string
  /** 中文动作名，撤销/重做提示用 */
  label: string
  at: number
  /** 操作前快照 */
  before: unknown
  /** 操作后快照 */
  after: unknown
}

export type UndoPushInput = {
  kind: UndoKind
  target: string
  label: string
  before: unknown
  after: unknown
  /** 允许同 target 在合并窗口内合并成一步 */
  merge?: boolean
}

export type UndoStackOptions = {
  /** 书 id：有值才落盘到 `阅读壳/history.json` */
  bookId?: string
  /** 内存中最多保留多少步 */
  depth?: number
  /** 落盘保留多少步 */
  persistDepth?: number
  /** 同 target 合并窗口（毫秒），0 表示不合并 */
  mergeWindow?: number
}

export type UndoStack = {
  push: (input: UndoPushInput) => UndoRecord
  undo: () => UndoRecord | null
  redo: () => UndoRecord | null
  canUndo: () => boolean
  canRedo: () => boolean
  /** 已加载的历史步数（判断「重启后仍可撤销」） */
  size: () => number
  load: () => Promise<void>
  /** 立即把待写历史刷到盘 */
  flush: () => Promise<void>
  dispose: () => void
}

const HISTORY_FILE = 'history'
const HISTORY_VERSION = 1
const DEFAULT_DEPTH = 40
const DEFAULT_PERSIST_DEPTH = 20

let seq = 0

function isRecord(raw: unknown): raw is UndoRecord {
  if (!raw || typeof raw !== 'object') return false
  const item = raw as Partial<UndoRecord>
  return (
    typeof item.id === 'string' &&
    (item.kind === 'annotations' || item.kind === 'drafts') &&
    typeof item.target === 'string' &&
    typeof item.label === 'string' &&
    typeof item.at === 'number' &&
    'before' in item &&
    'after' in item
  )
}

export function createUndoStack(options: UndoStackOptions = {}): UndoStack {
  const bookId = options.bookId
  const depth = Math.max(1, options.depth ?? DEFAULT_DEPTH)
  const persistDepth = Math.max(1, options.persistDepth ?? DEFAULT_PERSIST_DEPTH)
  const mergeWindow = Math.max(0, options.mergeWindow ?? 0)

  let undoList: UndoRecord[] = []
  let redoList: UndoRecord[] = []
  let loaded = false
  let disposed = false
  let timer: number | undefined

  const persistNow = async () => {
    if (!bookId || disposed) return
    const entries = undoList.slice(-persistDepth)
    try {
      await invoke('write_sidecar', {
        id: bookId,
        name: HISTORY_FILE,
        json: JSON.stringify({ version: HISTORY_VERSION, entries, updatedAt: Date.now() }),
      })
    } catch (err) {
      console.warn('保存撤销历史失败', err)
    }
  }

  const schedulePersist = () => {
    if (!bookId || disposed) return
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      void persistNow()
    }, 250)
  }

  const trim = (list: UndoRecord[]) => {
    if (list.length > depth) list.splice(0, list.length - depth)
  }

  const push = (input: UndoPushInput): UndoRecord => {
    const at = Date.now()
    const last = undoList[undoList.length - 1]
    if (
      input.merge &&
      mergeWindow > 0 &&
      last &&
      last.kind === input.kind &&
      last.target === input.target &&
      at - last.at <= mergeWindow
    ) {
      last.after = input.after
      last.label = input.label
      last.at = at
      redoList = []
      schedulePersist()
      return last
    }
    seq += 1
    const record: UndoRecord = {
      id: `${at.toString(36)}-${seq.toString(36)}`,
      kind: input.kind,
      target: input.target,
      label: input.label,
      at,
      before: input.before,
      after: input.after,
    }
    undoList.push(record)
    trim(undoList)
    redoList = []
    schedulePersist()
    return record
  }

  const undo = (): UndoRecord | null => {
    const record = undoList.pop()
    if (!record) return null
    redoList.push(record)
    trim(redoList)
    schedulePersist()
    return record
  }

  const redo = (): UndoRecord | null => {
    const record = redoList.pop()
    if (!record) return null
    undoList.push(record)
    trim(undoList)
    schedulePersist()
    return record
  }

  const load = async () => {
    if (loaded || !bookId) return
    loaded = true
    try {
      const raw = await invoke<string>('read_sidecar', { id: bookId, name: HISTORY_FILE })
      // PowerShell 等外部工具写回的 UTF-8 可能带 BOM
      const text = raw.replace(/^\uFEFF/, '')
      if (!text.trim()) return
      const parsed = JSON.parse(text) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { entries?: unknown })?.entries)
          ? ((parsed as { entries: unknown[] }).entries)
          : []
      undoList = list.filter(isRecord).slice(-persistDepth)
      redoList = []
    } catch (err) {
      console.warn('读取撤销历史失败', err)
    }
  }

  const flush = async () => {
    if (timer !== undefined) {
      window.clearTimeout(timer)
      timer = undefined
    }
    await persistNow()
  }

  return {
    push,
    undo,
    redo,
    canUndo: () => undoList.length > 0,
    canRedo: () => redoList.length > 0,
    size: () => undoList.length,
    load,
    flush,
    dispose: () => {
      disposed = true
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
