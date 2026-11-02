import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ClipboardEvent as ReactClipboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import Icon from './Icon'
import {
  BLOCK_TAG_LABELS,
  isBlockTag,
  normalizeBlockBreaks,
  restorePreview,
  sanitizeInline,
  splitPreview,
  textToInline,
} from '../lib/inline-format'
import { translateOne, translateConfigFromPrefs } from '../lib/translate'
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
  total: number
  bytesBefore: number
  bytesAfter: number
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
 * 与 Rust scan_blocks_raw 同一规则：
 * body 直接子元素；若 body 只有一个 section/div/article 包裹层则下钻一层；
 * 空锚点 <a id="x"></a> 不算块。两者索引必须一一对应，否则回写会错位。
 */
function blockElements(doc: Document): Element[] {
  const body = doc.querySelector('body')
  if (!body) return []
  let list = Array.from(body.children)
  if (list.length === 1) {
    const only = list[0]
    const tag = only.tagName.toLowerCase()
    if (['section', 'div', 'article'].includes(tag) && only.children.length > 0) {
      list = Array.from(only.children)
    }
  }
  return list.filter((el) => !isAnchorOnly(el))
}

function isAnchorOnly(el: Element): boolean {
  return el.tagName.toLowerCase() === 'a'
    && !el.firstElementChild
    && !(el.textContent ?? '').trim()
}

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
  epubPath, bookId, exportDir, initialHref, initialBlock, onClose, onNotify, onDirtyChange, onCommitted,
  initialBlockFont = 15, initialSrcFont = 12, autoRebuild = true, createRevision = true,
  prefs = DEFAULT_PREFS,
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
  const [tab, setTab] = useState<'source' | 'blocks' | 'meta' | 'toc'>('blocks')

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
  /** 源码被手动改过、块坐标可能失效（此时禁止应用段落改动） */
  const [blocksStale, setBlocksStale] = useState(false)
  /** 已标记删除的块（写回时整段移除） */
  const [deletedIdx, setDeletedIdx] = useState<Set<number>>(new Set())
  /** 当前正在编辑的块序号（内联工具条作用于它） */
  const [activeBlock, setActiveBlock] = useState<number | null>(null)
  /** 通道 3：正在翻译的块序号（loading 状态） */
  const [translatingBlock, setTranslatingBlock] = useState<number | null>(null)
  const activeBlockRef = useRef<number | null>(null)
  activeBlockRef.current = activeBlock
  /** 段落视图与源码并排（E4） */
  const [splitOpen, setSplitOpen] = useState(true)
  /** 阅读器带来的待滚动段落块序号（一次性） */
  const pendingBlockRef = useRef<number | null>(null)
  const previewTimer = useRef<number | null>(null)

  // ─── E6：历史版本（EPUB 快照回滚） ───
  const [revOpen, setRevOpen] = useState(false)
  const [revisions, setRevisions] = useState<EpubRevision[]>([])
  const [revBusy, setRevBusy] = useState(false)

  const srcRef = useRef<HTMLTextAreaElement>(null)
  const tocListRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<HTMLElement>(null)
  const blockCanvasRef = useRef<HTMLDivElement>(null)
  const blockPageRef = useRef<HTMLDivElement>(null)
  const splitSrcRef = useRef<HTMLTextAreaElement>(null)

  const visibleEntries = useMemo(
    () => (tab === 'blocks' ? entries.filter((e) => e.role === 'text' || e.role === 'toc') : entries),
    [entries, tab],
  )
  const visibleGroups = useMemo(() => groupByRole(visibleEntries), [visibleEntries])

  const metaDirty = !!workspace && (
    metaTitle !== workspace.metadata.title ||
    (metaCreator || '') !== (workspace.metadata.creator ?? '') ||
    metaLang !== workspace.metadata.language ||
    !!coverPath
  )

  useEffect(() => {
    onDirtyChange?.(dirty || metaDirty || blockDirty)
  }, [dirty, metaDirty, blockDirty, onDirtyChange])

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
      })
      setDirty(false)
      onNotify('已保存并重打包')
      onCommitted?.()
    } catch (err) {
      setError(`保存失败：${String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [workspace, currentFile, dirty, blockDirty, onNotify, onCommitted, createRevision])

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
      })
      onNotify(`已另存为：${target}`)
    } catch (err) {
      setError(`另存为失败：${String(err)}`)
    } finally {
      setSaving(false)
    }
  }, [workspace, currentFile, dirty, blockDirty, exportDir, onNotify])

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
      const list = await invoke<EpubRevision[]>('edit_list_revisions', { editDir: workspace.editDir })
      setRevisions(list)
    } catch (err) {
      setError(`读取历史版本失败：${String(err)}`)
    } finally {
      setRevBusy(false)
    }
  }, [workspace])

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
      const list = await invoke<EpubRevision[]>('edit_list_revisions', { editDir: ws.editDir })
      setRevisions(list)
      onNotify(`已回滚到 ${label}`)
      onCommitted?.()
    } catch (err) {
      setError(`回滚失败：${String(err)}`)
    } finally {
      setRevBusy(false)
    }
  }, [workspace, currentFile, fillFromWorkspace, onNotify, onCommitted])


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
    if (!currentFile?.text) { setBlocks(null); return }
    if (!/x?html?|xml/i.test(currentFile.mime) && !/\.(x?html?|xhtml)$/i.test(currentFile.relPath)) {
      setBlocks(null)
      setBlockError('这个文件不是正文（样式 / 清单只在源码视图编辑）')
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
            if (cancelled || list.length === rows.length) return
            setBlocks(null)
            setBlockError(`段落索引与后端不一致（前端 ${rows.length} / 后端 ${list.length}），请点「刷新预览」`)
          })
          .catch(() => { /* 后端不可用时以 DOM 解析结果为准 */ })
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
      if (!payload.length) return false

      const result = await invoke<BlockWriteResult>('edit_write_blocks', {
        editDir: workspace.editDir,
        relPath: currentFile.relPath,
        edits: payload,
      })
      const fresh = await invoke<FileContent>('edit_read_file', {
        editDir: workspace.editDir, relPath: currentFile.relPath,
      })
      setCurrentFile(fresh)
      blockEdits.current = {}
      setBlockDirty(false)
      setDeletedIdx(new Set())
      setDirty(false)
      setBlockVersion(v => v + 1)

      const stripNote = removedTags.length || removedAttrs.length
        ? `，已剥离 ${removedTags.length} 个标签 / ${removedAttrs.length} 个属性`
        : ''
      onNotify(`已写回 ${result.replaced} 段${result.deleted ? `、删除 ${result.deleted} 段` : ''}；其余 ${result.total - result.replaced - result.deleted} 段逐字节保留${stripNote}`)
      return true
    } catch (err) {
      setError(`段落写回失败：${String(err)}`)
      return false
    }
  }, [workspace, currentFile, blocks, blocksStale, deletedIdx, onNotify])
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

  /** E4：源码 → 预览重解析；段落有未应用改动时需要先确认 */
  const rebuildPreview = useCallback(() => {
    if (blockDirty && !confirm('段落里有尚未应用的改动，刷新预览会丢弃它们，继续？')) return
    setBlockVersion(v => v + 1)
  }, [blockDirty])

  /** E4：并排源码框打字后，停顿 700ms 自动重建预览（设置里可关闭） */
  const handleSplitSourceChange = useCallback((value: string) => {
    handleTextChange(value)
    if (previewTimer.current) window.clearTimeout(previewTimer.current)
    // 源码改过之后块坐标不再可靠，标脏并停止自动重建
    if (blockDirty) { setBlocksStale(true); return }
    if (!autoRebuild) return
    previewTimer.current = window.setTimeout(() => setBlockVersion(v => v + 1), 700)
  }, [handleTextChange, blockDirty, autoRebuild])

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
    const top = el.getBoundingClientRect().top - canvas.getBoundingClientRect().top + canvas.scrollTop - 16
    canvas.scrollTop = Math.max(0, top)
    el.classList.add('blk-focus')
    window.setTimeout(() => el.classList.remove('blk-focus'), 1600)
  }, [blocks])

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
    const el = srcRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      setSrcFont(f => clamp(f + (e.deltaY > 0 ? -1 : 1), 9, 28))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [tab, currentFile?.relPath])

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
  }, [tab, currentFile?.relPath, splitOpen])

  useEffect(() => {
    const el = splitSrcRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      setSrcFont(f => clamp(f + (e.deltaY > 0 ? -1 : 1), 9, 28))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [tab, currentFile?.relPath, splitOpen])

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

  return (
    <div className="edit-panel">
      {/* 顶部工具栏 */}
      <header className="edit-panel__head">
        <button className="btn icon-only" title="回到阅读模式" onClick={handleClose}>
          <Icon name="arrow_back" />
        </button>
        <span className="edit-panel__title">
          编辑 {fileKind} {(dirty || metaDirty || blockDirty) && <span className="edit-dirty">●</span>}
        </span>
        <span className="edit-panel__sub">{workspace ? baseName(workspace.originPath) : ''}</span>
        <div className="edit-panel__actions">
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
          <button className="btn icon-only" title="关闭编辑，回到阅读" onClick={handleClose}>
            <Icon name="close" />
          </button>
        </div>
      </header>

      {/* 面板内标签页 */}
      <div className="edit-panel__tabs">
        <button className={`edit-tab ${tab === 'blocks' ? 'on' : ''}`} onClick={() => setTab('blocks')}>
          <Icon name="article" size={15} /> 段落
        </button>
        <button className={`edit-tab ${tab === 'source' ? 'on' : ''}`} onClick={() => setTab('source')}>
          <Icon name="code" size={15} /> 源码
        </button>
        <button className={`edit-tab ${tab === 'meta' ? 'on' : ''}`} onClick={() => setTab('meta')}>
          <Icon name="sell" size={15} /> 元数据
        </button>
        <button className={`edit-tab ${tab === 'toc' ? 'on' : ''}`} onClick={() => setTab('toc')}>
          <Icon name="account_tree" size={15} /> 目录
        </button>
        <span className="grow" />
        <span className="edit-panel__hintbar">Ctrl+滚轮可缩放编辑区字号</span>
      </div>

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

      {!loading && workspace && (tab === 'blocks' || tab === 'source') && (
        <div className="edit-panel__body">
          {/* 文件树：段落视图只列正文与目录，样式 / 清单只在源码视图出现 */}
          <aside className="edit-panel__tree" ref={treeRef}>
            {Object.entries(visibleGroups).map(([role, list]) => (
              <details key={role} open>
                <summary>{role}（{list.length}）</summary>
                <ul>
                  {list.map(e => (
                    <li key={e.path}
                      className={currentFile?.relPath === e.path ? 'active' : ''}
                      onClick={() => void handleSelect(e)}>
                      <span className="en">{baseName(e.path)}</span>
                      <span className="es">{formatBytes(e.size)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </aside>

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
            ) : tab === 'blocks' ? (
              <div className={`block-view${splitOpen ? ' is-split' : ''}`}>
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
                      data-tip="链接（可填相对路径）"
                      aria-label="链接"
                      onMouseDown={e => e.preventDefault()}
                      onClick={handleLink}
                    >
                      <Icon name="link" size={15} />
                    </button>
                    <select
                      className="inline-tag"
                      data-tip="标题级别：只改块标签，属性与文字保留"
                      aria-label="标题级别"
                      value={blocks?.[activeBlock ?? -1]?.tag ?? 'p'}
                      onChange={e => {
                        const i = activeBlockRef.current
                        if (i == null) { onNotify('先点一下要改级别的段落'); return }
                        changeBlockTag(i, e.target.value)
                      }}
                    >
                      {Object.entries(BLOCK_TAG_LABELS).map(([tag, label]) => (
                        <option key={tag} value={tag}>{label}</option>
                      ))}
                    </select>
                  </div>
                  <span className="grow" />
                  {blocksStale && <span className="block-bar__stale">源码已改动，先刷新预览</span>}
                  <span className="block-bar__hint">只提交改动段，其余段逐字节保留</span>
                  <span className="edit-font">字号 {blockFont}px（Ctrl+滚轮）</span>
                  <button
                    className={`btn small${splitOpen ? ' primary' : ''}`}
                    onClick={() => setSplitOpen(v => !v)}
                    title="段落预览与源码并排（E4）"
                  >
                    {splitOpen ? '收起源码' : '并排源码'}
                  </button>
                  <button
                    className="btn small"
                    onClick={rebuildPreview}
                    title="按当前源码重新生成段落预览"
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
                  <div className="block-canvas" ref={blockCanvasRef}>
                    {blockError ? (
                      <div className="block-empty">
                        <p>{blockError}</p>
                        <button className="btn small" onClick={() => setTab('source')}>切到源码视图</button>
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
                            <div
                              className={`blk${isDeleted ? ' is-deleted' : ''}`}
                              key={`${currentFile.relPath}-${i}`}
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
                                    blockEdits.current[i] = (e.currentTarget as HTMLElement).innerHTML
                                    if (!blockDirty) setBlockDirty(true)
                                  }}
                                  onPaste={e => handleBlockPaste(i, e)}
                                />
                              )}
                              {!isDeleted && (
                                <>
                                  <button
                                    className="blk-translate"
                                    data-tip="翻译这段（会替换块内正文；可在段落预览里继续改）"
                                    aria-label="翻译这段"
                                    disabled={translatingBlock === i}
                                    onClick={async () => {
                                      if (translatingBlock === i) return
                                      setTranslatingBlock(i)
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
                                          glossary: [],
                                        })
                                        // sanitizeInline：白名单 + XML 校验，保证塞回 blockEdits 合法
                                        const sanitized = sanitizeInline(outcome.text)
                                        blockEdits.current[i] = sanitized.xml
                                        setBlocks(prev =>
                                          prev ? prev.map((r, j) => (j === i ? { ...r, html: sanitized.xml } : r)) : prev,
                                        )
                                        if (!blockDirty) setBlockDirty(true)
                                        const engineName = outcome.engine === 'online' ? '在线' : outcome.engine === 'local' ? '本地' : '记忆命中'
                                        onNotify(`已翻译（${engineName} · ${outcome.elapsedMs.toFixed(0)}ms），可继续在段落里改`)
                                      } catch (err) {
                                        onNotify(`翻译失败：${String(err)}`)
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
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  {splitOpen && (
                    <div className="block-source">
                      <textarea
                        ref={splitSrcRef}
                        value={currentFile.text ?? ''}
                        onChange={e => handleSplitSourceChange(e.target.value)}
                        spellCheck={false}
                        wrap="off"
                        style={{ fontSize: `${srcFont}px`, lineHeight: 1.6 }}
                      />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <>
                <div className="edit-panel__fileinfo">
                  {currentFile.relPath} · {currentFile.mime} · {formatBytes(currentFile.size)}
                  {dirty && <span className="edit-dirty">● 已修改</span>}
                  <span className="edit-font">字号 {srcFont}px（Ctrl+滚轮）</span>
                </div>
                <textarea
                  className="edit-panel__textarea"
                  ref={srcRef}
                  value={currentFile.text ?? ''}
                  onChange={e => handleTextChange(e.target.value)}
                  spellCheck={false}
                  wrap="off"
                  style={{ fontSize: `${srcFont}px`, lineHeight: 1.65 }}
                />
              </>
            )}
          </main>

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
