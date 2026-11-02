/**
 * 阅读进度与书架偏好的本地存档。
 * 用户明确要求 Phase 1 继续用 localStorage，暂不接 SQLite。
 */

export type SavedProgress = {
  cfi: string
  fraction: number
  at: number
}

const PROGRESS_PREFIX = 'scrollforge:progress:'

export function progressKeyOf(
  source: { kind: 'library'; meta: { id: string } } | { kind: 'file'; name: string },
): string {
  return source.kind === 'library' ? `lib:${source.meta.id}` : `file:${source.name}`
}

export function readProgress(key: string): SavedProgress | null {
  try {
    const raw = localStorage.getItem(PROGRESS_PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SavedProgress
    if (!parsed?.cfi) return null
    return parsed
  } catch {
    return null
  }
}

export function writeProgress(key: string, cfi: string, fraction: number): void {
  try {
    localStorage.setItem(
      PROGRESS_PREFIX + key,
      JSON.stringify({ cfi, fraction, at: Date.now() } satisfies SavedProgress),
    )
  } catch {
    // 存档失败不打断阅读
  }
}

export function clearProgress(key: string): void {
  try {
    localStorage.removeItem(PROGRESS_PREFIX + key)
  } catch {
    // 忽略
  }
}

export function progressPercent(bookId: string): number {
  const saved = readProgress(`lib:${bookId}`)
  return saved && Number.isFinite(saved.fraction) ? Math.round(saved.fraction * 100) : 0
}

export function lastReadAt(bookId: string): number {
  return readProgress(`lib:${bookId}`)?.at ?? 0
}
