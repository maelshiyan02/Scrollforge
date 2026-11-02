/**
 * 术语表 / 人名地名组织名表（R7）。
 *
 * - 存储位置：应用数据目录 translate/glossary.json（由 Rust 命令读写，跨书共用）。
 * - 支持 CSV / JSON 导入导出；CSV 允许 2–4 列：原文、译文、类型、备注。
 * - 类型：person（人名）/ place（地名）/ org（组织名）/ term（通用术语）。
 */

import { Converter } from 'opencc-js/t2cn'

export type TermKind = 'person' | 'place' | 'org' | 'term'

export type GlossaryEntry = {
  id: string
  /** 原文写法（韩文 / 英文 / 繁体等） */
  source: string
  /** 简体中文译名，优先级高于模型输出 */
  target: string
  kind: TermKind
  note?: string
}

export type GlossaryState = {
  version: 1
  entries: GlossaryEntry[]
}

export const TERM_KINDS: { value: TermKind; label: string }[] = [
  { value: 'person', label: '人名' },
  { value: 'place', label: '地名' },
  { value: 'org', label: '组织名' },
  { value: 'term', label: '通用术语' },
]

export const KIND_LABEL: Record<TermKind, string> = {
  person: '人名',
  place: '地名',
  org: '组织名',
  term: '术语',
}

const KIND_SET = new Set<TermKind>(['person', 'place', 'org', 'term'])

const toSimplified = Converter({ from: 'tw', to: 'cn' })

/** 繁 → 简：优先级高于模型输出，任何译文落库前都先过一遍。 */
export function toSimplifiedZh(text: string): string {
  return toSimplified(text)
}

let seq = 0
export function newEntryId(): string {
  seq += 1
  return `g${Date.now().toString(36)}${seq.toString(36)}`
}

function asKind(value: unknown): TermKind {
  return KIND_SET.has(value as TermKind) ? (value as TermKind) : 'term'
}

function cleanEntry(raw: Partial<GlossaryEntry>): GlossaryEntry | null {
  const source = String(raw.source ?? '').trim()
  const target = String(raw.target ?? '').trim()
  if (!source || !target) return null
  return {
    id: String(raw.id ?? '').trim() || newEntryId(),
    source,
    target: toSimplifiedZh(target),
    kind: asKind(raw.kind),
    note: String(raw.note ?? '').trim() || undefined,
  }
}

export function parseGlossary(raw: string): GlossaryEntry[] {
  if (!raw.trim()) return []
  try {
    const parsed = JSON.parse(raw) as Partial<GlossaryState> | GlossaryEntry[]
    const list = Array.isArray(parsed) ? parsed : parsed?.entries
    if (!Array.isArray(list)) return []
    return list
      .map((item) => cleanEntry(item as Partial<GlossaryEntry>))
      .filter((item): item is GlossaryEntry => Boolean(item))
  } catch {
    return []
  }
}

export function serializeGlossary(entries: GlossaryEntry[]): string {
  const state: GlossaryState = { version: 1, entries }
  return JSON.stringify(state, null, 2)
}

/** 以原文（忽略大小写与多余空白）判重；导入时同原文以导入值为准。 */
export function entryKey(source: string): string {
  return source.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function mergeGlossary(base: GlossaryEntry[], incoming: GlossaryEntry[]): GlossaryEntry[] {
  const map = new Map<string, GlossaryEntry>()
  for (const entry of base) map.set(entryKey(entry.source), entry)
  for (const entry of incoming) {
    const key = entryKey(entry.source)
    const prev = map.get(key)
    map.set(key, prev ? { ...entry, id: prev.id } : entry)
  }
  return [...map.values()]
}

/** 批量把译名转简体，并去掉重复空白。 */
export function simplifyEntries(entries: GlossaryEntry[]): GlossaryEntry[] {
  return entries.map((entry) => ({
    ...entry,
    target: toSimplifiedZh(entry.target).replace(/\s+/g, ' ').trim(),
    source: entry.source.replace(/\s+/g, ' ').trim(),
  }))
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ',' || ch === '\t') {
      cells.push(cell)
      cell = ''
    } else {
      cell += ch
    }
  }
  cells.push(cell)
  return cells.map((item) => item.trim())
}

/** CSV 第一行可以是表头（source,target,kind,note），也可以直接是数据。 */
export function parseGlossaryCsv(text: string): GlossaryEntry[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  if (lines.length === 0) return []

  const first = splitCsvLine(lines[0]!)
  const head = first.map((item) => item.toLowerCase())
  const hasHeader = head.includes('source') || head.includes('原文')
  const rows = (hasHeader ? lines.slice(1) : lines).map(splitCsvLine)

  const headerIndex = (names: string[], fallback: number) => {
    const index = head.findIndex((item) => names.includes(item))
    return index >= 0 ? index : fallback
  }
  const sourceAt = hasHeader ? headerIndex(['source', '原文'], 0) : 0
  const targetAt = hasHeader ? headerIndex(['target', '译文', '译名'], 1) : 1
  const kindAt = hasHeader ? headerIndex(['kind', 'type', '类型'], 2) : 2
  const noteAt = hasHeader ? headerIndex(['note', '备注'], 3) : 3

  const kindAliases: Record<string, TermKind> = {
    person: 'person', 人名: 'person', 人物: 'person',
    place: 'place', 地名: 'place', 地点: 'place',
    org: 'org', 组织: 'org', 组织名: 'org', 机构: 'org',
    term: 'term', 术语: 'term',
  }

  const out: GlossaryEntry[] = []
  for (const row of rows) {
    const source = row[sourceAt] ?? ''
    const target = row[targetAt] ?? ''
    if (!source || !target) continue
    const kindRaw = (row[kindAt] ?? '').toLowerCase()
    out.push({
      id: newEntryId(),
      source,
      target: toSimplifiedZh(target),
      kind: kindAliases[kindRaw] ?? 'term',
      note: row[noteAt] || undefined,
    })
  }
  return out
}

function csvCell(value: string): string {
  return /[",\n\t]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function toGlossaryCsv(entries: GlossaryEntry[]): string {
  const lines = ['source,target,kind,note']
  for (const entry of entries) {
    lines.push([
      csvCell(entry.source),
      csvCell(entry.target),
      entry.kind,
      csvCell(entry.note ?? ''),
    ].join(','))
  }
  return lines.join('\n')
}
