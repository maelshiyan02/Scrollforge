/**
 * 锻造层的数据模型与文本工具。
 *
 * - 译文：S10 起写入独立译文工程（`译文/<语言>/`），母本不改。
 * - 注释：只存覆盖层（forge.json），不进母本。
 * - diff：行级 Myers diff，供版本差异查看。
 */

export type ForgeEdit = {
  translate?: string
  note?: string
}

export type ForgeEdits = Record<string, ForgeEdit>

export type ForgeState = {
  version: 1
  edits: ForgeEdits
}

export type RevisionMeta = {
  id: string
  createdAt: number
  label: string
  sourceBytes: number
  note: string
}

export function editKey(chapter: number, paragraph: number): string {
  return `${chapter}:${paragraph}`
}

export function hasEdit(edit: ForgeEdit | undefined): boolean {
  return Boolean(edit?.translate?.trim() || edit?.note?.trim())
}

/** 覆盖层 JSON → 编辑表；损坏或版本不符时按空表处理。 */
export function parseForgeState(raw: string): ForgeEdits {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as Partial<ForgeState>
    if (!parsed || typeof parsed.edits !== 'object' || !parsed.edits) return {}
    const out: ForgeEdits = {}
    for (const [key, value] of Object.entries(parsed.edits)) {
      if (!value || typeof value !== 'object') continue
      const edit = value as ForgeEdit
      const cleaned: ForgeEdit = {}
      if (typeof edit.translate === 'string' && edit.translate.trim()) cleaned.translate = edit.translate
      if (typeof edit.note === 'string' && edit.note.trim()) cleaned.note = edit.note
      if (hasEdit(cleaned)) out[key] = cleaned
    }
    return out
  } catch {
    return {}
  }
}

export function serializeForgeState(edits: ForgeEdits): string {
  return JSON.stringify({ version: 1, edits } satisfies ForgeState)
}

export type DiffRow = {
  kind: 'same' | 'del' | 'add'
  text: string
  aNo: number | null
  bNo: number | null
}

export type DiffHunk = {
  rows: DiffRow[]
}

export type DiffResult = {
  hunks: DiffHunk[]
  added: number
  removed: number
  /** 差异过大、退化为整块删/增 */
  truncated: boolean
}

const MAX_EDIT_DISTANCE = 1500

/** 标准 Myers diff；只返回操作序列，超限时返回 null。 */
export function myers(a: string[], b: string[]): ('same' | 'del' | 'add')[] | null {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_EDIT_DISTANCE)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let done = false

  for (let d = 0; d <= max && !done; d += 1) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset]
      } else {
        x = v[k - 1 + offset] + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[k + offset] = x
      if (x >= n && y >= m) {
        done = true
        break
      }
    }
  }
  if (!done) return null

  const ops: ('same' | 'del' | 'add')[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vv = trace[d]!
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && vv[k - 1 + offset] < vv[k + 1 + offset])) prevK = k + 1
    else prevK = k - 1
    const prevX = vv[prevK + offset]!
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push('same')
      x -= 1
      y -= 1
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push('add')
        y -= 1
      } else {
        ops.push('del')
        x -= 1
      }
    }
  }
  ops.reverse()
  return ops
}

/** 行级差异，带 3 行上下文的 hunks。 */
export function diffLines(aText: string, bText: string, context = 3): DiffResult {
  const a = aText.split('\n')
  const b = bText.split('\n')

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  const ops = myers(midA, midB)
  const rows: DiffRow[] = []

  for (let i = 0; i < prefix; i += 1) {
    rows.push({ kind: 'same', text: a[i]!, aNo: i + 1, bNo: i + 1 })
  }
  if (ops) {
    let ai = 0
    let bi = 0
    for (const op of ops) {
      if (op === 'same') {
        rows.push({ kind: 'same', text: midA[ai]!, aNo: prefix + ai + 1, bNo: prefix + bi + 1 })
        ai += 1
        bi += 1
      } else if (op === 'del') {
        rows.push({ kind: 'del', text: midA[ai]!, aNo: prefix + ai + 1, bNo: null })
        ai += 1
      } else {
        rows.push({ kind: 'add', text: midB[bi]!, aNo: null, bNo: prefix + bi + 1 })
        bi += 1
      }
    }
  } else {
    for (let i = 0; i < midA.length; i += 1) {
      rows.push({ kind: 'del', text: midA[i]!, aNo: prefix + i + 1, bNo: null })
    }
    for (let i = 0; i < midB.length; i += 1) {
      rows.push({ kind: 'add', text: midB[i]!, aNo: null, bNo: prefix + i + 1 })
    }
  }
  for (let i = 0; i < suffix; i += 1) {
    const ai = a.length - suffix + i
    rows.push({ kind: 'same', text: a[ai]!, aNo: ai + 1, bNo: b.length - suffix + i + 1 })
  }

  let added = 0
  let removed = 0
  const changed: number[] = []
  rows.forEach((row, index) => {
    if (row.kind === 'add') added += 1
    if (row.kind === 'del') removed += 1
    if (row.kind !== 'same') changed.push(index)
  })

  const hunks: DiffHunk[] = []
  if (changed.length) {
    let start = Math.max(0, changed[0]! - context)
    let end = Math.min(rows.length - 1, changed[0]! + context)
    for (let i = 1; i < changed.length; i += 1) {
      const index = changed[i]!
      if (index - context <= end + 1) {
        end = Math.min(rows.length - 1, index + context)
      } else {
        hunks.push({ rows: rows.slice(start, end + 1) })
        start = Math.max(0, index - context)
        end = Math.min(rows.length - 1, index + context)
      }
    }
    hunks.push({ rows: rows.slice(start, end + 1) })
  }

  return { hunks, added, removed, truncated: ops == null }
}

export function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
