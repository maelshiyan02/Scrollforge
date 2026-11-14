import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ClipboardEvent as ReactClipboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import Icon from './Icon'
import {
  BLOCK_TAG_LABELS,
  blockElements,
  isBlockTag,
  normalizeBlockBreaks,
  restorePreview,
  sanitizeInline,
  splitPreview,
  textToInline,
} from '../lib/inline-format'
import { parseGlossary, type GlossaryEntry } from '../lib/glossary'
import {
  loadBookDrafts,
  samePath,
  subscribeDrafts,
  removeDraft,
  type TranslateDraftTable,
} from '../lib/translate-drafts'
import { loadBookAnnotations, type Annotation } from '../lib/annotations'
import { applyChapterMarks, clearChapterMarks, collectChapterMarks } from '../lib/annotation-marks'
import {
  parseMemory,
  rememberTranslation,
  serializeMemory,
  translateOne,
  translateConfigFromPrefs,
  type TranslationMemoryState,
} from '../lib/translate'
import { DEFAULT_PREFS, type Prefs } from '../lib/prefs'

// ─── 类型（与 Rust serde 对齐） ───

interface EntryInfo {
  path: string
  mediaType: string
  id?: string | null
  role: string
  size: number
  crc: number
  compressed: number
  stored: boolean
}

interface FileContent {
  relPath: string
  mime: string
  text?: string | null
  base64?: string | null
  size: number
}

interface CheckResult {
  level: string
  code: string
  message: string
  path?: string | null
  line?: number | null
}

interface OpfMetadata {
  identifier: string
  title: string
  language: string
  creator?: string | null
  coverImage?: string | null
  modified?: string | null
}

interface EditWorkspace {
  bookId: string
  originPath: string
  originSize: number
  originModified: number
  editDir: string
  opfPath: string
  opfAbs: string
  entries: EntryInfo[]
  metadata: OpfMetadata
  revisions: string[]
}

interface TocNode { label: string; href: string; children: TocNode[] }
interface TocDocument {
  navPath?: string | null
  ncxPath?: string | null
  tree: TocNode[]
  issues: string[]
}
interface ScanReport {
  unusedImages: string[]
  orphanFiles: string[]
  duplicateIds: string[]
  brokenLinks: string[]
  tocSpineMismatch: string[]
}

/** S9：文件级操作影响面（与 Rust FileImpact 对齐） */
interface FileImpact {
  exists: boolean
  inManifest: boolean
  inSpine: boolean
  inToc: boolean
  refFiles: string[]
  refCount: number
}

/** S9：文件级操作结果（与 Rust FileOpResult 对齐） */
interface FileOpResult {
  relPath: string
  changedFiles: string[]
  addedManifest: boolean
  addedSpine: boolean
  addedToc: boolean
}

type FileOpKind = 'create' | 'rename' | 'move'

interface PendingFileOp {
  kind: 'delete' | 'rename' | 'move'
  from: string
  to?: string
  impact: FileImpact
}

/** 与 Rust BlockInfo 对齐：章节文件里的一个可编辑块 */
interface BlockInfo {
  index: number
  tag: string
  start: number
  innerStart: number
  innerEnd: number
  end: number
  selfClosing: boolean
}

/** 与 Rust BlockEdit 对齐：只提交改动块 */
interface BlockEditPayload {
  index: number
  inner?: string
  tag?: string
  delete?: boolean
}

interface BlockWriteResult {
  replaced: number
  deleted: number
  inserted: number
  total: number
  bytesBefore: number
  bytesAfter: number
}

/** D 阶段：待新建的块（先挂在锚点后，应用改动时真正插入源码） */
interface InsertRow {
  id: number
  tag: string
  html: string
}

/** E 阶段：段落视图撤销快照（结构 + 文字 + 删除 + 新建） */
interface BlockSnapshot {
  rows: { html: string; tag: string }[]
  deleted: number[]
  edits: Record<number, string>
  inserts: Record<number, InsertRow[]>
}

interface EpubRevision {
  name: string
  createdAt: number
  size: number
}

/** 视图中一段正文：html 是占位后的可编辑版本，originals 是写回时要还原的原始标签 */
interface BlockRow {
  tag: string
  origTag: string
  html: string
  originals: string[]
}

type NodePath = number[]
type Row = { node: TocNode; path: NodePath; depth: number; key: string }

function getNode(nodes: TocNode[], p: NodePath): TocNode | null {
  let list = nodes
  let node: TocNode | null = null
  for (const i of p) {
    node = list[i] ?? null
    if (!node) return null
    list = node.children
  }
  return node
}

/** 对「某个节点的兄弟列表」做整体替换（入参是节点自身路径，空路径代表根列表） */
function withSiblings(nodes: TocNode[], p: NodePath, fn: (list: TocNode[]) => TocNode[]): TocNode[] {
  return withChildren(nodes, p.slice(0, -1), fn)
}

/** 对「某个父节点的子列表」做整体替换（入参是父节点路径，空路径代表根列表） */
function withChildren(nodes: TocNode[], parent: NodePath, fn: (list: TocNode[]) => TocNode[]): TocNode[] {
  if (parent.length === 0) return fn(nodes)
  const idx = parent[0]
  return nodes.map((n, i) => i === idx ? { ...n, children: withChildren(n.children, parent.slice(1), fn) } : n)
}

function updateAt(nodes: TocNode[], p: NodePath, fn: (n: TocNode) => TocNode): TocNode[] {
  const idx = p[0]
  return nodes.map((n, i) => {
    if (i !== idx) return n
    if (p.length === 1) return fn(n)
    return { ...n, children: updateAt(n.children, p.slice(1), fn) }
  })
}

function removeAt(nodes: TocNode[], p: NodePath): TocNode[] {
  const idx = p[0]
  if (p.length === 1) return nodes.filter((_, i) => i !== idx)
  return nodes.map((n, i) => i === idx ? { ...n, children: removeAt(n.children, p.slice(1)) } : n)
}

/** 批量删除：按路径集合递归过滤，父删掉时子项一并消失 */
function filterTree(nodes: TocNode[], paths: NodePath[]): TocNode[] {
  const keys = new Set(paths.map(p => p.join('.')))
  const walk = (list: TocNode[], prefix: NodePath): TocNode[] => list.flatMap((n, i) => {
    const p = [...prefix, i]
    if (keys.has(p.join('.'))) return []
    return [{ ...n, children: walk(n.children, p) }]
  })
  return walk(nodes, [])
}

/** 批量平移：按父级分组，同组内当作一个整体上下挪动 */
function batchShift(nodes: TocNode[], paths: NodePath[], delta: number): TocNode[] {
  const groups = new Map<string, number[]>()
  for (const p of paths) {
    const parentKey = p.slice(0, -1).join('.')
    if (!groups.has(parentKey)) groups.set(parentKey, [])
    groups.get(parentKey)!.push(p[p.length - 1])
  }
  let out = nodes
  for (const [parentKey, indices] of groups) {
    const parentPath: NodePath = parentKey === '' ? [] : parentKey.split('.').map(Number)
    out = withChildren(out, parentPath, list => {
      const flags = list.map((_, i) => indices.includes(i))
      const copy = [...list]
      const order = indices.slice().sort((a, b) => delta < 0 ? a - b : b - a)
      for (const i of order) {
        const j = i + delta
        if (j < 0 || j >= copy.length || flags[j]) continue
        const tmp = copy[i]; copy[i] = copy[j]; copy[j] = tmp
        flags[i] = false; flags[j] = true
      }
      return copy
    })
  }
  return out
}

/** 同层拖拽排序：可整体拖一整块已选节点 */
function reorderSiblings(
  nodes: TocNode[], srcPath: NodePath, targetPath: NodePath, after: boolean, selected: Set<string>,
): TocNode[] {
  const parentPath = srcPath.slice(0, -1)
  return withChildren(nodes, parentPath, list => {
    const srcIdx = srcPath[srcPath.length - 1]
    const tgtIdx = targetPath[targetPath.length - 1]
    const moving = new Set<number>()
    if (selected.has(srcPath.join('.'))) {
      list.forEach((_, i) => {
        if (selected.has([...parentPath, i].join('.'))) moving.add(i)
      })
    } else {
      moving.add(srcIdx)
    }
    if (moving.has(tgtIdx)) return list
    const block = [...moving].sort((a, b) => a - b).map(i => list[i])
    const rest = list.filter((_, i) => !moving.has(i))
    const anchor = list[tgtIdx]
    const at = rest.indexOf(anchor)
    if (at < 0) return list
    const insert = at + (after ? 1 : 0)
    return [...rest.slice(0, insert), ...block, ...rest.slice(insert)]
  })
}

function stripFrag(href: string) { return href.split('#')[0] }
function countNodes(nodes: TocNode[]): number {
  return nodes.reduce((acc, n) => acc + 1 + countNodes(n.children), 0)
}
function depthOf(nodes: TocNode[]): number {
  return nodes.reduce((acc, n) => Math.max(acc, 1 + depthOf(n.children)), 0)
}

/**
 * 与 Rust scan_blocks_raw 同一规则（实现放在 lib/inline-format.ts，阅读器共用）：
 * body 直接子元素；若 body 只有一个 section/div/article 包裹层则下钻一层；
 * 空锚点 <a id="x"></a> 不算块。两者索引必须一一对应，否则回写会错位。
 */

function formatRevisionTime(seconds: number): string {
  if (!seconds) return '未知时间'
  const d = new Date(seconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 链接白名单：允许相对地址与 http(s)/mailto，拒绝 javascript 等危险协议 */
function safeLinkTarget(raw: string): string | null {
  const url = raw.trim()
  if (!url) return null
  if (/^(?:javascript|vbscript|data):/i.test(url)) return null
  return url
}

/** 块在 JS 字符串里的下标区间（Rust 给的是 UTF-8 字节偏移，不能直接切 JS 字符串） */
interface CharSpan {
  start: number
  innerStart: number
  innerEnd: number
  end: number
}

function utf8Length(code: number): number {
  if (code < 0x80) return 1
  if (code < 0x800) return 2
  if (code < 0x10000) return 3
  return 4
}

/** 一批字节偏移一次性映射成字符下标（假定偏移落在标签边界，即 ASCII 字节上） */
function toCharSpans(text: string, list: BlockInfo[]): CharSpan[] {
  const wanted = Array.from(new Set(list.flatMap(b => [b.start, b.innerStart, b.innerEnd, b.end])))
    .sort((a, b) => a - b)
  const table = new Map<number, number>()
  let bytes = 0
  let i = 0
  for (const target of wanted) {
    while (i < text.length && bytes < target) {
      const code = text.codePointAt(i) ?? 0
      bytes += utf8Length(code)
      i += code > 0xffff ? 2 : 1
    }
    table.set(target, i)
  }
  return list.map(b => ({
    start: table.get(b.start) ?? 0,
    innerStart: table.get(b.innerStart) ?? 0,
    innerEnd: table.get(b.innerEnd) ?? 0,
    end: table.get(b.end) ?? 0,
  }))
}

/**
 * 分屏对照：把富文本侧的实时改动合成到源码文本上（只在内存里，不写盘）。
 * 与 applyBlocks 用同一套 restorePreview / sanitizeInline 规则，保证「所见即将要写入」。
 * 同时给出「原文偏移 ↔ 草稿偏移」换算，供两侧光标对齐使用。
 */
interface DraftComposition {
  text: string
  toDraft: (base: number) => number
  toBase: (draft: number) => number
}

function composeBlockDraft(
  text: string,
  spans: CharSpan[],
  rows: BlockRow[],
  edits: Record<number, string>,
  deleted: Set<number>,
  inserts: Record<number, InsertRow[]>,
  insertHtml: Record<number, string>,
): DraftComposition {
  const ops: { from: number; to: number; insert: string }[] = []
  rows.forEach((row, i) => {
    const span = spans[i]
    if (!span) return
    if (deleted.has(i)) {
      ops.push({ from: span.start, to: span.end, insert: '' })
      return
    }
    const edited = edits[i]
    const tagChanged = row.tag !== row.origTag
    if (typeof edited !== 'string' && !tagChanged) return
    const restored = typeof edited === 'string'
      ? sanitizeInline(normalizeBlockBreaks(restorePreview(edited, row.originals))).xml
      : text.slice(span.innerStart, span.innerEnd)
    if (!tagChanged) {
      ops.push({ from: span.innerStart, to: span.innerEnd, insert: restored })
      return
    }
    const open = text.slice(span.start, span.innerStart)
      .replace(/^<\s*[A-Za-z0-9:_-]+/, `<${row.tag}`)
    const close = text.slice(span.innerEnd, span.end)
      .replace(/<\/\s*[A-Za-z0-9:_-]+\s*>$/, `</${row.tag}>`)
    ops.push({ from: span.start, to: span.end, insert: `${open}${restored}${close}` })
  })
  for (const [anchorKey, list] of Object.entries(inserts)) {
    const anchor = Number(anchorKey)
    const span = spans[anchor]
    if (!span || deleted.has(anchor)) continue
    const html = list.map(row => {
      const raw = insertHtml[row.id] ?? row.html
      return `<${row.tag}>${sanitizeInline(normalizeBlockBreaks(raw)).xml}</${row.tag}>`
    }).join('')
    if (html) ops.push({ from: span.end, to: span.end, insert: html })
  }
  const identity: DraftComposition = { text, toDraft: n => n, toBase: n => n }
  if (!ops.length) return identity
  const asc = [...ops].sort((a, b) => a.from - b.from)
  const toDraft = (base: number) => {
    let delta = 0
    for (const op of asc) {
      if (op.to <= base) { delta += op.insert.length - (op.to - op.from); continue }
      if (op.from < base) return op.from + delta + op.insert.length
      break
    }
    return base + delta
  }
  const toBase = (draft: number) => {
    let delta = 0
    for (const op of asc) {
      const newFrom = op.from + delta
      const newTo = newFrom + op.insert.length
      if (draft >= newTo) { delta += op.insert.length - (op.to - op.from); continue }
      if (draft >= newFrom) return op.from
      break
    }
    return draft - delta
  }
  let out = text
  for (const op of [...ops].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, op.from) + op.insert + out.slice(op.to)
  }
  return { text: out, toDraft, toBase }
}

type Props = {
  /** 源 EPUB 文件的绝对路径（book_dir/id/source.epub 或 history path） */
  epubPath: string
  /** 书库 id（用于 make_edit_dir 判定书库内位置） */
  bookId?: string
  /** 「另存为」的默认目录（最终成品文件夹） */
  exportDir?: string
  /** 阅读器当前章节的 href（相对 OPF，如 text/ch1.xhtml），用于自动对齐 */
  initialHref?: string
  /** 阅读器当前所在顶层段落块序号（body.children 下标） */
  initialBlock?: number
  /** 从阅读页送进来的划词译文：打开后直接替换到指定段落，变成可编辑草稿 */
  pendingTranslation?: { href?: string; blockIndex?: number; translation: string }
  /** 编辑器当前位置回报给外层（切到锻造档时用来对齐同章同段） */
  onContext?: (ctx: { relPath?: string; blockIndex?: number }) => void
  onClose: () => void
  onNotify: (msg: string) => void
  /** 有未保存改动时同步给外层，用于切回阅读模式前确认 */
  onDirtyChange?: (dirty: boolean) => void
  /** 保存后调用，刷新阅读器 */
  onCommitted?: () => void
  /** 编辑器偏好：初始字号、停顿后自动重建预览、保存时生成 revision */
  initialBlockFont?: number
  initialSrcFont?: number
  autoRebuild?: boolean
  createRevision?: boolean
  /** 翻译三通道通道 3：用于 translateConfigFromPrefs；不传时用默认值 */
  prefs?: Prefs
  /** 嵌入阅读器统一壳：隐藏自带头部（返回/关闭/标题），标签与操作并成一行 */
  embedded?: boolean
  /** 把工具栏状态交给外层（嵌入时阅读器顶栏渲染唯一的按钮行） */
  onToolbar?: (state: EditToolbarState | null) => void
}

export type EditTab = 'blocks' | 'meta' | 'toc'

/** 段落视图三态：富文本 / 源码 / 分屏对照（原「源码视图」切面已合并到这里） */
export type BlockView = 'rich' | 'source' | 'split'

export type EditToolbarState = {
  tab: EditTab
  setTab: (tab: EditTab) => void
  dirty: boolean
  saving: boolean
  checking: boolean
  hasWorkspace: boolean
  treeOpen: boolean
  toggleTree: () => void
  actions: {
    history: () => void
    write: () => void
    save: () => void
    saveAs: () => void
    check: () => void
  }
}

const ROLE_LABELS: Record<string, string> = {
  text: '正文', toc: '目录', style: '样式',
  image: '图片', font: '字体', manifest: '结构', other: '其他',
}

const LANGUAGES = [
  ['zh-CN', '简体中文'], ['zh-TW', '繁体中文'], ['en', '英语'], ['ja', '日语'],
  ['ko', '韩语'], ['fr', '法语'], ['de', '德语'], ['ru', '俄语'], ['es', '西班牙语'],
]

function groupByRole(entries: EntryInfo[]) {
  const groups: Record<string, EntryInfo[]> = {}
  for (const e of entries) {
    const r = ROLE_LABELS[e.role] ?? '其他'
    if (!groups[r]) groups[r] = []
    groups[r].push(e)
  }
  return groups
}

function baseName(p: string) { return p.split(/[\\/]/).pop() ?? p }

/** 从 fromRel 所在目录计算到 toRel 的相对路径（EPUB 内图片引用用） */
function relativePath(fromRel: string, toRel: string): string {
  const from = fromRel.replace(/\\/g, '/').split('/')
  const to = toRel.replace(/\\/g, '/').split('/')
  from.pop()
  let shared = 0
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1
  const up = from.length - shared
  return [...Array(up).fill('..'), ...to.slice(shared)].join('/')
}

/** 把阅读器给的 href（相对 OPF，如 text/ch1.xhtml）对上 zip 内的完整路径 */
function findEntryByHref(entries: EntryInfo[], href?: string): EntryInfo | null {
  if (!href) return null
  const clean = href.split('#')[0].replace(/\\/g, '/')
  if (!clean) return null
  let decoded = clean
  try { decoded = decodeURIComponent(clean) } catch { /* 保留原样 */ }
  const files = entries.filter(e => e.mediaType === 'application/xhtml+xml' || /\.(x?html?|xhtml)$/i.test(e.path))
  const hit = files.find(e => e.path === decoded || e.path.endsWith(`/${decoded}`))
    ?? files.find(e => {
      const low = e.path.toLowerCase()
      return low === decoded.toLowerCase() || low.endsWith(`/${decoded.toLowerCase()}`)
    })
  return hit ?? null
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)) }

/** 段落块纯文本：用于和阅读层划词草稿记录的 blockText 比对（图片占位不算文字） */
function blockPlainText(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  return (doc.body.textContent ?? '')
    .replace(/［(?:图片|图形)］/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function ScanGroup({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="toc-scan__group">
      <div className="toc-scan__title">{title}（{items.length}）</div>
      {items.length === 0
        ? <div className="toc-scan__ok">无</div>
        : <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>}
    </div>
  )
}

export default function EpubEditPanel({
  epubPath, bookId, exportDir, initialHref, initialBlock, pendingTranslation, onContext,
  onClose, onNotify, onDirtyChange, onCommitted,
  initialBlockFont = 15, initialSrcFont = 12, autoRebuild = true, createRevision = true,
  prefs = DEFAULT_PREFS, embedded = false, onToolbar,
}: Props) {
  const [workspace, setWorkspace] = useState<EditWorkspace | null>(null)
  const [entries, setEntries] = useState<EntryInfo[]>([])
  const [currentFile, setCurrentFile] = useState<FileContent | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkResults, setCheckResults] = useState<CheckResult[] | null>(null)
  const [error, setError] = useState('')

  /** 编辑视图分档：源码 / 段落（块级编辑雏形）/ 元数据 / 目录 */
  const [tab, setTab] = useState<EditTab>('blocks')
  /** 文件树默认收起，需要时从顶栏点开（段落视图更省横向空间） */
  const [treeOpen, setTreeOpen] = useState(false)

  // ─── 编辑区字号（Ctrl+滚轮） ───
  const [srcFont, setSrcFont] = useState(initialSrcFont)
  const [tocFont, setTocFont] = useState(12.5)
  const [blockFont, setBlockFont] = useState(initialBlockFont)

  // ─── 元数据表单 ───
  const [metaTitle, setMetaTitle] = useState('')
  const [metaCreator, setMetaCreator] = useState('')
  const [metaLang, setMetaLang] = useState('')
  const [coverPreview, setCoverPreview] = useState<string | null>(null)
  const [coverPath, setCoverPath] = useState<string | null>(null)
  const [savingMeta, setSavingMeta] = useState(false)

  // ─── E3：目录树 ───
  const [toc, setToc] = useState<TocNode[]>([])
  const [tocIssues, setTocIssues] = useState<string[]>([])
  const [tocBusy, setTocBusy] = useState(false)
  const [scan, setScan] = useState<ScanReport | null>(null)
  const [renaming, setRenaming] = useState('')
  const [renameValue, setRenameValue] = useState('')
  /** S9：文件级操作（新建 / 重命名 / 移动）的内联表单 */
  const [fileOp, setFileOp] = useState<{ kind: FileOpKind; value: string; title?: string } | null>(null)
  /** S9：执行前的影响面确认 */
  const [pendingFileOp, setPendingFileOp] = useState<PendingFileOp | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [lastSelected, setLastSelected] = useState<string | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ key: string; after: boolean } | null>(null)
  const dropHintRef = useRef<{ key: string; after: boolean } | null>(null)

  // ─── 二级弹窗：选目标章节（可拖动） ───
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [pickerPos, setPickerPos] = useState({ x: 240, y: 120 })
  const pickerDragRef = useRef<{ offX: number; offY: number } | null>(null)

  // ─── 段落视图（E6：块级编辑） ───
  const [blocks, setBlocks] = useState<BlockRow[] | null>(null)
  const [blockError, setBlockError] = useState('')
  const [blockDirty, setBlockDirty] = useState(false)
  const [blockVersion, setBlockVersion] = useState(0)
  const blockEdits = useRef<Record<number, string>>({})
  /** D：新建块的真实内容（按 id 存 ref，避免受控 innerHTML 打断光标） */
  const insertHtmlRef = useRef<Record<number, string>>({})
  /** 源码被手动改过、块坐标可能失效（此时禁止应用段落改动） */
  const [blocksStale, setBlocksStale] = useState(false)
  /** 已标记删除的块（写回时整段移除） */
  const [deletedIdx, setDeletedIdx] = useState<Set<number>>(new Set())

  /** D：待插入的新块，key = 插在该段之后 */
  const [inserts, setInserts] = useState<Record<number, InsertRow[]>>({})
  const insertIdRef = useRef(1)
  /** D：当前聚焦的新建块（内联工具条与上下移动都作用于它） */
  const [activeInsert, setActiveInsert] = useState<{ anchor: number; id: number } | null>(null)
  /** D：从 EPUB 现有图片里挑一张插入 */
  const [imagePicker, setImagePicker] = useState(false)
  /** D：新建块类型（段落 / 标题 / 空行） */
  const [newBlockTag, setNewBlockTag] = useState('p')
  /** E：段落视图撤销栈（Ctrl+Z / Ctrl+Shift+Z）；快照在改动前压栈 */
  const historyRef = useRef<{ undo: BlockSnapshot[]; redo: BlockSnapshot[] }>({ undo: [], redo: [] })
  const lastHistoryAtRef = useRef(0)
  const [historyTick, setHistoryTick] = useState(0)
  void historyTick
  /** 当前正在编辑的块序号（内联工具条作用于它） */
  const [activeBlock, setActiveBlock] = useState<number | null>(null)
  /** 通道 3：正在翻译的块序号（loading 状态） */
  const [translatingBlock, setTranslatingBlock] = useState<number | null>(null)
  /** 逐块翻译失败原因（常驻，直到下次重试） */
  const [translateError, setTranslateError] = useState<{ index: number; message: string } | null>(null)
  /** 被翻译过的块 → 翻译前的原文 html，用于一键恢复原文 */
  const [translatedOrigin, setTranslatedOrigin] = useState<Record<number, string>>({})
  /** 术语表 / 翻译记忆：与锻造层共用应用数据目录里的同一份 */
  const glossaryRef = useRef<GlossaryEntry[]>([])
  const memoryRef = useRef<TranslationMemoryState>({ version: 1, entries: {} })
  const activeBlockRef = useRef<number | null>(null)
  activeBlockRef.current = activeBlock
  /** 段落视图三态（S8）：默认富文本，可切源码 / 分屏对照 */
  const [blockView, setBlockView] = useState<BlockView>('rich')
  /** 阅读层高亮 / 笔记（只读渲染到富文本视图，数据在 阅读壳/annotations.json） */
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  /** 分屏时源码侧显示的镜像文本：富文本改动实时合入，仅本地预览、不落盘 */
  const [mirrorText, setMirrorText] = useState<string | null>(null)
  /** 源码侧光标所在块序号（富文本对应段高亮） */
  const [srcActiveBlock, setSrcActiveBlock] = useState<number | null>(null)
  /** 后端块区间（字节偏移，与 blocks 一一对应时才有值） */
  const blockSpansRef = useRef<BlockInfo[] | null>(null)
  /** 字节偏移 → JS 字符偏移缓存（换文件/文本变化即失效） */
  const charSpansRef = useRef<{ text: string; spans: CharSpan[] } | null>(null)
  /** 分屏镜像的偏移换算：镜像文本长度与原文不同时，靠它把两侧光标对齐 */
  const mirrorOffsetRef = useRef<{ toDraft: (n: number) => number; toBase: (n: number) => number } | null>(null)
  /** 程序化滚动期间短暂关闭双向滚动同步，避免互相拉扯 */
  const scrollLockRef = useRef(0)
  const blocksRef = useRef<BlockRow[] | null>(null)
  blocksRef.current = blocks
  const deletedRef = useRef(deletedIdx)
  deletedRef.current = deletedIdx
  const insertsRef = useRef(inserts)
  insertsRef.current = inserts
  const blocksStaleRef = useRef(blocksStale)
  blocksStaleRef.current = blocksStale
  const currentFileRef = useRef(currentFile)
  currentFileRef.current = currentFile
  /** 阅读器带来的待滚动段落块序号（一次性） */
  const pendingBlockRef = useRef<number | null>(null)
  /** 段落视图当前可见的顶层块序号（滚动时更新，供三档接力） */
  const visibleBlockRef = useRef<number | null>(null)
  /** 程序化定位期间暂停几何测量，避免把「上一段残影」当成当前段 */
  const measureSuppressedRef = useRef(false)
  /** 划词译文只应用一次（之后用户在段落里改动不回滚） */
  const translationSeededRef = useRef(false)
  /** 阅读层划词译文草稿（书级），用于切到编辑档时自动铺进对应段落 */
  const draftsRef = useRef<TranslateDraftTable>({})
  /** 草稿表变更计数：触发自动套用 effect 重跑 */
  const [draftTick, setDraftTick] = useState(0)
  /** 本次编辑会话里真正套用过的划词草稿；保存成功后清掉这些 */
  const appliedDraftCfisRef = useRef<Set<string>>(new Set())
  const onContextRef = useRef(onContext)
  onContextRef.current = onContext
  const previewTimer = useRef<number | null>(null)

  // ─── E6：历史版本（EPUB 快照回滚） ───
  const [revOpen, setRevOpen] = useState(false)
  const [revisions, setRevisions] = useState<EpubRevision[]>([])
  const [revBusy, setRevBusy] = useState(false)

  const tocListRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLElement>(null)
  const blockCanvasRef = useRef<HTMLDivElement>(null)
  const blockPageRef = useRef<HTMLDivElement>(null)
  const splitSrcRef = useRef<HTMLTextAreaElement>(null)

  const visibleEntries = useMemo(
    () => (tab === 'blocks' ? entries.filter((e) => e.role === 'text' || e.role === 'toc') : entries),
    [entries, tab],
  )

  /** 正文章节清单：nav 的 href 对到正文文件，按目录顺序排；缺标题的用文件名兜底 */
  const chapterList = useMemo(() => {
    const textFiles = entries.filter((e) => e.role === 'text')
    const ordered: { entry: EntryInfo; label: string }[] = []
    const seen = new Set<string>()
    const walk = (nodes: TocNode[]) => {
      for (const node of nodes) {
        const hit = findEntryByHref(textFiles, node.href)
        if (hit && !seen.has(hit.path)) {
          seen.add(hit.path)
          ordered.push({ entry: hit, label: (node.label ?? '').trim() })
        }
        walk(node.children)
      }
    }
    walk(toc)
    for (const entry of textFiles) {
      if (!seen.has(entry.path)) ordered.push({ entry, label: '' })
    }
    return ordered
  }, [entries, toc])

  /** 结构文件：正文之外的分区（目录/样式/图片/字体/manifest） */
  const structuralGroups = useMemo(
    () => groupByRole(visibleEntries.filter((e) => e.role !== 'text')),
    [visibleEntries],
  )

  const metaDirty = !!workspace && (
    metaTitle !== workspace.metadata.title ||
    (metaCreator || '') !== (workspace.metadata.creator ?? '') ||
    metaLang !== workspace.metadata.language ||
    !!coverPath
  )

  useEffect(() => {
    onDirtyChange?.(dirty || metaDirty || blockDirty)
  }, [dirty, metaDirty, blockDirty, onDirtyChange])

  // 翻译上下文与锻造层共用：进面板时读一次术语表与翻译记忆
  useEffect(() => {
    void (async () => {
      try {
        const [rawGlossary, rawMemory] = await Promise.all([
          invoke<string>('read_glossary'),
          invoke<string>('read_translation_memory'),
        ])
        glossaryRef.current = parseGlossary(rawGlossary)
        memoryRef.current = parseMemory(rawMemory)
      } catch (err) {
        console.warn('读取术语表 / 翻译记忆失败：', err)
      }
    })()
  }, [])

  // 阅读层划词译文草稿：读入本书草稿表，编辑器打开章节后自动铺到对应段落
  useEffect(() => {
    if (!bookId) {
      draftsRef.current = {}
      return
    }
    let alive = true
    const sync = (table: TranslateDraftTable) => {
      draftsRef.current = table
      setDraftTick(t => t + 1)
    }
    void loadBookDrafts(bookId).then(table => {
      if (!alive) return
      sync(table)
    })
    const unsubscribe = subscribeDrafts(bookId, table => {
      if (!alive) return
      sync(table)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [bookId])

  // 阅读层高亮 / 笔记：进面板与换章时读一次，只读渲染，不在编辑档改
  useEffect(() => {
    if (!bookId) {
      setAnnotations([])
      return
    }
    let alive = true
    void loadBookAnnotations(bookId)
      .then(result => {
        if (alive) setAnnotations(result.list)
      })
      .catch(() => {
        if (alive) setAnnotations([])
      })
    return () => {
      alive = false
    }
  }, [bookId, currentFile?.relPath])

  // ─── 把工作副本信息灌进表单 ───

  const fillFromWorkspace = useCallback((ws: EditWorkspace) => {
    setWorkspace(ws)
    setEntries(ws.entries)
    setMetaTitle(ws.metadata.title)
    setMetaCreator(ws.metadata.creator ?? '')
    setMetaLang(ws.metadata.language)
    setCoverPath(null)
    setSelected(new Set())
    setCollapsed(new Set())
    setLastSelected(null)
    const cover = ws.metadata.coverImage
    if (cover) {
      void invoke<FileContent>('edit_read_file', { editDir: ws.editDir, relPath: cover })
        .then(f => setCoverPreview(f.base64 ? `data:${f.mime};base64,${f.base64}` : null))
        .catch(() => setCoverPreview(null))
    } else {
      setCoverPreview(null)
    }
    void invoke<TocDocument>('edit_read_toc', { editDir: ws.editDir, opfPath: ws.opfPath })
      .then(d => { setToc(d.tree); setTocIssues(d.issues); setScan(null) })
      .catch(err => setTocIssues([`读取目录失败：${String(err)}`]))
  }, [])

  // ─── 挂载时自动解包 ───

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      try {
        const editDir = await invoke<string>('make_edit_dir', { originPath: epubPath })
        const ws = await invoke<EditWorkspace>('edit_open_epub', { epubPath, editDir })
        if (!cancelled) {
          fillFromWorkspace(ws)
          onNotify(`已解包 ${ws.entries.length} 个条目`)
          // 从阅读页切过来：直接打开当前章节，并把段落滚动目标排进队列
          const target = findEntryByHref(ws.entries, initialHref)
          if (target) {
            const content = await invoke<FileContent>('edit_read_file', {
              editDir: ws.editDir, relPath: target.path,
            })
            if (!cancelled) {
              setCurrentFile(content)
              setTab('blocks')
              pendingBlockRef.current = typeof initialBlock === 'number' ? initialBlock : null
            }
          }
        }
      } catch (err) {
        if (!cancelled) setError(`打开失败：${String(err)}`)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epubPath])

  // ─── 选文件 ───

  const handleSelect = useCallback(async (entry: EntryInfo) => {
    if ((dirty || blockDirty) && currentFile) {
      const ok = confirm(`${currentFile.relPath} 有未保存改动，切换吗？`)
      if (!ok) return
    }
    setDirty(false)
    setBlockDirty(false)
    setDeletedIdx(new Set())
    blockEdits.current = {}
    setError('')
    try {
      const content = await invoke<FileContent>('edit_read_file', {
        editDir: workspace!.editDir, relPath: entry.path,
      })
      setCurrentFile(content)
    } catch (err) {
      setError(`读取失败：${String(err)}`)
    }
  }, [dirty, currentFile, workspace])

  // ─── 编辑文本 ───

  const handleTextChange = useCallback((value: string) => {
    if (!currentFile) return
    setCurrentFile({ ...currentFile, text: value })
    setDirty(true)
  }, [currentFile])

  /** 段落写回实现挂在 ref 上：保存 / 写回处理函数定义在它之前 */
  const applyBlocksRef = useRef<() => Promise<boolean>>(async () => false)

  // ─── 写回当前文件（不重打包，Ctrl+S 时调用） ───

  const handleWrite = useCallback(async () => {
    if (!workspace) return
    setError('')
    // 段落改动先按块写回（Rust 只替换 dirty 块），再落源码文本
    if (blockDirty) {
      const ok = await applyBlocksRef.current()
      if (!ok) return
    }
    if (!currentFile || !dirty) return
    try {
      await invoke('edit_write_file', {
        editDir: workspace.editDir, relPath: currentFile.relPath,
        content: currentFile.text ?? '',
      })
      setDirty(false)
      onNotify(`已写入 ${baseName(currentFile.relPath)}`)
    } catch (err) {
      setError(`写入失败：${String(err)}`)
    }
  }, [workspace, currentFile, dirty, blockDirty, onNotify])

  // ─── 保存重打包 ───

  const handleSave = useCallback(async () => {
    if (!workspace) return
    setSaving(true)
    setError('')
    try {
      if (blockDirty) {
        const ok = await applyBlocksRef.current()
        if (!ok) return
      }
      // 先写回当前
      if (dirty && currentFile) {
        await invoke('edit_write_file', {
          editDir: workspace.editDir, relPath: currentFile.relPath,
          content: currentFile.text ?? '',
        })
      }
      // 重打包
      await invoke('edit_save', {
        editDir: workspace.editDir,
        outputPath: workspace.originPath,
        createRevision,
        bookId,
      })
      setDirty(false)
      // 译文已写进书里：清掉本次真正用到的阅读划词草稿，避免下次重复带入
      if (bookId) {
        for (const cfi of appliedDraftCfisRef.current) removeDraft(bookId, cfi)
        appliedDraftCfisRef.current.clear()
      }
      onNotify('已保存并重打包')
      onCommitted?.()
    } catch (err) {
      setError(`保存失败：${String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [workspace, currentFile, dirty, blockDirty, bookId, onNotify, onCommitted, createRevision])

  // ─── 另存为（默认落到最终成品文件夹，可另选任意位置） ───

  const handleSaveAs = useCallback(async () => {
    if (!workspace) return
    const fileName = workspace.originPath.split(/[\\/]/).pop() || 'book.epub'
    const dir = (exportDir || '').replace(/[\\/]$/, '')
    const target = await save({
      title: '另存为 EPUB',
      defaultPath: dir ? `${dir}/${fileName}` : fileName,
      filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
    })
    if (typeof target !== 'string') return
    setSaving(true)
    setError('')
    try {
      if (blockDirty) {
        const ok = await applyBlocksRef.current()
        if (!ok) return
      }
      if (dirty && currentFile) {
        await invoke('edit_write_file', {
          editDir: workspace.editDir, relPath: currentFile.relPath,
          content: currentFile.text ?? '',
        })
        setDirty(false)
      }
      await invoke('edit_save', {
        editDir: workspace.editDir,
        outputPath: target,
        createRevision: false,
        bookId,
      })
      onNotify(`已另存为：${target}`)
    } catch (err) {
      setError(`另存为失败：${String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [workspace, currentFile, dirty, blockDirty, exportDir, bookId, onNotify])

  // ─── epubcheck ───

  const handleCheck = useCallback(async () => {
    if (!workspace) return
    // 先确保包是最新的
    if (dirty) { onNotify('请先保存再检查'); return }
    if (blockDirty) { onNotify('段落改动还没写回，请先点「应用改动」或保存'); return }
    setChecking(true); setCheckResults(null); setError('')
    try {
      const results = await invoke<CheckResult[]>('edit_check', { epubPath: workspace.originPath })
      setCheckResults(results)
      const errs = results.filter(r => r.level === 'FATAL' || r.level === 'ERROR').length
      onNotify(errs === 0 ? '✓ epubcheck 通过' : `${errs} 个问题`)
    } catch (err) {
      setError(`epubcheck 失败：${String(err)}`)
    } finally {
      setChecking(false)
    }
  }, [workspace, dirty, blockDirty, onNotify])

  // ─── E6：历史版本列表与回滚 ───

  const openRevisions = useCallback(async () => {
    if (!workspace) return
    setRevOpen(true)
    setRevBusy(true)
    setError('')
    try {
      const list = await invoke<EpubRevision[]>('edit_list_revisions', { editDir: workspace.editDir, bookId })
      setRevisions(list)
    } catch (err) {
      setError(`读取历史版本失败：${String(err)}`)
    } finally {
      setRevBusy(false)
    }
  }, [workspace, bookId])

  const handleRestore = useCallback(async (revision: EpubRevision) => {
    if (!workspace) return
    const label = formatRevisionTime(revision.createdAt)
    if (!confirm(`回滚到 ${label} 的快照？当前版本会先自动存档，不会丢。`)) return
    setRevBusy(true)
    setError('')
    try {
      const ws = await invoke<EditWorkspace>('edit_restore_revision', {
        editDir: workspace.editDir,
        originPath: workspace.originPath,
        revision: revision.name,
        bookId,
      })
      fillFromWorkspace(ws)
      blockEdits.current = {}
      setBlockDirty(false)
      setDeletedIdx(new Set())
      setBlocksStale(false)
      setDirty(false)
      setBlockVersion(v => v + 1)
      // 重新读取当前正文，保证可视视图与回滚后的包一致
      if (currentFile) {
        const fresh = await invoke<FileContent>('edit_read_file', {
          editDir: ws.editDir, relPath: currentFile.relPath,
        })
        setCurrentFile(fresh)
      }
      const list = await invoke<EpubRevision[]>('edit_list_revisions', { editDir: ws.editDir, bookId })
      setRevisions(list)
      onNotify(`已回滚到 ${label}`)
      onCommitted?.()
    } catch (err) {
      setError(`回滚失败：${String(err)}`)
    } finally {
      setRevBusy(false)
    }
  }, [workspace, currentFile, bookId, fillFromWorkspace, onNotify, onCommitted])


  // ─── E2：选封面图（只预览，保存时替换进工作副本） ───

  const handleChooseCover = useCallback(async () => {
    const picked = await open({
      multiple: false,
      title: '选择封面图片',
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
    })
    if (typeof picked !== 'string') return
    try {
      const f = await invoke<FileContent>('preview_image', { path: picked })
      setCoverPreview(f.base64 ? `data:${f.mime};base64,${f.base64}` : null)
      setCoverPath(picked)
    } catch (err) {
      setError(`读封面失败：${String(err)}`)
    }
  }, [])

  // ─── E2：写回元数据（工作副本里的 OPF + 封面文件） ───

  const handleSaveMeta = useCallback(async () => {
    if (!workspace) return
    if (!metaTitle.trim()) { setError('书名不能为空'); return }
    if (!metaLang.trim()) { setError('语言不能为空（如 zh-CN / en）'); return }
    setSavingMeta(true)
    setError('')
    try {
      const meta = await invoke<OpfMetadata>('edit_update_metadata', {
        editDir: workspace.editDir,
        opfPath: workspace.opfPath,
        title: metaTitle.trim(),
        creator: metaCreator.trim(),
        language: metaLang.trim(),
        coverPath: coverPath ?? null,
      })
      setWorkspace({ ...workspace, metadata: meta })
      setCoverPath(null)
      if (meta.coverImage) {
        const f = await invoke<FileContent>('edit_read_file', {
          editDir: workspace.editDir, relPath: meta.coverImage,
        })
        setCoverPreview(f.base64 ? `data:${f.mime};base64,${f.base64}` : null)
      }
      onNotify('元数据已写回工作副本，点顶部打包按钮才会写进 EPUB')
    } catch (err) {
      setError(`写元数据失败：${String(err)}`)
    } finally {
      setSavingMeta(false)
    }
  }, [workspace, metaTitle, metaCreator, metaLang, coverPath, onNotify])

  // ─── 段落视图：当前文件按顶层块拆开 ───

  useEffect(() => {
    let cancelled = false
    blockEdits.current = {}
    setBlockDirty(false)
    setBlocksStale(false)
    setDeletedIdx(new Set())
    setActiveBlock(null)
    setBlockError('')
    blockSpansRef.current = null
    charSpansRef.current = null
    mirrorOffsetRef.current = null
    setMirrorText(null)
    setSrcActiveBlock(null)
    if (!currentFile?.text) { setBlocks(null); return }
    if (!/x?html?|xml/i.test(currentFile.mime) && !/\.(x?html?|xhtml)$/i.test(currentFile.relPath)) {
      setBlocks(null)
      setBlockError('这个文件不是正文，已切到源码模式')
      return
    }
    try {
      const doc = new DOMParser().parseFromString(currentFile.text, 'application/xhtml+xml')
      if (doc.querySelector('parsererror')) {
        setBlocks(null)
        setBlockError('这个文件不是合法 XML，段落视图不可用，请切回「源码」')
        return
      }
      const elements = blockElements(doc)
      if (!elements.length) { setBlocks(null); return }
      const rows: BlockRow[] = elements.map(el => {
        const parsed = splitPreview(el.innerHTML)
        return {
          tag: el.tagName.toLowerCase(),
          origTag: el.tagName.toLowerCase(),
          html: parsed.html,
          originals: parsed.originals,
        }
      })
      setBlocks(rows)
      // 与后端扫描结果核对索引：两边必须一一对应，否则回写会错位
      if (workspace) {
        const { editDir } = workspace
        const relPath = currentFile.relPath
        void invoke<BlockInfo[]>('edit_scan_blocks', { editDir, relPath })
          .then(list => {
            if (cancelled) return
            if (list.length !== rows.length) {
              setBlocks(null)
              setBlockError(`段落索引与后端不一致（前端 ${rows.length} / 后端 ${list.length}），请点「刷新预览」`)
              return
            }
            // 后端区间是 UTF-8 字节偏移；分屏镜像与光标对应都要用字符下标
            blockSpansRef.current = list
            charSpansRef.current = null
          })
          .catch(() => { /* 后端不可用时以 DOM 解析结果为准（分屏镜像降级为只读源码） */ })
      }
    } catch (err) {
      setBlocks(null)
      setBlockError(`解析失败：${String(err)}`)
    }
    return () => { cancelled = true }
    // 只在换文件 / 应用改动后重解析，打字时不重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFile?.relPath, blockVersion, workspace?.editDir])

  /**
   * E6：只把改动过的块提交给 Rust；Rust 按字节区间替换，
   * 未触碰的块逐字节保留（不做整篇 DOM 重排）。
   */
  const applyBlocks = useCallback(async (): Promise<boolean> => {
    if (!workspace || !currentFile?.text) return false
    if (!blocks?.length) return false
    if (blocksStale) {
      setError('源码已被手动改动，段落坐标失效：请先点「刷新预览」再应用')
      return false
    }

    const payload: BlockEditPayload[] = []
    const removedTags: string[] = []
    const removedAttrs: string[] = []
    try {
      blocks.forEach((row, i) => {
        if (deletedIdx.has(i)) {
          payload.push({ index: i, delete: true })
          return
        }
        const edited = blockEdits.current[i]
        const tagChanged = row.tag !== row.origTag
        if (typeof edited !== 'string' && !tagChanged) return
        const edit: BlockEditPayload = { index: i }
        if (typeof edited === 'string') {
          const restored = normalizeBlockBreaks(restorePreview(edited, row.originals))
          const clean = sanitizeInline(restored)
          edit.inner = clean.xml
          removedTags.push(...clean.removedTags)
          removedAttrs.push(...clean.removedAttrs)
        }
        if (tagChanged) edit.tag = row.tag
        payload.push(edit)
      })

      // D：新建块——内容来自 ref（避免受控 innerHTML 打断光标）
      const insertPayload: { index: number; tag: string; inner: string }[] = []
      for (const [anchor, list] of Object.entries(inserts)) {
        const anchorIndex = Number(anchor)
        if (deletedIdx.has(anchorIndex)) continue
        for (const row of list) {
          const rawHtml = insertHtmlRef.current[row.id] ?? row.html
          const clean = sanitizeInline(normalizeBlockBreaks(rawHtml))
          insertPayload.push({ index: anchorIndex, tag: row.tag, inner: clean.xml })
        }
      }
      if (!payload.length && !insertPayload.length) return false

      const result = await invoke<BlockWriteResult>('edit_write_blocks', {
        editDir: workspace.editDir,
        relPath: currentFile.relPath,
        edits: payload,
        inserts: insertPayload,
      })
      const fresh = await invoke<FileContent>('edit_read_file', {
        editDir: workspace.editDir, relPath: currentFile.relPath,
      })
      setCurrentFile(fresh)
      blockEdits.current = {}
      insertHtmlRef.current = {}
      setInserts({})
      setActiveInsert(null)
      // 写回后块坐标已变，旧快照作废
      historyRef.current = { undo: [], redo: [] }
      setBlockDirty(false)
      setDeletedIdx(new Set())
      setDirty(false)
      setBlockVersion(v => v + 1)

      // P3：人工确认写回的译文才进翻译记忆；阅读划词草稿不进
      let memory = memoryRef.current
      let memoryChanged = false
      const confirmed: number[] = []
      for (const edit of payload) {
        const origin = translatedOrigin[edit.index]
        if (origin === undefined) continue
        confirmed.push(edit.index)
        if (typeof edit.inner !== 'string') continue
        const source = blockPlainText(origin)
        const target = blockPlainText(edit.inner)
        if (!source || !target || source === target) continue
        const next = rememberTranslation(memory, source, target, 'edit')
        if (next !== memory) {
          memory = next
          memoryChanged = true
        }
      }
      if (memoryChanged) {
        memoryRef.current = memory
        void invoke('write_translation_memory', { json: serializeMemory(memory) })
          .catch(err => console.warn('写入翻译记忆失败：', err))
      }
      if (confirmed.length) {
        setTranslatedOrigin(prev => {
          const next = { ...prev }
          confirmed.forEach(idx => { delete next[idx] })
          return next
        })
      }

      const stripNote = removedTags.length || removedAttrs.length
        ? `，已剥离 ${removedTags.length} 个标签 / ${removedAttrs.length} 个属性`
        : ''
      onNotify(`已写回 ${result.replaced} 段${result.deleted ? `、删除 ${result.deleted} 段` : ''}${result.inserted ? `、新增 ${result.inserted} 段` : ''}；其余 ${result.total - result.replaced - result.deleted} 段逐字节保留${stripNote}`)
      return true
    } catch (err) {
      setError(`段落写回失败：${String(err)}`)
      return false
    }
  }, [workspace, currentFile, blocks, blocksStale, deletedIdx, inserts, translatedOrigin, onNotify])
  applyBlocksRef.current = applyBlocks

  /** 段落内粘贴：走白名单过滤，危险标签剥离并提示 */
  const handleBlockPaste = useCallback((index: number, e: ReactClipboardEvent<HTMLDivElement>) => {
    const html = e.clipboardData.getData('text/html')
    const text = e.clipboardData.getData('text/plain')
    if (!html && !text) return
    e.preventDefault()
    const host = e.currentTarget
    let insert = ''
    let removed = 0
    let attrs = 0
    if (html) {
      try {
        const clean = sanitizeInline(normalizeBlockBreaks(html))
        insert = clean.html
        removed = clean.removedTags.length
        attrs = clean.removedAttrs.length
      } catch {
        insert = textToInline(text)
      }
    } else {
      insert = textToInline(text)
    }
    document.execCommand('insertHTML', false, insert)
    blockEdits.current[index] = host.innerHTML
    if (!blockDirty) setBlockDirty(true)
    if (removed || attrs) {
      onNotify(`粘贴内容已过滤：剥离 ${removed} 个标签 / ${attrs} 个属性（只保留 em、strong、a、span、br、img）`)
    }
  }, [blockDirty, onNotify])

  /** 内联工具条：粗体 / 斜体 / 链接，作用于当前聚焦的块 */
  const runInline = useCallback((command: string, value?: string) => {
    const index = activeBlockRef.current
    if (index == null) {
      onNotify('先在段落里选中要加格式的文字')
      return
    }
    const host = blockPageRef.current
      ?.querySelector(`[data-blk-index="${index}"] .blk-body`) as HTMLElement | null
    if (!host) return
    const focused = document.activeElement
    if (focused !== host && !host.contains(focused)) {
      onNotify('先把光标放到这一段正文里')
      return
    }
    document.execCommand(command, false, value)
    blockEdits.current[index] = host.innerHTML
    setBlockDirty(true)
  }, [onNotify])

  const handleBold = useCallback(() => runInline('bold'), [runInline])
  const handleItalic = useCallback(() => runInline('italic'), [runInline])
  const handleLink = useCallback(() => {
    const href = window.prompt('链接地址（可填相对路径，如 ../notes.xhtml#n1）', '')
    if (href == null) return
    const target = safeLinkTarget(href)
    if (!target) {
      setError('链接地址不安全（不允许 javascript / data 等协议）')
      return
    }
    runInline('createLink', target)
  }, [runInline])

  /** 改标题级别：只改块标签；没动过正文时不提交 inner，让 Rust 原样保留块内字节 */
  const changeBlockTag = useCallback((index: number, next: string) => {
    if (!isBlockTag(next)) return
    setBlocks(prev => prev ? prev.map((row, i) => (i === index ? { ...row, tag: next } : row)) : prev)
    setBlockDirty(true)
  }, [])

  const markDeleteBlock = useCallback((index: number) => {
    if (!confirm(`删除第 ${index + 1} 段？应用后不可撤销（可用历史版本回滚整本书）`)) return
    setDeletedIdx(prev => {
      const nextSet = new Set(prev)
      nextSet.add(index)
      return nextSet
    })
    setBlockDirty(true)
  }, [])

  const undoDeleteBlock = useCallback((index: number) => {
    setDeletedIdx(prev => {
      const nextSet = new Set(prev)
      nextSet.delete(index)
      return nextSet
    })
    setBlockDirty(true)
  }, [])

  // ─── E：段落视图撤销 / 重做（快照在改动前压栈） ───

  const snapshotNow = useCallback((): BlockSnapshot => {
    const copyInserts: Record<number, InsertRow[]> = {}
    for (const [anchor, list] of Object.entries(inserts)) {
      copyInserts[Number(anchor)] = list.map(row => ({
        ...row,
        html: insertHtmlRef.current[row.id] ?? row.html,
      }))
    }
    return {
      rows: (blocks ?? []).map(row => ({ html: row.html, tag: row.tag })),
      deleted: [...deletedIdx],
      edits: { ...blockEdits.current },
      inserts: copyInserts,
    }
  }, [blocks, deletedIdx, inserts])

  const pushHistory = useCallback(() => {
    if (!blocks) return
    const history = historyRef.current
    history.undo.push(snapshotNow())
    if (history.undo.length > 60) history.undo.shift()
    history.redo = []
    lastHistoryAtRef.current = Date.now()
    setHistoryTick(n => n + 1)
  }, [blocks, snapshotNow])

  const applySnapshot = useCallback((snap: BlockSnapshot) => {
    blockEdits.current = { ...snap.edits }
    setBlocks(prev => prev ? prev.map((row, i) => ({
      ...row,
      html: snap.rows[i]?.html ?? row.html,
      tag: snap.rows[i]?.tag ?? row.tag,
    })) : prev)
    setDeletedIdx(new Set(snap.deleted))
    const nextInserts: Record<number, InsertRow[]> = {}
    const nextHtml: Record<number, string> = {}
    for (const [anchor, list] of Object.entries(snap.inserts)) {
      nextInserts[Number(anchor)] = list.map(row => {
        nextHtml[row.id] = row.html
        return { ...row }
      })
    }
    insertHtmlRef.current = nextHtml
    setInserts(nextInserts)
    setBlockDirty(true)
  }, [])

  const undoBlocks = useCallback(() => {
    const history = historyRef.current
    const prev = history.undo.pop()
    if (!prev) { onNotify('没有可撤销的段落改动'); return }
    history.redo.push(snapshotNow())
    applySnapshot(prev)
    setHistoryTick(n => n + 1)
  }, [applySnapshot, onNotify, snapshotNow])

  const redoBlocks = useCallback(() => {
    const history = historyRef.current
    const next = history.redo.pop()
    if (!next) { onNotify('没有可重做的段落改动'); return }
    history.undo.push(snapshotNow())
    applySnapshot(next)
    setHistoryTick(n => n + 1)
  }, [applySnapshot, onNotify, snapshotNow])

  /** D：新建块的锚点（优先当前聚焦段，否则插在最后一段之后） */
  const insertAnchor = useCallback((): number => {
    if (activeBlock != null) return activeBlock
    return Math.max(0, (blocks?.length ?? 1) - 1)
  }, [activeBlock, blocks])

  const addBlock = useCallback((tag: string, html = '') => {
    if (!blocks?.length) { onNotify('这个文件没有可分块的正文'); return }
    pushHistory()
    const anchor = insertAnchor()
    const id = insertIdRef.current++
    insertHtmlRef.current[id] = html
    const row: InsertRow = { id, tag, html }
    setInserts(prev => ({ ...prev, [anchor]: [...(prev[anchor] ?? []), row] }))
    setActiveInsert({ anchor, id })
    setActiveBlock(null)
    setBlockDirty(true)
  }, [blocks, insertAnchor, onNotify, pushHistory])

  const updateInsert = useCallback((id: number, html: string) => {
    insertHtmlRef.current[id] = html
    if (!blockDirty) setBlockDirty(true)
  }, [blockDirty])

  const removeInsert = useCallback((anchor: number, id: number) => {
    pushHistory()
    delete insertHtmlRef.current[id]
    setInserts(prev => {
      const list = (prev[anchor] ?? []).filter(row => row.id !== id)
      const next = { ...prev }
      if (list.length) next[anchor] = list
      else delete next[anchor]
      return next
    })
    setActiveInsert(cur => (cur && cur.id === id ? null : cur))
    setBlockDirty(true)
  }, [pushHistory])

  /** D：整段上移 / 下移（交换相邻两段的内容与标签；原块的 class/id 留在原位） */
  const moveBlock = useCallback((index: number, delta: -1 | 1) => {
    if (!blocks) return
    const target = index + delta
    if (target < 0 || target >= blocks.length) return
    if (deletedIdx.has(index) || deletedIdx.has(target)) {
      onNotify('相邻段带有删除标记，请先撤销删除再移动')
      return
    }
    pushHistory()
    const a = blocks[index]
    const b = blocks[target]
    const editA = blockEdits.current[index] ?? a.html
    const editB = blockEdits.current[target] ?? b.html
    blockEdits.current[index] = editB
    blockEdits.current[target] = editA
    setBlocks(prev => prev ? prev.map((row, i) => {
      if (i === index) return { ...row, html: b.html, tag: b.tag }
      if (i === target) return { ...row, html: a.html, tag: a.tag }
      return row
    }) : prev)
    setBlockDirty(true)
  }, [blocks, deletedIdx, onNotify, pushHistory])

  const handleUnderline = useCallback(() => runInline('underline'), [runInline])

  /** D：从 EPUB 现有图片里插入一张到当前段 */
  const imageEntries = useMemo(
    () => entries.filter(e => e.mediaType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(e.path)),
    [entries],
  )

  const insertImage = useCallback((entry: EntryInfo) => {
    const index = activeBlockRef.current
    if (index == null) {
      onNotify('先把光标放到要插图的那一段')
      return
    }
    const host = blockPageRef.current
      ?.querySelector(`[data-blk-index="${index}"] .blk-body`) as HTMLElement | null
    if (!host) return
    const focused = document.activeElement
    if (focused !== host && !host.contains(focused)) {
      onNotify('先把光标放到这一段正文里')
      return
    }
    if (!currentFile) return
    const src = relativePath(currentFile.relPath, entry.path)
    document.execCommand('insertHTML', false, `<img src="${src}" alt="${baseName(entry.path)}"/>`)
    blockEdits.current[index] = host.innerHTML
    setBlockDirty(true)
    setImagePicker(false)
    onNotify(`已插入图片 ${baseName(entry.path)}，应用改动后写入章节`)
  }, [currentFile, onNotify])

  /** E4：源码 → 预览重解析；段落有未应用改动时需要先确认 */
  const rebuildPreview = useCallback(() => {
    if (blockDirty && !confirm('段落里有尚未应用的改动，刷新预览会丢弃它们，继续？')) return
    setBlockVersion(v => v + 1)
  }, [blockDirty])

  /** E4：源码侧打字后，停顿 700ms 自动重建预览（设置里可关闭） */
  const handleSplitSourceChange = useCallback((value: string) => {
    handleTextChange(value)
    mirrorOffsetRef.current = null
    setMirrorText(null)
    if (previewTimer.current) window.clearTimeout(previewTimer.current)
    // 源码改过之后块坐标不再可靠，标脏并停止自动重建
    if (blockDirty) { setBlocksStale(true); return }
    if (!autoRebuild) return
    previewTimer.current = window.setTimeout(() => setBlockVersion(v => v + 1), 700)
  }, [handleTextChange, blockDirty, autoRebuild])

  /** 字节偏移映射缓存：同一份源码文本只算一次 */
  const charSpansFor = useCallback((text: string, spans: BlockInfo[]): CharSpan[] => {
    const cached = charSpansRef.current
    if (cached && cached.text === text) return cached.spans
    const computed = toCharSpans(text, spans)
    charSpansRef.current = { text, spans: computed }
    return computed
  }, [])

  /** 富文本实时改动 → 源码镜像（不写盘；源码已被手动改动时降级为原文） */
  const buildMirror = useCallback(() => {
    const file = currentFileRef.current
    const rows = blocksRef.current
    const spans = blockSpansRef.current
    if (!file?.text || !rows?.length || !spans || blocksStaleRef.current) {
      mirrorOffsetRef.current = null
      setMirrorText(null)
      return
    }
    const composed = composeBlockDraft(
      file.text,
      charSpansFor(file.text, spans),
      rows,
      blockEdits.current,
      deletedRef.current,
      insertsRef.current,
      insertHtmlRef.current,
    )
    // 没有实际改动时回到受控原文，避免无意义的整章重渲染
    if (composed.text === file.text) {
      mirrorOffsetRef.current = null
      setMirrorText(null)
    } else {
      mirrorOffsetRef.current = { toDraft: composed.toDraft, toBase: composed.toBase }
      setMirrorText(composed.text)
    }
  }, [charSpansFor])

  // 分屏对照：监听富文本画布里的所有 DOM 变更（打字 / 加粗 / 粘贴 / 翻译 / 删除），
  // 停顿 180ms 合入源码镜像，避免每敲一个字都重排整章。
  useEffect(() => {
    if (blockView !== 'split') return
    const page = blockPageRef.current
    if (!page) return
    let timer = 0
    const observer = new MutationObserver(() => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => { timer = 0; buildMirror() }, 180)
    })
    observer.observe(page, { subtree: true, childList: true, characterData: true, attributes: true })
    buildMirror()
    return () => {
      observer.disconnect()
      if (timer) window.clearTimeout(timer)
    }
  }, [blockView, currentFile?.relPath, blockVersion, blocks, buildMirror])

  // 分屏对照：富文本侧聚焦某段 → 源码光标落到该段 innerStart 并滚到可见处
  useEffect(() => {
    if (blockView !== 'split' || activeBlock == null) return
    const ta = splitSrcRef.current
    const file = currentFileRef.current
    const spans = blockSpansRef.current
    if (!ta || !file?.text || !spans) return
    if (document.activeElement === ta) return
    const span = charSpansFor(file.text, spans)[activeBlock]
    if (!span) return
    const target = mirrorOffsetRef.current ? mirrorOffsetRef.current.toDraft(span.innerStart) : span.innerStart
    ta.setSelectionRange(target, target)
    const line = file.text.slice(0, span.innerStart).split('\n').length - 1
    scrollLockRef.current = Date.now() + 150
    ta.scrollTop = Math.max(0, line * blockFont * 1.9 - ta.clientHeight / 3)
  }, [activeBlock, blockView, currentFile?.relPath, blockFont, charSpansFor])

  // 分屏对照：源码光标移动到哪段，富文本就高亮并滚到对应段
  const handleSourceCaret = useCallback(() => {
    const ta = splitSrcRef.current
    const file = currentFileRef.current
    const spans = blockSpansRef.current
    if (!ta || !file?.text || !spans) return
    const chars = charSpansFor(file.text, spans)
    const raw = ta.selectionStart
    const pos = mirrorOffsetRef.current ? mirrorOffsetRef.current.toBase(raw) : raw
    let idx = chars.findIndex(span => pos >= span.innerStart && pos <= span.innerEnd)
    if (idx < 0) {
      // 光标落在段落之间的空白（或镜像文本比原文长导致的偏移）时，归到前一个块
      for (let k = chars.length - 1; k >= 0; k -= 1) {
        if (pos >= chars[k].start) { idx = k; break }
      }
    }
    if (idx < 0) return
    setSrcActiveBlock(idx)
    const canvas = blockCanvasRef.current
    const page = blockPageRef.current
    if (!canvas || !page) return
    const el = page.querySelector(`[data-blk-index="${idx}"]`) as HTMLElement | null
    if (!el) return
    const top = el.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop - 24
    if (top < canvas.scrollTop || top + el.offsetHeight > canvas.scrollTop + canvas.clientHeight) {
      scrollLockRef.current = Date.now() + 160
      canvas.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    }
  }, [charSpansFor])

  // 分屏对照：左右按滚动比例双向联动（短时锁避免互相拉扯）
  useEffect(() => {
    if (blockView !== 'split') return
    const canvas = blockCanvasRef.current
    const ta = splitSrcRef.current
    if (!canvas || !ta) return
    // 进入分屏时先把源码侧对齐到富文本当前滚动位置
    const startSrcMax = canvas.scrollHeight - canvas.clientHeight
    const startDstMax = ta.scrollHeight - ta.clientHeight
    if (startSrcMax > 0 && startDstMax > 0 && canvas.scrollTop > 0) {
      scrollLockRef.current = Date.now() + 140
      ta.scrollTop = (canvas.scrollTop / startSrcMax) * startDstMax
    }
    const sync = (src: HTMLElement, dst: HTMLElement) => {
      if (Date.now() < scrollLockRef.current) return
      const srcMax = src.scrollHeight - src.clientHeight
      const dstMax = dst.scrollHeight - dst.clientHeight
      if (srcMax <= 0 || dstMax <= 0) return
      scrollLockRef.current = Date.now() + 60
      dst.scrollTop = (src.scrollTop / srcMax) * dstMax
    }
    const onCanvas = () => sync(canvas, ta)
    const onSource = () => sync(ta, canvas)
    canvas.addEventListener('scroll', onCanvas, { passive: true })
    ta.addEventListener('scroll', onSource, { passive: true })
    return () => {
      canvas.removeEventListener('scroll', onCanvas)
      ta.removeEventListener('scroll', onSource)
    }
  }, [blockView, currentFile?.relPath, blockVersion])

  useEffect(() => () => {
    if (previewTimer.current) window.clearTimeout(previewTimer.current)
  }, [])

  // ─── 阅读页带来的段落定位：预览渲染完成后滚到那一段 ───

  useEffect(() => {
    const idx = pendingBlockRef.current
    if (idx == null || !blocks) return
    pendingBlockRef.current = null
    const canvas = blockCanvasRef.current
    const page = blockPageRef.current
    if (!canvas || !page) return
    const el = page.children[idx] as HTMLElement | undefined
    if (!el) return
    // 定位的目标段就是当前段；几何测量等重排稳定后再接管
    visibleBlockRef.current = idx
    measureSuppressedRef.current = true
    window.setTimeout(() => { measureSuppressedRef.current = false }, 1500)
    const top = el.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop - 16
    canvas.scrollTop = Math.max(0, top)
    el.classList.add('blk-focus')
    window.setTimeout(() => el.classList.remove('blk-focus'), 1600)
  }, [blocks])

  // ─── 位置回报：当前文件 / 当前段落变化时同步给外层，供三档接力 ───

  useEffect(() => {
    if (!currentFile) return
    const blockIndex = activeBlock
      ?? visibleBlockRef.current
      ?? (typeof initialBlock === 'number' ? initialBlock : undefined)
    onContextRef.current?.({ relPath: currentFile.relPath, blockIndex })
  }, [currentFile, activeBlock])

  // 段落视图滚动时记录当前可见块：切到锻造档按它对齐同一段
  useEffect(() => {
    const canvas = blockCanvasRef.current
    const page = blockPageRef.current
    const relPath = currentFile?.relPath
    if (!canvas || !page || !relPath) return
    let raf = 0
    const measure = () => {
      raf = 0
      if (measureSuppressedRef.current) return
      const top = canvas.getBoundingClientRect().top + 8
      let best = 0
      // 取视口顶部正在阅读的那一段：最后一个顶边越过视口顶的块
      for (let i = 0; i < page.children.length; i += 1) {
        if (page.children[i].getBoundingClientRect().top <= top) best = i
        else break
      }
      visibleBlockRef.current = best
      onContextRef.current?.({ relPath, blockIndex: best })
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    canvas.addEventListener('scroll', onScroll, { passive: true })
    measure()
    return () => {
      canvas.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [blocks, currentFile?.relPath])

  // ─── 划词译文送进编辑：段落视图就绪后替换到目标段落，变成可编辑草稿 ───

  useEffect(() => {
    if (translationSeededRef.current || !pendingTranslation || !blocks) return
    translationSeededRef.current = true
    const idx = typeof pendingTranslation.blockIndex === 'number'
      ? pendingTranslation.blockIndex
      : (typeof initialBlock === 'number' ? initialBlock : null)
    if (idx == null || !blocks[idx]) {
      onNotify('没能定位到原文段落：已定位到章节，请在段落视图里手动选择要替换的段')
      return
    }
    const sanitized = sanitizeInline(pendingTranslation.translation)
    const beforeHtml = blockEdits.current[idx] ?? blocks[idx].html
    setTranslatedOrigin(prev => (prev[idx] ? prev : { ...prev, [idx]: beforeHtml }))
    blockEdits.current[idx] = sanitized.xml
    setBlocks(prev => prev
      ? prev.map((row, i) => (i === idx ? { ...row, html: sanitized.xml } : row))
      : prev)
    setBlockDirty(true)
    setActiveBlock(idx)
    pendingBlockRef.current = idx
    onNotify('已把划词译文放进该段，可直接修改；应用改动后写回')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTranslation, blocks])

  // ─── 阅读时的划词译文草稿：打开章节后自动铺进对应段落，成为可编辑草稿 ───

  useEffect(() => {
    if (!bookId || !currentFile || !blocks) return
    const relPath = currentFile.relPath
    const pendingIdx = typeof pendingTranslation?.blockIndex === 'number'
      ? pendingTranslation.blockIndex
      : null
    const nextEdits: Record<number, string> = {}
    const nextOrigins: Record<number, string> = {}
    const nextCfis: string[] = []
    for (const draft of Object.values(draftsRef.current)) {
      if (!samePath(draft.relPath, relPath)) continue
      const idx = draft.block
      if (typeof idx !== 'number' || !blocks[idx]) continue
      // 已送进编辑的那段由主流程接管，不重复覆盖
      if (pendingIdx === idx) continue
      if (blockEdits.current[idx] !== undefined || translatedOrigin[idx] !== undefined) continue
      // 原文校验：块文字已被改过就不再自动套用，避免覆盖人工改动
      const current = blockPlainText(blocks[idx].html)
      const expected = (draft.blockText ?? '').replace(/\s+/g, ' ').trim()
      if (!current) continue
      if (expected) {
        if (current !== expected) continue
      } else {
        const snippet = draft.text.replace(/\s+/g, ' ').trim().slice(0, 16)
        if (!snippet || !current.includes(snippet)) continue
      }
      const sanitized = sanitizeInline(draft.translation)
      nextOrigins[idx] = blocks[idx].html
      nextEdits[idx] = sanitized.xml
      nextCfis.push(draft.cfi)
    }
    const applied = Object.keys(nextEdits).length
    if (!applied) return
    nextCfis.forEach(cfi => appliedDraftCfisRef.current.add(cfi))
    Object.assign(blockEdits.current, nextEdits)
    setTranslatedOrigin(prev => ({ ...prev, ...nextOrigins }))
    setBlocks(prev => prev
      ? prev.map((row, i) => (nextEdits[i] !== undefined ? { ...row, html: nextEdits[i] } : row))
      : prev)
    setBlockDirty(true)
    onNotify(`已带入 ${applied} 段阅读时的译文草稿，可直接修改；保存后写回本书`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, currentFile?.relPath, draftTick])

  // ─── 文件树跟随当前文件（自动定位时不把高亮项留在视口外） ───

  useEffect(() => {
    const tree = treeRef.current
    const active = tree?.querySelector('li.active') as HTMLElement | null
    if (!tree || !active) return
    const treeBox = tree.getBoundingClientRect()
    const box = active.getBoundingClientRect()
    if (box.top >= treeBox.top && box.bottom <= treeBox.bottom) return
    const top = box.top - treeBox.top + tree.scrollTop
    tree.scrollTop = Math.max(0, top - tree.clientHeight / 2 + active.offsetHeight / 2)
  }, [currentFile?.relPath])

  // ─── Ctrl+滚轮字号（源码框 / 目录条目框，各自独立） ───

  useEffect(() => {
    const el = tocListRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      setTocFont(f => clamp(f + (e.deltaY > 0 ? -1 : 1), 9, 26))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [tab])

  useEffect(() => {
    const el = blockCanvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      setBlockFont(f => clamp(f + (e.deltaY > 0 ? -1 : 1), 11, 34))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [tab, currentFile?.relPath, blockView])

  useEffect(() => {
    const el = splitSrcRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      // 正文文件的源码框与富文本共用字号，保证分屏两侧大小接近
      if (blocksRef.current?.length) setBlockFont(f => clamp(f + (e.deltaY > 0 ? -1 : 1), 11, 34))
      else setSrcFont(f => clamp(f + (e.deltaY > 0 ? -1 : 1), 9, 28))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [tab, currentFile?.relPath, blockView])

  // ─── E3：目录树编辑 ───

  const rows = useMemo(() => {
    const out: Row[] = []
    const walk = (list: TocNode[], prefix: NodePath, depth: number) => {
      list.forEach((n, i) => {
        const p = [...prefix, i]
        const key = p.join('.')
        out.push({ node: n, path: p, depth, key })
        if (!collapsed.has(key)) walk(n.children, p, depth + 1)
      })
    }
    walk(toc, [], 0)
    return out
  }, [toc, collapsed])

  const allRows = useMemo(() => {
    const out: Row[] = []
    const walk = (list: TocNode[], prefix: NodePath, depth: number) => {
      list.forEach((n, i) => {
        const p = [...prefix, i]
        out.push({ node: n, path: p, depth, key: p.join('.') })
        walk(n.children, p, depth + 1)
      })
    }
    walk(toc, [], 0)
    return out
  }, [toc])

  const chapterFiles = useMemo(
    () => entries.filter(e => e.mediaType === 'application/xhtml+xml').map(e => e.path),
    [entries],
  )

  const changeLabel = (p: NodePath, label: string) =>
    setToc(prev => updateAt(prev, p, n => ({ ...n, label })))

  const changeTarget = (p: NodePath, href: string) =>
    setToc(prev => updateAt(prev, p, n => ({ ...n, href })))

  const clearSel = () => { setSelected(new Set()); setLastSelected(null) }

  const indentNode = (p: NodePath) => setToc(prev => withSiblings(prev, p, list => {
    const i = p[p.length - 1]
    if (i === 0) return list
    const node = list[i]
    const copy = [...list]
    copy[i - 1] = { ...copy[i - 1], children: [...copy[i - 1].children, node] }
    copy.splice(i, 1)
    return copy
  }))

  const outdentNode = (p: NodePath) => setToc(prev => {
    if (p.length < 2) return prev
    const node = getNode(prev, p)
    if (!node) return prev
    const parentPath = p.slice(0, -1)
    const parentIndex = parentPath[parentPath.length - 1]
    const without = removeAt(prev, p)
    return withChildren(without, parentPath, list => {
      const copy = [...list]
      copy.splice(parentIndex + 1, 0, node)
      return copy
    })
  })

  const addSibling = (p: NodePath) => setToc(prev => withSiblings(prev, p, list => {
    const copy = [...list]
    copy.splice(p[p.length - 1] + 1, 0, { label: '新条目', href: '', children: [] })
    return copy
  }))

  const addChild = (p: NodePath) => setToc(prev => updateAt(prev, p, n => ({
    ...n,
    children: [...n.children, { label: '新条目', href: '', children: [] }],
  })))

  const addRoot = (isGroup: boolean) => {
    setToc(prev => [...prev, { label: isGroup ? '新分组' : '新条目', href: '', children: [] }])
    clearSel()
  }

  const deleteNode = (p: NodePath) => { setToc(prev => removeAt(prev, p)); clearSel() }

  const reachable = (n: TocNode): boolean => n.href !== '' || n.children.some(c => reachable(c))

  const handleWriteToc = useCallback(async () => {
    if (!workspace) return
    if (!toc.length) { setError('目录为空，无法写回'); return }
    const bad = allRows.find(r => !reachable(r.node))
    if (bad) {
      setError(`「${bad.node.label}」没有任何可跳转目标，请给它指定章节或删除`)
      return
    }
    setTocBusy(true); setError('')
    try {
      const doc = await invoke<TocDocument>('edit_write_toc', {
        editDir: workspace.editDir, opfPath: workspace.opfPath,
        tree: toc, syncSpine: true,
      })
      setToc(doc.tree)
      setTocIssues(doc.issues)
      onNotify(doc.issues.length
        ? `目录已写回，但有 ${doc.issues.length} 条提示`
        : '目录已写回 nav + ncx，spine 顺序已同步')
    } catch (err) {
      setError(`写回目录失败：${String(err)}`)
    } finally {
      setTocBusy(false)
    }
  }, [workspace, toc, allRows, onNotify])

  const handleRenameFile = useCallback(async () => {
    if (!workspace || !renaming) return
    const next = renameValue.trim()
    if (!next) { setError('文件名不能为空'); return }
    const dir = renaming.includes('/') ? renaming.slice(0, renaming.lastIndexOf('/')) : ''
    const to = dir ? `${dir}/${next}` : next
    if (to === renaming) { setRenaming(''); return }
    setTocBusy(true); setError('')
    try {
      const changed = await invoke<string[]>('edit_rename_file', {
        editDir: workspace.editDir, opfPath: workspace.opfPath,
        fromPath: renaming, toPath: to,
      })
      const doc = await invoke<TocDocument>('edit_read_toc', {
        editDir: workspace.editDir, opfPath: workspace.opfPath,
      })
      const list = await invoke<EntryInfo[]>('edit_list_files', { editDir: workspace.editDir })
      setEntries(list)
      setWorkspace({ ...workspace, entries: list })
      setToc(doc.tree)
      setTocIssues(doc.issues)
      setRenaming('')
      onNotify(`已重命名为 ${next}，同步 ${changed.length} 个引用文件`)
    } catch (err) {
      setError(`重命名失败：${String(err)}`)
    } finally {
      setTocBusy(false)
    }
  }, [workspace, renaming, renameValue, onNotify])

  const handleScan = useCallback(async () => {
    if (!workspace) return
    setTocBusy(true); setError(''); setScan(null)
    try {
      const r = await invoke<ScanReport>('edit_scan_report', {
        editDir: workspace.editDir, opfPath: workspace.opfPath,
      })
      setScan(r)
      onNotify(`扫描完成：未用图片 ${r.unusedImages.length} / 孤儿文件 ${r.orphanFiles.length} / 重复 id ${r.duplicateIds.length} / 断链 ${r.brokenLinks.length}`)
    } catch (err) {
      setError(`扫描失败：${String(err)}`)
    } finally {
      setTocBusy(false)
    }
  }, [workspace, onNotify])

  // ─── S9：文件级操作（新建 / 重命名 / 移动 / 删除） ───

  /** 操作后刷新文件树与目录，必要时重新打开文件（删除则清空） */
  const refreshFiles = useCallback(async (focus?: string) => {
    if (!workspace) return
    const [list, doc] = await Promise.all([
      invoke<EntryInfo[]>('edit_list_files', { editDir: workspace.editDir }),
      invoke<TocDocument>('edit_read_toc', { editDir: workspace.editDir, opfPath: workspace.opfPath }),
    ])
    setEntries(list)
    setWorkspace(w => (w ? { ...w, entries: list } : w))
    setToc(doc.tree)
    setTocIssues(doc.issues)
    if (focus) {
      const hit = list.find(e => e.path === focus)
      if (hit) {
        const content = await invoke<FileContent>('edit_read_file', {
          editDir: workspace.editDir, relPath: hit.path,
        })
        setCurrentFile(content)
        setDirty(false)
        setBlockDirty(false)
      }
    } else if (currentFile && !list.some(e => e.path === currentFile.relPath)) {
      setCurrentFile(null)
      setDirty(false)
      setBlockDirty(false)
    }
  }, [workspace, currentFile])

  const startFileOp = (kind: FileOpKind) => {
    if (!workspace) return
    if (dirty || blockDirty) {
      onNotify('当前文件有未保存改动，请先保存再做文件级操作')
      return
    }
    if (kind !== 'create' && !currentFile) {
      onNotify('先在文件树里选一个文件')
      return
    }
    setError('')
    setPendingFileOp(null)
    const dir = currentFile && currentFile.relPath.includes('/')
      ? currentFile.relPath.slice(0, currentFile.relPath.lastIndexOf('/'))
      : ''
    setFileOp({
      kind,
      value: kind === 'create'
        ? (dir ? `${dir}/chapter-new.xhtml` : 'chapter-new.xhtml')
        : kind === 'rename' ? baseName(currentFile!.relPath) : currentFile!.relPath,
      title: kind === 'create' ? '新章节' : undefined,
    })
  }

  const submitFileOp = useCallback(async () => {
    if (!workspace || !fileOp || !currentFile && fileOp.kind !== 'create') return
    const value = fileOp.value.trim()
    if (!value) { setError('文件名不能为空'); return }
    setTocBusy(true); setError('')
    try {
      if (fileOp.kind === 'create') {
        const r = await invoke<FileOpResult>('edit_create_chapter', {
          editDir: workspace.editDir, opfPath: workspace.opfPath,
          relPath: value, title: fileOp.title ?? '',
        })
        setFileOp(null)
        await refreshFiles(r.relPath)
        onNotify(`已新建章节 ${r.relPath}（manifest ${r.addedManifest ? '✓' : '×'} / spine ${r.addedSpine ? '✓' : '×'} / 目录 ${r.addedToc ? '✓' : '×'}）`)
        return
      }
      const from = currentFile!.relPath
      const to = fileOp.kind === 'rename'
        ? (from.includes('/') ? `${from.slice(0, from.lastIndexOf('/'))}/${value}` : value)
        : value
      if (to === from) { setFileOp(null); return }
      const impact = await invoke<FileImpact>('edit_file_impact', {
        editDir: workspace.editDir, opfPath: workspace.opfPath, relPath: from,
      })
      setPendingFileOp({ kind: fileOp.kind, from, to, impact })
      setFileOp(null)
    } catch (err) {
      setError(`文件操作失败：${String(err)}`)
    } finally {
      setTocBusy(false)
    }
  }, [workspace, fileOp, currentFile, refreshFiles, onNotify])

  const askDeleteFile = useCallback(async () => {
    if (!workspace || !currentFile) { onNotify('先在文件树里选一个文件'); return }
    if (dirty || blockDirty) { onNotify('当前文件有未保存改动，请先保存'); return }
    setTocBusy(true); setError('')
    try {
      const impact = await invoke<FileImpact>('edit_file_impact', {
        editDir: workspace.editDir, opfPath: workspace.opfPath, relPath: currentFile.relPath,
      })
      setFileOp(null)
      setPendingFileOp({ kind: 'delete', from: currentFile.relPath, impact })
    } catch (err) {
      setError(`读取影响面失败：${String(err)}`)
    } finally {
      setTocBusy(false)
    }
  }, [workspace, currentFile, dirty, blockDirty, onNotify])

  const confirmFileOp = useCallback(async () => {
    if (!workspace || !pendingFileOp) return
    setTocBusy(true); setError('')
    try {
      if (pendingFileOp.kind === 'delete') {
        const r = await invoke<FileOpResult>('edit_delete_file', {
          editDir: workspace.editDir, opfPath: workspace.opfPath, relPath: pendingFileOp.from,
        })
        setPendingFileOp(null)
        await refreshFiles()
        onNotify(`已删除 ${r.relPath}，同步 ${r.changedFiles.length} 个文件`)
      } else {
        const changed = await invoke<string[]>('edit_rename_file', {
          editDir: workspace.editDir, opfPath: workspace.opfPath,
          fromPath: pendingFileOp.from, toPath: pendingFileOp.to,
        })
        const to = pendingFileOp.to as string
        setPendingFileOp(null)
        await refreshFiles(to)
        onNotify(`已${pendingFileOp.kind === 'move' ? '移动' : '重命名'}为 ${to}，同步 ${changed.length} 个引用文件`)
      }
    } catch (err) {
      setError(`文件操作失败：${String(err)}`)
    } finally {
      setTocBusy(false)
    }
  }, [workspace, pendingFileOp, refreshFiles, onNotify])

  // ─── 多选 / 批量操作 ───

  const toggleSelect = (key: string, shift: boolean) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (shift && lastSelected) {
        const a = rows.findIndex(r => r.key === lastSelected)
        const b = rows.findIndex(r => r.key === key)
        if (a >= 0 && b >= 0) {
          const lo = Math.min(a, b), hi = Math.max(a, b)
          for (let i = lo; i <= hi; i += 1) next.add(rows[i].key)
          return next
        }
      }
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    setLastSelected(key)
  }

  const selPaths = () => rows.filter(r => selected.has(r.key)).map(r => r.path)
  const firstSel = (): Row | null => rows.find(r => selected.has(r.key)) ?? null

  /** 目录结构 → 打开选中项指向的正文文件，并切到段落视图继续编辑 */
  const openSelectedTarget = () => {
    const one = firstSel()
    if (!one || selected.size !== 1) return
    const target = findEntryByHref(entries, one.node.href)
    if (!target) {
      onNotify('这一项目录没有可打开的正文文件')
      return
    }
    void handleSelect(target).then(() => setTab('blocks'))
  }

  const moveSelected = (delta: number) => {
    if (!selected.size) return
    const paths = selPaths()
    setToc(prev => batchShift(prev, paths, delta))
    clearSel()
  }

  const deleteSelected = () => {
    if (!selected.size) return
    const paths = selPaths()
    setToc(prev => filterTree(prev, paths))
    clearSel()
  }

  const indentSelected = () => {
    const one = firstSel()
    if (!one || selected.size !== 1) return
    indentNode(one.path)
    clearSel()
  }

  const outdentSelected = () => {
    const one = firstSel()
    if (!one || selected.size !== 1) return
    outdentNode(one.path)
    clearSel()
  }

  const addSiblingSelected = () => {
    const one = firstSel()
    if (one) addSibling(one.path)
    else addRoot(false)
    clearSel()
  }

  const addChildSelected = () => {
    const one = firstSel()
    if (one) addChild(one.path)
    else addRoot(false)
    clearSel()
  }

  const renameSelected = () => {
    const one = firstSel()
    if (!one?.node.href) return
    setRenaming(stripFrag(one.node.href))
    setRenameValue(stripFrag(one.node.href).split('/').pop() ?? '')
  }

  const applyTarget = (path: string) => {
    if (!selected.size) return
    const paths = selPaths()
    setToc(prev => paths.reduce((acc, p) => updateAt(acc, p, n => ({ ...n, href: path })), prev))
    setPickerOpen(false)
  }

  const openPicker = () => {
    if (!selected.size) return
    setPickerQuery('')
    setPickerPos({
      x: Math.max(16, Math.round(window.innerWidth / 2 - 190)),
      y: 120,
    })
    setPickerOpen(true)
  }

  // 弹窗拖动
  useEffect(() => {
    if (!pickerOpen) return
    const move = (e: PointerEvent) => {
      const d = pickerDragRef.current
      if (!d) return
      setPickerPos({
        x: clamp(e.clientX - d.offX, 0, window.innerWidth - 120),
        y: clamp(e.clientY - d.offY, 0, window.innerHeight - 60),
      })
    }
    const up = () => { pickerDragRef.current = null }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [pickerOpen])

  const startPickerDrag = (e: ReactPointerEvent) => {
    const box = (e.currentTarget as HTMLElement).closest('.toc-picker') as HTMLElement | null
    if (!box) return
    const r = box.getBoundingClientRect()
    pickerDragRef.current = { offX: e.clientX - r.left, offY: e.clientY - r.top }
  }

  // ─── 拖拽排序（同层） ───

  useEffect(() => {
    if (!dragKey) return
    const move = (e: PointerEvent) => {
      const hit = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)
        ?.closest('[data-toc-key]') as HTMLElement | null
      if (!hit) { dropHintRef.current = null; setDropHint(null); return }
      const key = hit.dataset.tocKey ?? ''
      const rect = hit.getBoundingClientRect()
      const hint = { key, after: e.clientY > rect.top + rect.height / 2 }
      dropHintRef.current = hint
      setDropHint(hint)
    }
    const up = () => {
      const hint = dropHintRef.current
      if (hint && dragKey) {
        const src = dragKey.split('.').map(Number)
        const tgt = hint.key.split('.').map(Number)
        if (src.slice(0, -1).join('.') !== tgt.slice(0, -1).join('.')) {
          onNotify('只能在同一个层级内拖动排序')
        } else {
          setToc(tree => reorderSiblings(tree, src, tgt, hint.after, selected))
          clearSel()
        }
      }
      dropHintRef.current = null
      setDropHint(null)
      setDragKey(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [dragKey, selected, onNotify])

  // ─── 快捷键 Ctrl+S ───

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void handleWrite()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [handleWrite])

  // ─── 关闭（带脏检查） ───

  const handleClose = () => {
    if ((dirty || blockDirty) && !confirm('有未保存改动，确定关闭编辑器？')) return
    onClose()
  }

  const pickerFiles = chapterFiles.filter(f => pickerQuery.trim()
    ? f.toLowerCase().includes(pickerQuery.trim().toLowerCase())
    : true)

  // 编辑对象类型随当前文件变化（EPUB / TXT / FB2 …），不写死
  const fileKind = (epubPath.split('.').pop() || 'epub').toUpperCase()

  // 能分块才允许富文本 / 分屏；非正文文件（css / opf / ncx）强制源码模式
  const blockable = Boolean(blocks && blocks.length)
  const view: BlockView = blockable ? blockView : 'source'
  const sourceText = view === 'split' && mirrorText !== null ? mirrorText : (currentFile?.text ?? '')
  const sourceFontSize = blockable ? blockFont : srcFont

  // 阅读标注只读渲染：富文本 / 分屏的富文本侧画高亮，源码视图不画
  useEffect(() => {
    if (view === 'source') {
      clearChapterMarks()
      return
    }
    const canvas = blockCanvasRef.current
    if (!canvas || !currentFile) {
      clearChapterMarks()
      return
    }
    const relPath = currentFile.relPath
    const raf = requestAnimationFrame(() => {
      applyChapterMarks(collectChapterMarks(canvas, annotations, relPath))
    })
    return () => cancelAnimationFrame(raf)
  }, [view, blocks, annotations, currentFile?.relPath])

  // 关闭编辑器时清掉全局高亮注册表，避免带到阅读页
  useEffect(() => () => clearChapterMarks(), [])

  // 嵌入阅读器时把工具栏状态交出去：顶栏渲染唯一的按钮行
  useEffect(() => {
    if (!onToolbar) return
    onToolbar({
      tab,
      setTab,
      dirty: dirty || metaDirty || blockDirty,
      saving,
      checking,
      hasWorkspace: Boolean(workspace),
      treeOpen,
      toggleTree: () => setTreeOpen((value) => !value),
      actions: {
        history: () => void openRevisions(),
        write: () => void handleWrite(),
        save: () => void handleSave(),
        saveAs: () => void handleSaveAs(),
        check: () => void handleCheck(),
      },
    })
  })
  useEffect(() => {
    return () => onToolbar?.(null)
  }, [onToolbar])

  const tabButtons = (
    <>
      <button className={`edit-tab ${tab === 'blocks' ? 'on' : ''}`} onClick={() => setTab('blocks')}>
        <Icon name="article" size={15} /> 段落
      </button>
      <button className={`edit-tab ${tab === 'meta' ? 'on' : ''}`} onClick={() => setTab('meta')}>
        <Icon name="sell" size={15} /> 元数据
      </button>
      <button
        className={`edit-tab ${tab === 'toc' ? 'on' : ''}`}
        data-tip="目录结构：编辑 nav.xhtml / toc.ncx 与 spine 顺序"
        onClick={() => setTab('toc')}
      >
        <Icon name="account_tree" size={15} /> 目录结构
      </button>
    </>
  )

  const actionButtons = (
    <>
      <button className="btn icon-only" title="历史版本（保存时的 EPUB 快照）" onClick={() => void openRevisions()} disabled={!workspace}>
        <Icon name="history" />
      </button>
      <button className="btn icon-only" title="写回当前文件 (Ctrl+S)" onClick={() => void handleWrite()} disabled={!(dirty || blockDirty)}>
        <Icon name="save" />
      </button>
      <button className="btn icon-only" title="保存并重打包（覆盖原文件）" onClick={() => void handleSave()} disabled={saving}>
        <Icon name="archive" />
      </button>
      <button className="btn icon-only" title="另存为（默认到最终成品文件夹）" onClick={() => void handleSaveAs()} disabled={saving}>
        <Icon name="save_as" />
      </button>
      <button className="btn icon-only" title="epubcheck 检查" onClick={() => void handleCheck()} disabled={checking}>
        <Icon name="fact_check" />
      </button>
      {!embedded && (
        <button className="btn icon-only" title="关闭编辑，回到阅读" onClick={handleClose}>
          <Icon name="close" />
        </button>
      )}
    </>
  )

  return (
    <div
      className="edit-panel"
      onKeyDown={event => {
        if (tab !== 'blocks') return
        // 源码框里让浏览器走原生撤销，不要被段落级撤销栈接管
        if ((event.target as HTMLElement | null)?.tagName === 'TEXTAREA') return
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) redoBlocks()
        else undoBlocks()
      }}
    >
      {/* 嵌入模式不再自带头部：标签、文件树开关与操作按钮全部交给阅读器顶栏一行 */}
      {!embedded && (
        <>
          <header className="edit-panel__head">
            <button className="btn icon-only" title="回到阅读模式" onClick={handleClose}>
              <Icon name="arrow_back" />
            </button>
            <span className="edit-panel__title">
              编辑 {fileKind} {(dirty || metaDirty || blockDirty) && <span className="edit-dirty">●</span>}
            </span>
            <span className="edit-panel__sub">{workspace ? baseName(workspace.originPath) : ''}</span>
            <div className="edit-panel__actions">{actionButtons}</div>
          </header>

          <div className="edit-panel__tabs">
            {tabButtons}
          </div>
        </>
      )}

      {loading && <div className="edit-panel__loading">正在解包…</div>}
      {error && <div className="edit-panel__error">{error}</div>}

      {!loading && workspace && tab === 'meta' && (
        <div className="meta-form">
          <div className="meta-cover">
            <div className="meta-cover__box">
              {coverPreview
                ? <img src={coverPreview} alt="封面预览" />
                : <span className="meta-cover__empty">暂无封面</span>}
            </div>
            <div className="meta-cover__side">
              <button className="btn small" onClick={() => void handleChooseCover()}>选择图片…</button>
              {coverPath
                ? <span className="meta-cover__name">已选：{baseName(coverPath)}（写回时替换）</span>
                : <span className="meta-cover__name">支持 JPG / PNG / WebP，写回后点顶部「打包」生效</span>}
            </div>
          </div>

          <label className="meta-row">
            <span className="meta-row__label">书名</span>
            <input value={metaTitle} onChange={e => setMetaTitle(e.target.value)} placeholder="dc:title" />
          </label>
          <label className="meta-row">
            <span className="meta-row__label">作者</span>
            <input value={metaCreator} onChange={e => setMetaCreator(e.target.value)} placeholder="dc:creator（可留空）" />
          </label>
          <label className="meta-row">
            <span className="meta-row__label">语言</span>
            <input
              value={metaLang}
              list="sf-lang-list"
              onChange={e => setMetaLang(e.target.value)}
              placeholder="zh-CN / en / ja …"
            />
            <datalist id="sf-lang-list">
              {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </datalist>
          </label>
          <div className="meta-row">
            <span className="meta-row__label">标识符</span>
            <code className="meta-id">{workspace.metadata.identifier || '（无）'}</code>
          </div>

          <div className="meta-actions">
            <button className="btn primary" onClick={() => void handleSaveMeta()} disabled={savingMeta}>
              写回元数据
            </button>
            <button className="btn" onClick={() => void handleSave()} disabled={saving}>
              保存并重打包
            </button>
          </div>
          <p className="meta-note">
            只改 EPUB 内部元数据（阅读器信息 / 导出 / 分享时可见）；书架显示的书名来自文件名，不受影响。
            写回后仍可「另存为」到最终成品文件夹。
          </p>
        </div>
      )}

      {!loading && workspace && tab === 'toc' && (
        <div className="toc-editor">
          <div className="toc-toolbar">
            <span className="toc-stat">
              条目 {countNodes(toc)} · 层级 {depthOf(toc)} · 已选 {selected.size}
              {tocIssues.length > 0 && <span className="toc-warn"> · {tocIssues.length} 提示</span>}
            </span>

            <button
              className="toc-tool"
              data-tip={selected.size === rows.length && rows.length > 0 ? '取消全选' : '全选可见条目'}
              aria-label="全选"
              onClick={() => {
                if (selected.size === rows.length && rows.length > 0) clearSel()
                else setSelected(new Set(rows.map(r => r.key)))
              }}
            >
              <Icon name={selected.size === rows.length && rows.length > 0 ? 'check_box' : 'check_box_outline_blank'} size={15} />
            </button>
            <button className="toc-tool" data-tip="折叠全部层级" aria-label="折叠全部" onClick={() => setCollapsed(new Set(allRows.filter(r => r.node.children.length > 0).map(r => r.key)))}>
              <Icon name="unfold_less" size={15} />
            </button>
            <button className="toc-tool" data-tip="展开全部层级" aria-label="展开全部" onClick={() => setCollapsed(new Set())}>
              <Icon name="unfold_more" size={15} />
            </button>

            <span className="toc-sep" />

            <button className="toc-tool" data-tip="选中条目整体上移" aria-label="上移" disabled={!selected.size} onClick={() => moveSelected(-1)}>
              <Icon name="arrow_upward" size={15} />
            </button>
            <button className="toc-tool" data-tip="选中条目整体下移" aria-label="下移" disabled={!selected.size} onClick={() => moveSelected(1)}>
              <Icon name="arrow_downward" size={15} />
            </button>
            <button className="toc-tool" data-tip="降为上一项的子项（单选）" aria-label="降级" disabled={selected.size !== 1} onClick={indentSelected}>
              <Icon name="subdirectory_arrow_right" size={15} />
            </button>
            <button className="toc-tool" data-tip="升一级（单选）" aria-label="升级" disabled={selected.size !== 1} onClick={outdentSelected}>
              <Icon name="subdirectory_arrow_left" size={15} />
            </button>
            <button className="toc-tool" data-tip="在选中项下方新增同级" aria-label="新增同级" onClick={addSiblingSelected}>
              <Icon name="add" size={15} />
            </button>
            <button className="toc-tool" data-tip="给选中项新增子条目" aria-label="新增子条目" onClick={addChildSelected}>
              <Icon name="playlist_add" size={15} />
            </button>
            <button className="toc-tool" data-tip="为选中项指定跳转章节（弹窗可拖动）" aria-label="设置目标" disabled={!selected.size} onClick={openPicker}>
              <Icon name="link" size={15} />
            </button>
            <button className="toc-tool" data-tip="重命名目标文件（同步 OPF/nav/ncx/书内链接）" aria-label="重命名文件" disabled={selected.size !== 1 || !firstSel()?.node.href} onClick={renameSelected}>
              <Icon name="drive_file_rename_outline" size={15} />
            </button>
            <button className="toc-tool" data-tip="打开选中项对应的正文文件（切到段落视图）" aria-label="打开对应文件" disabled={selected.size !== 1 || !firstSel()?.node.href} onClick={openSelectedTarget}>
              <Icon name="open_in_new" size={15} />
            </button>
            <button className="toc-tool danger" data-tip="删除选中条目" aria-label="删除" disabled={!selected.size} onClick={deleteSelected}>
              <Icon name="delete" size={15} />
            </button>

            <span className="toc-sep" />

            <button className="toc-tool primary" onClick={() => void handleWriteToc()} disabled={tocBusy}>写回目录（nav + ncx）</button>
            <button className="toc-tool" onClick={() => void handleScan()} disabled={tocBusy}>全书扫描</button>
          </div>

          {tocIssues.length > 0 && (
            <div className="toc-issues">
              {tocIssues.map((m, i) => <div key={i}>· {m}</div>)}
            </div>
          )}

          <div
            className={`toc-tree ${dragKey ? 'dragging' : ''}`}
            ref={tocListRef}
            style={{ '--toc-font': `${tocFont}px` } as CSSProperties}
          >
            {rows.map(({ node, path, depth, key }) => {
              const hasKids = node.children.length > 0
              const isSel = selected.has(key)
              const hint = dropHint?.key === key ? (dropHint.after ? 'drop-after' : 'drop-before') : ''
              return (
                <div
                  className={`toc-row ${isSel ? 'sel' : ''} ${dragKey === key ? 'drag-src' : ''} ${hint}`}
                  key={key}
                  data-toc-key={key}
                  style={{ paddingLeft: `${4 + depth * 18}px` }}
                >
                  <button
                    className="toc-grip"
                    data-tip="按住拖动，同层排序"
                    aria-label="拖动排序"
                    onPointerDown={e => {
                      e.preventDefault()
                      setDragKey(key)
                    }}
                  >
                    <Icon name="drag_indicator" size={14} />
                  </button>
                  <input
                    type="checkbox"
                    className="toc-check"
                    checked={isSel}
                    onChange={e => toggleSelect(key, (e.nativeEvent as MouseEvent).shiftKey)}
                    aria-label={`选择「${node.label}」`}
                  />
                  {hasKids ? (
                    <button
                      className="toc-caret"
                      data-tip={collapsed.has(key) ? '展开子项' : '收起子项'}
                      aria-label={collapsed.has(key) ? '展开' : '收起'}
                      onClick={() => {
                        setCollapsed(prev => {
                          const next = new Set(prev)
                          if (next.has(key)) next.delete(key)
                          else next.add(key)
                          return next
                        })
                      }}
                    >
                      <Icon name={collapsed.has(key) ? 'expand_more' : 'expand_less'} size={14} />
                    </button>
                  ) : (
                    <span className="toc-caret ghost" />
                  )}
                  <div className="toc-main">
                    <textarea
                      className="toc-label"
                      rows={1}
                      value={node.label}
                      onChange={e => changeLabel(path, e.target.value)}
                      onKeyDown={e => {
                        // 标题不允许多行：回车直接结束编辑
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          ;(e.currentTarget as HTMLTextAreaElement).blur()
                        }
                      }}
                      placeholder="目录标题"
                    />
                    <select
                      className="toc-target"
                      value={stripFrag(node.href)}
                      onChange={e => changeTarget(path, e.target.value)}
                    >
                      <option value="">（分组标题，不跳转）</option>
                      {chapterFiles.map(f => <option key={f} value={f}>{baseName(f)}</option>)}
                      {node.href && !chapterFiles.includes(stripFrag(node.href)) && (
                        <option value={stripFrag(node.href)}>{stripFrag(node.href)}（不在清单）</option>
                      )}
                    </select>
                  </div>
                </div>
              )
            })}
            {rows.length === 0 && <div className="toc-empty">目录为空，点工具栏「+ 新增」开始</div>}
          </div>

          <div className="toc-side">
            {renaming && (
              <div className="toc-rename">
                <span>重命名 {renaming}</span>
                <input
                  value={renameValue}
                  onChange={e => setRenameValue(e.target.value)}
                  placeholder="新文件名（同目录）"
                  onKeyDown={e => { if (e.key === 'Enter') void handleRenameFile() }}
                />
                <button className="btn small primary" onClick={() => void handleRenameFile()} disabled={tocBusy}>确定</button>
                <button className="btn small" onClick={() => setRenaming('')}>取消</button>
              </div>
            )}

            {scan && (
              <div className="toc-scan">
                <div className="toc-scan__head">
                  全书扫描结果
                  <button className="btn small icon-only" title="关闭扫描结果" onClick={() => setScan(null)}>
                    <Icon name="close" size={13} />
                  </button>
                </div>
                <ScanGroup title="未使用图片" items={scan.unusedImages} />
                <ScanGroup title="孤儿文件（未在 manifest 声明）" items={scan.orphanFiles} />
                <ScanGroup title="重复 id" items={scan.duplicateIds} />
                <ScanGroup title="断链" items={scan.brokenLinks} />
                <ScanGroup title="目录与 spine 顺序不一致" items={scan.tocSpineMismatch} />
              </div>
            )}

            <p className="meta-note">
              勾选条目后可用共用工具栏批量上移 / 下移 / 删除；同层排序也可直接按住左侧抓取块拖动。
              写回会同时重建 nav.xhtml 与 toc.ncx，并按目录顺序同步 spine。
            </p>
          </div>
        </div>
      )}

      {!loading && workspace && tab === 'blocks' && (
        <div className="edit-panel__body">
          {/* 文件树是覆盖式抽屉：不挤占编辑区宽度，点遮罩 / Esc 收起 */}
          {treeOpen && (
            <>
              <button className="edit-panel__veil" aria-label="收起文件树" onClick={() => setTreeOpen(false)} />
              <aside className="edit-panel__tree" ref={treeRef}>
                <div className="edit-panel__tree-head">
                  <span>文件</span>
                  <div className="edit-panel__tree-tools">
                    <button className="toc-tool" data-tip="新建章节（同步 manifest / spine / 目录）" aria-label="新建章节" onClick={() => startFileOp('create')}>
                      <Icon name="note_add" size={15} />
                    </button>
                    <button className="toc-tool" data-tip="重命名当前文件（同步书内链接）" aria-label="重命名文件" disabled={!currentFile} onClick={() => startFileOp('rename')}>
                      <Icon name="drive_file_rename_outline" size={15} />
                    </button>
                    <button className="toc-tool" data-tip="移动当前文件（可改子目录）" aria-label="移动文件" disabled={!currentFile} onClick={() => startFileOp('move')}>
                      <Icon name="drive_file_move" size={15} />
                    </button>
                    <button className="toc-tool danger" data-tip="删除当前文件（同步 manifest / spine / 目录）" aria-label="删除文件" disabled={!currentFile} onClick={() => void askDeleteFile()}>
                      <Icon name="delete" size={15} />
                    </button>
                  </div>
                  <button
                    className="toc-tool"
                    data-tip="收起（Esc）"
                    aria-label="收起文件树"
                    onClick={() => setTreeOpen(false)}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>

                {fileOp && (
                  <div className="file-op-form">
                    <span>{fileOp.kind === 'create' ? '新建章节' : fileOp.kind === 'rename' ? '重命名' : '移动到'}</span>
                    {fileOp.kind !== 'create' && <span className="file-op-form__from">{currentFile?.relPath}</span>}
                    <input
                      value={fileOp.value}
                      onChange={e => setFileOp({ ...fileOp, value: e.target.value })}
                      placeholder={fileOp.kind === 'create' ? '文件名，如 chapter-21.xhtml' : fileOp.kind === 'rename' ? '同目录新文件名' : '目标路径，如 Text/ch-21.xhtml'}
                      onKeyDown={e => { if (e.key === 'Enter') void submitFileOp() }}
                    />
                    {fileOp.kind === 'create' && (
                      <input
                        value={fileOp.title ?? ''}
                        onChange={e => setFileOp({ ...fileOp, title: e.target.value })}
                        placeholder="章节标题"
                      />
                    )}
                    <button className="btn small primary" onClick={() => void submitFileOp()} disabled={tocBusy}>确定</button>
                    <button className="btn small" onClick={() => setFileOp(null)}>取消</button>
                  </div>
                )}

                {pendingFileOp && (
                  <div className="file-op-impact">
                    <div className="file-op-impact__head">
                      {pendingFileOp.kind === 'delete' ? '删除前确认' : pendingFileOp.kind === 'move' ? '移动前确认' : '重命名前确认'}
                      <button className="btn small icon-only" aria-label="取消" onClick={() => setPendingFileOp(null)}>
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                    <div className="file-op-impact__file">
                      {pendingFileOp.from}{pendingFileOp.to ? ` → ${pendingFileOp.to}` : ''}
                    </div>
                    <ul>
                      <li>manifest：{pendingFileOp.impact.inManifest ? '会被移除/更新' : '未登记'}</li>
                      <li>spine：{pendingFileOp.impact.inSpine ? '会被移除/更新' : '未在 spine'}</li>
                      <li>目录：{pendingFileOp.impact.inToc ? '会被移除/更新' : '未在目录'}</li>
                      <li>
                        书内链接：{pendingFileOp.impact.refCount} 处
                        {pendingFileOp.impact.refFiles.length > 0 && `（${pendingFileOp.impact.refFiles.slice(0, 4).join('、')}${pendingFileOp.impact.refFiles.length > 4 ? ' 等' : ''}）`}
                      </li>
                    </ul>
                    <div className="file-op-impact__actions">
                      <button className="btn small danger-solid" onClick={() => void confirmFileOp()} disabled={tocBusy}>确认执行</button>
                      <button className="btn small" onClick={() => setPendingFileOp(null)}>取消</button>
                    </div>
                  </div>
                )}

                <details open>
                  <summary>正文文件（{chapterList.length}）</summary>
                  <ul>
                    {chapterList.map(({ entry, label }) => (
                      <li key={entry.path}
                        className={`${currentFile?.relPath === entry.path ? 'active' : ''} is-chapter`}
                        title={entry.path}
                        onClick={() => void handleSelect(entry)}>
                        <span className="en">{label || baseName(entry.path)}</span>
                        <span className="ef">{baseName(entry.path)} · {formatBytes(entry.size)}</span>
                      </li>
                    ))}
                  </ul>
                </details>

                {Object.entries(structuralGroups).map(([role, list]) => (
                  <details key={role} open={role !== '图片'}>
                    <summary>{role}（{list.length}）</summary>
                    <ul>
                      {list.map(e => (
                        <li key={e.path}
                          className={currentFile?.relPath === e.path ? 'active' : ''}
                          title={e.path}
                          onClick={() => void handleSelect(e)}>
                          <span className="en">{baseName(e.path)}</span>
                          <span className="es">{formatBytes(e.size)}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </aside>
            </>
          )}

          {/* 编辑区 */}
          <main className="edit-panel__content">
            {!currentFile ? (
              <div className="edit-panel__hint">← 左边选一个文件开始编辑</div>
            ) : currentFile.base64 ? (
              <div className="edit-panel__binary">
                {currentFile.mime.startsWith('image/') ? (
                  <img src={`data:${currentFile.mime};base64,${currentFile.base64}`} alt="" />
                ) : (
                  <pre>二进制 · {currentFile.mime} · {formatBytes(currentFile.size)}</pre>
                )}
              </div>
            ) : (
              <div className={`block-view view-${view}${view === 'split' ? ' is-split' : ''}`}>
                <div className="block-bar">
                  <span className="block-bar__path">{currentFile.relPath}</span>
                  {blockDirty && <span className="edit-dirty">●</span>}
                  <div className="inline-bar" role="group" aria-label="内联格式">
                    <button
                      className="toc-tool"
                      data-tip="粗体（Ctrl+B）"
                      aria-label="粗体"
                      onMouseDown={e => e.preventDefault()}
                      onClick={handleBold}
                    >
                      <Icon name="format_bold" size={15} />
                    </button>
                    <button
                      className="toc-tool"
                      data-tip="斜体（Ctrl+I）"
                      aria-label="斜体"
                      onMouseDown={e => e.preventDefault()}
                      onClick={handleItalic}
                    >
                      <Icon name="format_italic" size={15} />
                    </button>
                    <button
                      className="toc-tool"
                      data-tip="下划线（Ctrl+U）"
                      aria-label="下划线"
                      onMouseDown={e => e.preventDefault()}
                      onClick={handleUnderline}
                    >
                      <Icon name="format_underlined" size={15} />
                    </button>
                    <button
                      className="toc-tool"
                      data-tip="链接（可填相对路径）"
                      aria-label="链接"
                      onMouseDown={e => e.preventDefault()}
                      onClick={handleLink}
                    >
                      <Icon name="link" size={15} />
                    </button>
                    <button
                      className="toc-tool"
                      data-tip="插入 EPUB 内已有图片"
                      aria-label="插入图片"
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => setImagePicker(true)}
                    >
                      <Icon name="image" size={15} />
                    </button>
                    <select
                      className="inline-tag"
                      data-tip="标题级别：只改块标签，属性与文字保留"
                      aria-label="标题级别"
                      value={blocks?.[activeBlock ?? -1]?.tag ?? 'p'}
                      onChange={e => {
                        const i = activeBlockRef.current
                        if (i == null) { onNotify('先点一下要改级别的段落'); return }
                        pushHistory()
                        changeBlockTag(i, e.target.value)
                      }}
                    >
                      {Object.entries(BLOCK_TAG_LABELS).map(([tag, label]) => (
                        <option key={tag} value={tag}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="inline-bar" role="group" aria-label="块操作">
                    <select
                      className="inline-tag"
                      data-tip="新建块类型"
                      aria-label="新建块类型"
                      value={newBlockTag}
                      onChange={e => setNewBlockTag(e.target.value)}
                    >
                      <option value="p">新段落</option>
                      <option value="h1">新标题 1</option>
                      <option value="h2">新标题 2</option>
                      <option value="h3">新标题 3</option>
                      <option value="blank">空行</option>
                    </select>
                    <button
                      className="toc-tool"
                      data-tip="在聚焦段之后新建块"
                      aria-label="新建块"
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => addBlock(
                        newBlockTag === 'blank' ? 'p' : newBlockTag,
                        newBlockTag === 'blank' ? '<br/>' : '',
                      )}
                    >
                      <Icon name="add" size={15} />
                    </button>
                    <button
                      className="toc-tool"
                      data-tip="当前段上移"
                      aria-label="上移"
                      onMouseDown={e => e.preventDefault()}
                      disabled={activeBlock == null}
                      onClick={() => { const i = activeBlockRef.current; if (i != null) moveBlock(i, -1) }}
                    >
                      <Icon name="arrow_upward" size={15} />
                    </button>
                    <button
                      className="toc-tool"
                      data-tip="当前段下移"
                      aria-label="下移"
                      onMouseDown={e => e.preventDefault()}
                      disabled={activeBlock == null}
                      onClick={() => { const i = activeBlockRef.current; if (i != null) moveBlock(i, 1) }}
                    >
                      <Icon name="arrow_downward" size={15} />
                    </button>
                    <span className="toc-sep" />
                    <button
                      className="toc-tool"
                      data-tip="撤销（Ctrl+Z）"
                      aria-label="撤销"
                      onMouseDown={e => e.preventDefault()}
                      disabled={historyRef.current.undo.length === 0}
                      onClick={undoBlocks}
                    >
                      <Icon name="undo" size={15} />
                    </button>
                    <button
                      className="toc-tool"
                      data-tip="重做（Ctrl+Shift+Z）"
                      aria-label="重做"
                      onMouseDown={e => e.preventDefault()}
                      disabled={historyRef.current.redo.length === 0}
                      onClick={redoBlocks}
                    >
                      <Icon name="redo" size={15} />
                    </button>
                  </div>
                  <span className="grow" />
                  {blocksStale && <span className="block-bar__stale">源码已改动，先刷新预览</span>}
                  {blockError && view !== 'source' && <span className="block-bar__stale">{blockError}</span>}
                  <span className="block-bar__hint">只提交改动段</span>
                  <span className="edit-font">字号 {sourceFontSize}px</span>
                  <div className="block-viewsw" role="group" aria-label="视图切换">
                    <button
                      className={`block-viewsw__btn${view === 'rich' ? ' on' : ''}`}
                      data-tip="富文本模式：所见即所得，段落可直接编辑"
                      aria-label="富文本模式"
                      disabled={!blockable}
                      onClick={() => setBlockView('rich')}
                    >
                      <Icon name="format_align_left" size={14} />
                      <span>富文本</span>
                    </button>
                    <button
                      className={`block-viewsw__btn${view === 'source' ? ' on' : ''}`}
                      data-tip="源码模式：直接编辑章节 XHTML"
                      aria-label="源码模式"
                      onClick={() => setBlockView('source')}
                    >
                      <Icon name="code" size={14} />
                      <span>源码</span>
                    </button>
                    <button
                      className={`block-viewsw__btn${view === 'split' ? ' on' : ''}`}
                      data-tip="分屏对照：左富文本右源码，滚动、光标、改动同步"
                      aria-label="分屏对照"
                      disabled={!blockable}
                      onClick={() => setBlockView('split')}
                    >
                      <Icon name="vertical_split" size={14} />
                      <span>分屏</span>
                    </button>
                  </div>
                  <button
                    className="btn small"
                    onClick={rebuildPreview}
                    title="按当前源码重新生成段落预览"
                    disabled={!blockable}
                  >
                    刷新预览
                  </button>
                  <button
                    className="btn small primary"
                    onClick={() => void applyBlocks()}
                    disabled={!blockDirty}
                    title="只把改动过的段落写回章节文件（未改动段逐字节保留）"
                  >
                    应用改动
                  </button>
                </div>
                <div className="block-main">
                  {view !== 'source' && (
                  <div className="block-canvas" ref={blockCanvasRef}>
                    {blockError ? (
                      <div className="block-empty">
                        <p>{blockError}</p>
                        <button className="btn small" onClick={() => setBlockView('source')}>切到源码模式</button>
                      </div>
                    ) : !blocks || blocks.length === 0 ? (
                      <div className="block-empty">这个文件没有可分块的正文</div>
                    ) : (
                      <div
                        className="block-page"
                        ref={blockPageRef}
                        style={{ '--blk-font': `${blockFont}px` } as CSSProperties}
                      >
                        {blocks.map((b, i) => {
                          const isDeleted = deletedIdx.has(i)
                          return (
                            <Fragment key={`${currentFile.relPath}-${i}`}>
                            <div
                              className={`blk${isDeleted ? ' is-deleted' : ''}${srcActiveBlock === i && view === 'split' ? ' is-src-active' : ''}`}
                              data-blk-index={i}
                            >
                              <span className="blk-tag" title={`源码标签 ${b.origTag}`}>
                                {isDeleted ? '已删' : b.tag}
                              </span>
                              {isDeleted ? (
                                <div className="blk-body blk-deleted-notes">
                                  <span>这一段在应用改动时会整段删除</span>
                                  <button className="btn small" onClick={() => undoDeleteBlock(i)}>撤销删除</button>
                                </div>
                              ) : (
                                <div
                                  className={`blk-body blk-${b.tag}`}
                                  contentEditable
                                  suppressContentEditableWarning
                                  spellCheck={false}
                                  dangerouslySetInnerHTML={{ __html: b.html }}
                                  onFocus={() => setActiveBlock(i)}
                                  onInput={e => {
                                    if (Date.now() - lastHistoryAtRef.current > 1200) pushHistory()
                                    blockEdits.current[i] = (e.currentTarget as HTMLElement).innerHTML
                                    if (!blockDirty) setBlockDirty(true)
                                  }}
                                  onPaste={e => handleBlockPaste(i, e)}
                                />
                              )}
                              {!isDeleted && (
                                <>
                                  {translatedOrigin[i] !== undefined && (
                                    <button
                                      className="blk-restore"
                                      data-tip="恢复这段翻译前的原文"
                                      aria-label="恢复原文"
                                      onClick={() => {
                                        const original = translatedOrigin[i]
                                        blockEdits.current[i] = original
                                        setBlocks(prev =>
                                          prev ? prev.map((r, j) => (j === i ? { ...r, html: original } : r)) : prev,
                                        )
                                        if (!blockDirty) setBlockDirty(true)
                                        setTranslatedOrigin(prev => {
                                          const next = { ...prev }
                                          delete next[i]
                                          return next
                                        })
                                        onNotify('已恢复原文')
                                      }}
                                    >
                                      <Icon name="undo" size={13} />
                                    </button>
                                  )}
                                  <button
                                    className="blk-translate"
                                    data-tip="翻译这段（会替换块内正文；可在段落预览里继续改）"
                                    aria-label="翻译这段"
                                    disabled={translatingBlock === i}
                                    onClick={async () => {
                                      if (translatingBlock === i) return
                                      setTranslatingBlock(i)
                                      setTranslateError(null)
                                      const sourceText = (b.html.replace(/<[^>]+>/g, ' ') || '')
                                        .replace(/\s+/g, ' ')
                                        .trim()
                                      if (!sourceText) {
                                        onNotify('这段没有可翻译的文字')
                                        setTranslatingBlock(null)
                                        return
                                      }
                                      try {
                                        const outcome = await translateOne({
                                          config: translateConfigFromPrefs(prefs),
                                          source: sourceText,
                                          glossary: glossaryRef.current,
                                          memory: memoryRef.current,
                                        })
                                        // sanitizeInline：白名单 + XML 校验，保证塞回 blockEdits 合法
                                        const sanitized = sanitizeInline(outcome.text)
                                        // 记下翻译前的正文（只在首次翻译时记，避免覆盖真正的原文）
                                        const beforeHtml = blockEdits.current[i] ?? b.html
                                        setTranslatedOrigin(prev => (prev[i] ? prev : { ...prev, [i]: beforeHtml }))
                                        blockEdits.current[i] = sanitized.xml
                                        setBlocks(prev =>
                                          prev ? prev.map((r, j) => (j === i ? { ...r, html: sanitized.xml } : r)) : prev,
                                        )
                                        if (!blockDirty) setBlockDirty(true)
                                        // P3：翻译只是草稿；等「应用改动 / 保存」人工确认后才写进翻译记忆
                                        const engineName =
                                          outcome.engine === 'online'
                                            ? '在线'
                                            : outcome.engine === 'baidu'
                                              ? '百度'
                                              : outcome.engine === 'baiduLlm'
                                                ? '百度大模型'
                                                : outcome.engine === 'local'
                                                ? '本地'
                                                : outcome.engine === 'builtin'
                                                  ? '内置'
                                                  : '记忆命中'
                                        onNotify(`已翻译（${engineName} · ${outcome.elapsedMs.toFixed(0)}ms），可继续在段落里改`)
                                      } catch (err) {
                                        const message = `翻译失败：${String(err)}`
                                        setTranslateError({ index: i, message })
                                        onNotify(message)
                                      } finally {
                                        setTranslatingBlock(null)
                                      }
                                    }}
                                  >
                                    <Icon name={translatingBlock === i ? 'hourglass_top' : 'translate'} size={13} />
                                  </button>
                                  <button
                                    className="blk-del"
                                    data-tip="删除这一段"
                                    aria-label="删除这一段"
                                    onClick={() => markDeleteBlock(i)}
                                  >
                                    <Icon name="delete" size={13} />
                                  </button>
                                </>
                              )}
                              {translateError?.index === i && (
                                <div className="blk-error" role="alert">{translateError.message}</div>
                              )}
                            </div>
                            {(inserts[i] ?? []).map(row => (
                              <div
                                className={`blk is-new${activeInsert?.id === row.id ? ' on' : ''}`}
                                key={`new-${row.id}`}
                                data-new-id={row.id}
                              >
                                <span className="blk-tag">{row.tag}</span>
                                <div
                                  className={`blk-body blk-${row.tag}`}
                                  contentEditable
                                  suppressContentEditableWarning
                                  spellCheck={false}
                                  data-placeholder="新建块：在这里输入内容"
                                  dangerouslySetInnerHTML={{ __html: row.html }}
                                  onFocus={() => setActiveInsert({ anchor: i, id: row.id })}
                                  onInput={e => {
                                    if (Date.now() - lastHistoryAtRef.current > 1200) pushHistory()
                                    updateInsert(row.id, (e.currentTarget as HTMLElement).innerHTML)
                                  }}
                                />
                                <button
                                  className="blk-del"
                                  data-tip="丢弃这个新建块"
                                  aria-label="丢弃新建块"
                                  onClick={() => removeInsert(i, row.id)}
                                >
                                  <Icon name="delete" size={13} />
                                </button>
                              </div>
                            ))}
                            </Fragment>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  )}
                  {view !== 'rich' && (
                    <div className="block-source">
                      <textarea
                        ref={splitSrcRef}
                        value={sourceText}
                        onChange={e => handleSplitSourceChange(e.target.value)}
                        onSelect={handleSourceCaret}
                        onClick={handleSourceCaret}
                        onKeyUp={handleSourceCaret}
                        spellCheck={false}
                        wrap="off"
                        style={{ fontSize: `${sourceFontSize}px`, lineHeight: view === 'split' ? 1.9 : 1.65 }}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </main>

          {/* D：插入图片——从 EPUB 现有图片资源里挑一张 */}
          {imagePicker && (
            <div className="img-picker" role="dialog" aria-label="插入图片">
              <div className="img-picker__head">
                <span>插入 EPUB 内图片（{imageEntries.length}）</span>
                <span className="grow" />
                <button
                  className="btn small icon-only"
                  data-tip="关闭"
                  aria-label="关闭"
                  onClick={() => setImagePicker(false)}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
              {imageEntries.length === 0 ? (
                <div className="img-picker__empty">这本 EPUB 里没有图片资源</div>
              ) : (
                <div className="img-picker__list">
                  {imageEntries.map(entry => (
                    <button
                      key={entry.path}
                      className="img-picker__item"
                      data-tip={entry.path}
                      onClick={() => insertImage(entry)}
                    >
                      <Icon name="image" size={14} />
                      <span className="img-picker__name">{baseName(entry.path)}</span>
                      <span className="img-picker__meta">{formatBytes(entry.size)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 检查结果 */}
          {checkResults && (
            <aside className="edit-panel__check">
              <div className="edit-panel__checkhead">
                <h4>epubcheck（{checkResults.length}）</h4>
                <button
                  className="btn small icon-only"
                  data-tip="关闭检查结果"
                  aria-label="关闭检查结果"
                  onClick={() => setCheckResults(null)}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
              {checkResults.length === 0 ? (
                <div className="edit-pass">✓ 通过</div>
              ) : (
                <ul>
                  {checkResults.map((r, i) => (
                    <li key={i} className={`level-${r.level.toLowerCase()}`}>
                      <span className="code">[{r.code}]</span> {r.message}
                      {r.path && <span className="path">@{baseName(r.path)}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          )}
        </div>
      )}

      {/* E6：历史版本（保存时自动快照，可整本回滚） */}
      {revOpen && (
        <div className="rev-panel">
          <div className="rev-panel__head">
            <Icon name="history" size={15} />
            <span>历史版本</span>
            <span className="grow" />
            <button className="btn small icon-only" title="关闭" onClick={() => setRevOpen(false)}>
              <Icon name="close" size={13} />
            </button>
          </div>
          <div className="rev-panel__body">
            {revBusy ? (
              <div className="rev-panel__empty">读取中…</div>
            ) : revisions.length === 0 ? (
              <div className="rev-panel__empty">还没有快照。点顶部「保存并重打包」会自动生成。</div>
            ) : revisions.map(rev => (
              <div className="rev-row" key={rev.name}>
                <div className="rev-row__main">
                  <span className="rev-row__time">{formatRevisionTime(rev.createdAt)}</span>
                  <span className="rev-row__meta">
                    {formatBytes(rev.size)}
                    {rev.name.includes('_auto_') ? ' · 回滚前自动存档' : ''}
                  </span>
                </div>
                <button
                  className="btn small"
                  disabled={revBusy}
                  onClick={() => void handleRestore(rev)}
                >
                  回滚
                </button>
              </div>
            ))}
          </div>
          <div className="rev-panel__foot">
            回滚会先给当前 EPUB 自动存档，再从所选快照重新解包；不会丢当前版本。
          </div>
        </div>
      )}

      {/* 二级弹窗：选目标章节（可拖动） */}
      {pickerOpen && (
        <div
          className="toc-picker"
          style={{ left: `${pickerPos.x}px`, top: `${pickerPos.y}px` }}
        >
          <div className="toc-picker__head" onPointerDown={startPickerDrag}>
            <Icon name="link" size={15} />
            <span>选择跳转章节</span>
            <span className="grow" />
            <button className="btn small icon-only" title="关闭" onClick={() => setPickerOpen(false)}>
              <Icon name="close" size={13} />
            </button>
          </div>
          <div className="toc-picker__search">
            <input
              autoFocus
              value={pickerQuery}
              onChange={e => setPickerQuery(e.target.value)}
              placeholder="搜索文件名，如 ch134"
            />
          </div>
          <div className="toc-picker__body">
            {pickerFiles.length === 0 ? (
              <div className="toc-picker__empty">没有匹配的章节文件</div>
            ) : pickerFiles.map(f => (
              <button key={f} className="toc-picker__item" onClick={() => applyTarget(f)}>
                {f}
              </button>
            ))}
          </div>
          <div className="toc-picker__foot">应用到已选 {selected.size} 个条目 · 按住标题栏可拖动</div>
        </div>
      )}
    </div>
  )
}
