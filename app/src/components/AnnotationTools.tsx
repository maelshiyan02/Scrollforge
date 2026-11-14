import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import Icon from './Icon'
import { Overlayer } from '../vendor/foliate-js/overlayer.js'
import {
  HIGHLIGHT_COLORS,
  anchorRange,
  clearLegacyAnnotations,
  hashText,
  loadBookAnnotations,
  normalizeText,
  readLegacyAnnotations,
  saveBookAnnotations,
  type Annotation,
  type AnnotationAnchor,
  type AnchorState,
} from '../lib/annotations'
import type { Prefs } from '../lib/prefs'
import { blockElements } from '../lib/inline-format'
import { translateConfigFromPrefs, translateOne } from '../lib/translate'
import {
  loadBookDrafts,
  subscribeDrafts,
  flushDrafts,
  updateDraftOffset,
  replaceDrafts,
  type TranslateDraftTable,
} from '../lib/translate-drafts'
import { createUndoStack, type UndoRecord, type UndoStack } from '../lib/undo-stack'

type RendererContents = { doc?: Document; index?: number }

type FoliateViewLike = HTMLElement & {
  renderer?: {
    getContents?: () => RendererContents[]
  }
  /** 章节列表：sections[index].id 即章节文件路径，草稿据此供编辑器匹配 */
  book?: { sections?: Array<{ id?: string }>; toc?: TocLike[] }
  addAnnotation?: (annotation: Annotation) => Promise<unknown>
  deleteAnnotation?: (annotation: Annotation) => Promise<unknown>
  /** 章节/CFI 跳转（标注面板点击定位用） */
  goTo?: (target: unknown) => Promise<unknown>
  getCFI?: (index: number, range: Range) => string | null
  deselect?: () => void
  /** 由 CFI / href 解析出章节索引与 anchor(doc) → Range */
  resolveNavigation?: (
    target: unknown,
  ) => { index?: number; anchor?: (doc: Document) => unknown } | null | undefined
}

type Props = {
  view: FoliateViewLike | null
  bookKey: string
  /** 书 id：译文草稿按书写进 app-data/<id>/translate-drafts.json；临时打开的文件没有 id，只在内存里保留 */
  bookId?: string
  prefs: Prefs
  onNotify: (message: string) => void
  /** 可编辑书：把贴边译文送进编辑器，作为该段落可编辑草稿 */
  onSendToEdit?: (payload: {
    cfi: string
    text: string
    translation: string
    index: number
    block?: number
  }) => void
}

type Selection = {
  cfi: string
  text: string
  index: number
  /** 选区所在的顶层段落块序号（与编辑器同一口径） */
  block?: number
  /** 该段落块的纯文本，编辑器据此判断草稿是否仍适用于当前段落 */
  blockText?: string
  /** 选区在该块归一化文本里的字符区间 */
  range?: { start: number; end: number }
  x: number
  y: number
}

type Shown = {
  cfi: string
  note?: string
  hasColor: boolean
  x: number
  y: number
}

type NoteTarget = {
  mode: 'new' | 'edit'
  value: string
  index: number
  text: string
  note: string
  /** 新建笔记时记下的段落锚点 */
  anchor?: AnnotationAnchor
}

/** 常驻小字笔记：贴在原文旁边，不用悬停就能看到 */
type InlineNote = {
  value: string
  note: string
  x: number
  y: number
  width: number
  /** 未拖动时的贴靠位置，用于把拖动结果换算成相对偏移 */
  ax: number
  ay: number
}

/** 实时翻译草稿（书级持久化，编辑器可继续编辑） */
type InlineTranslation = {
  /** 用 cfi 当 key；翻页/换位置都能跟上原文 */
  cfi: string
  /** 原文片段，用于 locateByText 定位 */
  text: string
  /** 译文 */
  translation: string
  /** 章节 index，用于过滤当前页 */
  index: number
  /** 原文所在顶层段落块序号（送进编辑器时用来定位） */
  block?: number
  x: number
  y: number
  width: number
  /** 未拖动时贴在原文下一行的位置，用于把拖动结果换算成相对偏移 */
  ax: number
  ay: number
}

/** 复用笔记/译文贴边定位：给一段原文 Box，算出屏幕上贴边的 x/y/width */
function computeInlinePos(box: { left: number; top: number; width: number; height: number }): {
  x: number; y: number; width: number; ax: number; ay: number
} {
  const rightEdge = Math.min(box.left + box.width, window.innerWidth)
  const roomRight = window.innerWidth - rightEdge - 14
  const width = Math.min(280, Math.max(160, roomRight > 180 ? roomRight : Math.min(280, window.innerWidth - 40)))
  const leftStart = Math.max(8, box.left)
  let x: number
  let y: number
  if (roomRight >= 180) {
    x = rightEdge + 10
    y = box.top
  } else {
    x = Math.min(leftStart, Math.max(8, window.innerWidth - width - 12))
    y = box.top + box.height + 5
  }
  if (y + 46 > window.innerHeight) y = Math.max(52, box.top - 36)
  return { x, y, width, ax: x, ay: y }
}

/**
 * 贴原文下一行的译文位置（参考沉浸式翻译：译文紧跟原文那一行）。
 * 原文底部没空间时改到原文上方，避免整条跑到屏幕外。
 */
function translationPos(box: { left: number; top: number; width: number; height: number }): {
  x: number; y: number; width: number; ax: number; ay: number
} {
  const width = Math.min(Math.max(220, box.width + 24), 620, window.innerWidth - 24)
  const x = Math.min(Math.max(8, box.left - 6), Math.max(8, window.innerWidth - width - 8))
  let y = box.top + box.height + 4
  if (y + 70 > window.innerHeight) y = Math.max(52, box.top - 46)
  return { x, y, width, ax: x, ay: y }
}

/** 小字最多显示的字数，超出省略，点开可看全文 */
const NOTE_PREVIEW_CHARS = 46
/** 单条笔记字数上限 */
const NOTE_MAX_CHARS = 500

type TocLike = { label?: string; href?: string; subitems?: TocLike[] }

/** 标注面板的一条记录：高亮/笔记或划词译文 */
type PanelItem =
  | {
      kind: 'annotation'
      value: string
      text: string
      note?: string
      color?: string
      state?: AnchorState
      at: number
    }
  | {
      kind: 'draft'
      value: string
      text: string
      translation: string
      at: number
    }

type PanelGroup = { index: number; label: string; items: PanelItem[] }

/** 章节路径比较：允许「相对 OPF」和「包内全路径」互为后缀 */
function matchHref(a?: string, b?: string): boolean {
  if (!a || !b) return false
  const x = a.split('#')[0].replace(/\\/g, '/').toLowerCase()
  const y = b.split('#')[0].replace(/\\/g, '/').toLowerCase()
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

/** 用 TOC 标签给章节文件起名，找不到就退回文件名/序号 */
function tocLabelOf(items: TocLike[] | undefined, href: string): string | undefined {
  for (const item of items ?? []) {
    if (item?.href && matchHref(item.href, href) && item.label) return item.label
    const sub = item?.subitems ? tocLabelOf(item.subitems, href) : undefined
    if (sub) return sub
  }
  return undefined
}

function rectOf(doc: Document, range: Range): { left: number; top: number; width: number; height: number } {
  const rect = range.getBoundingClientRect()
  const frame = (doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect()
  return {
    left: (frame?.left ?? 0) + rect.left,
    top: (frame?.top ?? 0) + rect.top,
    width: rect.width,
    height: rect.height,
  }
}

function toolbarPos(box: { left: number; top: number; width: number; height: number }) {
  const x = Math.min(Math.max(box.left + box.width / 2 - 150, 8), Math.max(8, window.innerWidth - 310))
  const y = box.top > 70 ? box.top - 48 : box.top + box.height + 10
  return { x, y }
}

type Box = { left: number; top: number; width: number; height: number }

/**
 * 按选中的文字找回"这句话"在屏幕上的位置（精确到句，不是整段）。
 * 分页模式下正文跨多屏时，rect 可能大半在屏外，这里取与可视区重叠最多的一段；
 * 完全不在当前页时返回 null，等翻到那一页再显示小字。
 */
function locateByText(doc: Document, text: string): Box | null {
  const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 16)
  if (snippet.length < 4) return null
  const frame = (doc.defaultView?.frameElement as HTMLElement | null)?.getBoundingClientRect()

  const pick = (rects: DOMRect[]): Box | null => {
    let best: Box | null = null
    let bestOverlap = 0
    for (const rect of rects) {
      if (rect.height <= 0) continue
      const left = (frame?.left ?? 0) + rect.left
      const top = (frame?.top ?? 0) + rect.top
      // 句首必须露在当前窗口里；只露出一小截的不算（说明这句在隔壁页）
      if (left < -8) continue
      const visibleX = Math.min(left + rect.width, window.innerWidth) - Math.max(left, 0)
      const visibleY = Math.min(top + rect.height, window.innerHeight - 24) - Math.max(top, 44)
      if (visibleX < Math.min(rect.width, 240) * 0.5 || visibleY <= 6) continue
      if (visibleX > bestOverlap) {
        bestOverlap = visibleX
        best = { left, top, width: rect.width, height: rect.height }
      }
    }
    return best
  }

  // 1) 先在文本节点里命中这句话本身
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  let node: Node | null
  while ((node = walker.nextNode())) {
    const raw = node.nodeValue ?? ''
    if (raw.length < snippet.length) continue
    const at = raw.indexOf(snippet)
    if (at < 0) continue
    const range = doc.createRange()
    range.setStart(node, at)
    range.setEnd(node, Math.min(raw.length, at + snippet.length))
    const hit = pick(Array.from(range.getClientRects()))
    if (hit) return hit
  }

  // 2) 这句话被拆在多个节点/含空白时，退回整段定位
  for (const block of doc.querySelectorAll('p, li, blockquote, h1, h2, h3, td')) {
    const content = (block.textContent ?? '').replace(/\s+/g, ' ')
    if (!content.includes(snippet)) continue
    const hit = pick(Array.from(block.getClientRects()))
    if (hit) return hit
  }
  return null
}

export default function AnnotationTools({ view, bookKey, bookId, prefs, onNotify, onSendToEdit }: Props) {
  const annotationsRef = useRef<Annotation[]>([])
  /** 书级译文草稿表：由 translate-drafts store 维护，按书写盘 */
  const draftsRef = useRef<TranslateDraftTable>({})
  const [selection, setSelection] = useState<Selection | null>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const [noteTarget, setNoteTarget] = useState<NoteTarget | null>(null)
  const [inlineNotes, setInlineNotes] = useState<InlineNote[]>([])
  const [inlineTrans, setInlineTrans] = useState<InlineTranslation[]>([])
  const [translating, setTranslating] = useState(false)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  /** 标注列表的 React 镜像：面板按章渲染用 */
  const [annotationList, setAnnotationList] = useState<Annotation[]>([])
  /** 标注面板开关（顶栏按钮通过 window 事件切换） */
  const [panelOpen, setPanelOpen] = useState(false)
  /** 译文草稿在 ref 里，改动时靠它触发面板重渲染 */
  const [panelTick, setPanelTick] = useState(0)
  /** 通用撤销栈：标注与划词译文共用，落盘到 `阅读壳/history.json` */
  const undoStackRef = useRef<UndoStack | null>(null)
  /** iframe 内按键不会冒泡到窗口，这里保存最新处理器供文档级监听调用 */
  const undoKeyRef = useRef<(event: KeyboardEvent) => void>(() => {})
  /** 小字刚被拖动过：随后的 click 不应打开弹窗 */
  const chipDraggedRef = useRef(false)
  /** 本次阅读已经提示过「标注待复核」，避免每翻一章都弹一次 */
  const anchorNoticeRef = useRef(false)

  /** 标注写进 `阅读壳/annotations.json`；临时打开的书没有 id，只留内存 */
  const persist = useCallback(
    (list: Annotation[]) => {
      annotationsRef.current = list
      setAnnotationList(list)
      if (!bookId) return
      void saveBookAnnotations(bookId, list).catch((err) => {
        onNotify(`标注保存失败：${String(err)}`)
      })
    },
    [bookId, onNotify],
  )

  const clearSelection = useCallback(() => {
    ;(view as FoliateViewLike | null)?.deselect?.()
    setSelection(null)
  }, [view])

  /** 把有笔记的标注解析成屏幕坐标，铺成常驻小字 */
  const syncInline = useCallback(() => {
    const el = view as FoliateViewLike | null
    if (!el?.renderer?.getContents) {
      setInlineNotes([])
      return
    }
    const contents = el.renderer?.getContents?.() ?? []
    const next: InlineNote[] = []
    for (const entry of contents) {
      const doc = entry.doc
      if (!doc) continue
      const index = typeof entry.index === 'number' ? entry.index : 0
      for (const annotation of annotationsRef.current) {
        if (!annotation.note || annotation.index !== index) continue
        const box = locateByText(doc, annotation.text)
        if (!box) continue
        const { x, y, width, ax, ay } = computeInlinePos(box)
        let nx = x
        let ny = y
        // 同一段落的多条笔记错开，避免叠在一起
        while (next.some((item) => Math.abs(item.x - nx) < 40 && Math.abs(item.y - ny) < 26)) ny += 26
        const offset = annotation.noteOffset
        if (offset) {
          nx = Math.min(Math.max(6, nx + offset.x), Math.max(6, window.innerWidth - 80))
          ny = Math.min(Math.max(48, ny + offset.y), Math.max(48, window.innerHeight - 32))
        }
        next.push({
          value: annotation.value,
          note: annotation.note,
          x: nx, y: ny, width, ax, ay,
        })
      }
    }
    setInlineNotes(next)
  }, [view])

  /** 把翻译草稿（书级存储）按当前页可见原文重铺贴边译文 */
  const syncTranslations = useCallback(() => {
    const el = view as FoliateViewLike | null
    if (!el?.renderer?.getContents) {
      setInlineTrans([])
      return
    }
    const drafts = draftsRef.current
    const cfiSet = new Set(Object.keys(drafts))
    if (cfiSet.size === 0) {
      setInlineTrans([])
      return
    }
    const contents = el.renderer?.getContents?.() ?? []
    const next: InlineTranslation[] = []
    for (const entry of contents) {
      const doc = entry.doc
      if (!doc) continue
      const index = typeof entry.index === 'number' ? entry.index : 0
      for (const [cfi, draft] of Object.entries(drafts)) {
        if (draft.index !== index) continue
        const box = locateByText(doc, draft.text)
        if (!box) continue
        const { x, y, width, ax, ay } = translationPos(box)
        let nx = x
        let ny = y
        // 同页多条译文往下错开，避免叠成一团
        while (next.some((item) => Math.abs(item.x - nx) < 40 && Math.abs(item.y - ny) < 26)) ny += 26
        // 避免和笔记小字重叠
        const overlapWithNote = inlineNotesRef.current.some(
          (n) => Math.abs(n.x - nx) < 40 && Math.abs(n.y - ny) < 26,
        )
        if (overlapWithNote) ny += 26
        const offset = draft.offset
        if (offset) {
          nx = Math.min(Math.max(6, nx + offset.x), Math.max(6, window.innerWidth - 120))
          ny = Math.min(Math.max(46, ny + offset.y), Math.max(46, window.innerHeight - 40))
        }
        next.push({
          cfi, text: draft.text, translation: draft.translation,
          index, block: draft.block, x: nx, y: ny, width, ax, ay,
        })
      }
    }
    setInlineTrans(next)
  }, [view])

  const syncRef = useRef(syncInline)
  const inlineNotesRef = useRef<InlineNote[]>([])
  syncRef.current = syncInline
  inlineNotesRef.current = inlineNotes
  // 每次滚动/换页同时重排笔记和译文
  const scheduleAll = useCallback(() => {
    syncRef.current()
    syncTranslations()
  }, [syncTranslations])

  // 撤销栈：按书读回最近 N 步；临时打开的书没有 id，只在本次阅读内有效
  useEffect(() => {
    const stack = createUndoStack({ bookId })
    undoStackRef.current = stack
    void stack.load()
    return () => {
      stack.dispose()
      undoStackRef.current = null
    }
  }, [bookId])

  /** 标注变更统一入口：写壳 + 记一步撤销（删除/改写都能回退） */
  const commitAnnotations = useCallback(
    (next: Annotation[], label: string, target: string) => {
      const before = annotationsRef.current
      persist(next)
      undoStackRef.current?.push({ kind: 'annotations', target, label, before, after: next })
    },
    [persist],
  )

  /** 译文草稿变更统一入口：更新 store + 记一步撤销 */
  const commitDrafts = useCallback(
    (next: TranslateDraftTable, label: string, target: string) => {
      const before = draftsRef.current
      if (bookId) replaceDrafts(bookId, next)
      else draftsRef.current = next
      undoStackRef.current?.push({ kind: 'drafts', target, label, before, after: next })
      setPanelTick((value) => value + 1)
      scheduleAll()
    },
    [bookId, scheduleAll],
  )

  /** 把一条历史记录还原成操作前/后的快照，同时补齐或撤掉页面上的覆盖层 */
  const applyUndoRecord = useCallback(
    (record: UndoRecord, direction: 'undo' | 'redo') => {
      const el = view as FoliateViewLike | null
      const snapshot = direction === 'undo' ? record.before : record.after
      if (record.kind === 'annotations') {
        const current = annotationsRef.current
        const next = Array.isArray(snapshot) ? (snapshot as Annotation[]) : []
        persist(next)
        void (async () => {
          for (const item of current) {
            if (next.some((entry) => entry.value === item.value)) continue
            try {
              await el?.deleteAnnotation?.(item)
            } catch {
              // 覆盖层可能已经不在了，忽略
            }
          }
          for (const item of next) {
            if (current.some((entry) => entry === item)) continue
            try {
              await el?.deleteAnnotation?.(item)
              await el?.addAnnotation?.(item)
            } catch {
              // 同上
            }
          }
        })()
      } else {
        const table =
          snapshot && typeof snapshot === 'object' ? (snapshot as TranslateDraftTable) : {}
        if (bookId) replaceDrafts(bookId, table)
        else draftsRef.current = table
        setPanelTick((value) => value + 1)
        scheduleAll()
      }
      window.setTimeout(() => syncRef.current(), 0)
      onNotify(`${direction === 'undo' ? '已撤销' : '已重做'}：${record.label}`)
    },
    [view, persist, bookId, scheduleAll, onNotify],
  )

  // Ctrl+Z / Ctrl+Shift+Z（或 Ctrl+Y）：非输入区回退最近一次标注/译文操作
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      // 输入框里交给原生撤销，别抢用户的文字编辑
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) {
        return
      }
      const isRedo = key === 'y' || (key === 'z' && event.shiftKey)
      const stack = undoStackRef.current
      if (!stack) return
      const record = isRedo ? stack.redo() : stack.undo()
      event.preventDefault()
      event.stopPropagation()
      if (!record) {
        onNotify(isRedo ? '没有可重做的标注操作' : '没有可撤销的标注操作')
        return
      }
      applyUndoRecord(record, isRedo ? 'redo' : 'undo')
    }
    undoKeyRef.current = handler
    window.addEventListener('keydown', handler, true)
    return () => {
      window.removeEventListener('keydown', handler, true)
      undoKeyRef.current = () => {}
    }
  }, [applyUndoRecord, onNotify])

  // 顶栏「标注面板」按钮通过 window 事件切换，避免把面板状态提到 Reader
  useEffect(() => {
    const toggle = () => setPanelOpen((value) => !value)
    window.addEventListener('scrollforge:annotation-panel', toggle)
    return () => window.removeEventListener('scrollforge:annotation-panel', toggle)
  }, [])

  // 读入本书译文草稿，并跟随 store 变更重铺贴边译文
  useEffect(() => {
    let alive = true
    draftsRef.current = {}
    if (!bookId) {
      scheduleAll()
      return () => { alive = false }
    }
    void loadBookDrafts(bookId).then((table) => {
      if (!alive) return
      draftsRef.current = table
      scheduleAll()
    })
    const unsubscribe = subscribeDrafts(bookId, (table) => {
      if (!alive) return
      draftsRef.current = table
      // 面板里的译文条目跟着 store 刷新
      setPanelTick((value) => value + 1)
      scheduleAll()
    })
    return () => {
      alive = false
      unsubscribe()
      // 离开本书/关闭窗口前把还没落盘的草稿写完，避免防抖窗口内丢失
      void flushDrafts(bookId)
    }
  }, [bookId, scheduleAll])

  const removeAnnotation = useCallback(
    (value: string) => {
      const el = view as FoliateViewLike | null
      const target = annotationsRef.current.find((item) => item.value === value)
      if (target && el) void el.deleteAnnotation?.(target)
      commitAnnotations(
        annotationsRef.current.filter((item) => item.value !== value),
        '删除标注',
        value,
      )
      setShown(null)
      setNoteTarget(null)
      window.setTimeout(() => syncRef.current(), 0)
      onNotify('已删除标注')
    },
    [view, commitAnnotations, onNotify],
  )

  // 事件接线：加载、换节、绘制、点击已有标注
  useEffect(() => {
    const el = view as FoliateViewLike | null
    if (!el) return

    const attached = new WeakSet<Document>()
    const scrolled = new Set<Document>()
    const timers: number[] = []
    let raf = 0

    // 汇总多次滚动/换页，一帧最多重排一次；同时重排笔记和译文字
    const tick = () => {
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        scheduleAll()
      })
    }
    const schedule = tick

    const blocksOf = (doc: Document) => {
      try {
        return blockElements(doc)
      } catch {
        return [] as Element[]
      }
    }
    const hrefOf = (index: number) => el.book?.sections?.[index]?.id ?? ''

    /**
     * 锚点核对：段落还在就按 textHash 判 ok/partial，整段消失标 orphan；
     * 旧版只有 CFI 的标注则在这里按 CFI 反查段落，补全 blockIndex/range。
     */
    const syncAnchors = (doc: Document, index: number): boolean => {
      let changed = false
      let needsNotice = false
      const blocks = blocksOf(doc)
      for (const annotation of annotationsRef.current) {
        if (annotation.index !== index) continue
        const anchor = annotation.anchor
        if (anchor && anchor.blockIndex >= 0) {
          const block = blocks[anchor.blockIndex]
          if (!block) {
            if (anchor.state !== 'orphan') {
              anchor.state = 'orphan'
              changed = true
            }
            needsNotice = true
            continue
          }
          const current = normalizeText(block.textContent ?? '')
          const state = hashText(current) === anchor.textHash ? 'ok' : 'partial'
          if (state !== anchor.state) {
            anchor.state = state
            changed = true
          }
          if (state === 'partial') {
            needsNotice = true
            if (anchor.range) {
              const start = Math.min(anchor.range.start, current.length)
              const end = Math.min(Math.max(anchor.range.end, start), current.length)
              if (start !== anchor.range.start || end !== anchor.range.end) {
                anchor.range = { start, end }
                changed = true
              }
            }
          }
          continue
        }
        // 旧数据或孤儿：按 CFI 在当前章节再试一次
        const resolved = el.resolveNavigation?.(annotation.value)
        const target = resolved?.anchor?.(doc) as unknown
        const range = target instanceof Range ? target : null
        if (!range || !blocks.length) {
          needsNotice = true
          continue
        }
        const block = blocks.find((item) => item.contains(range.startContainer))
        if (!block) {
          if (!annotation.anchor || annotation.anchor.state !== 'orphan') {
            annotation.anchor = {
              href: hrefOf(index),
              blockIndex: -1,
              textHash: '',
              blockText: '',
              state: 'orphan',
            }
            changed = true
          }
          needsNotice = true
          continue
        }
        const info = anchorRange(block, range)
        annotation.anchor = {
          href: hrefOf(index),
          blockIndex: blocks.indexOf(block),
          textHash: hashText(info.text),
          blockText: info.text,
          range: info.range,
          state: 'ok',
        }
        changed = true
      }
      if (needsNotice && !anchorNoticeRef.current) {
        anchorNoticeRef.current = true
        const orphans = annotationsRef.current.filter((item) => item.anchor?.state === 'orphan').length
        const partial = annotationsRef.current.filter((item) => item.anchor?.state === 'partial').length
        if (orphans || partial) {
          // 稍等一下再提示：书刚打开时的「已回到上次位置」会占用同一个提示位
          timers.push(
            window.setTimeout(
              () =>
                onNotify(
                  `阅读标注：${partial} 条因原文改写部分失效，${orphans} 条找不到原段落，待复核`,
                ),
              1400,
            ),
          )
        }
      }
      return changed
    }

    const inspect = (doc: Document) => {
      const native = doc.getSelection()
      if (!native || native.isCollapsed || native.rangeCount === 0) return
      const range = native.getRangeAt(0)
      const text = native.toString().replace(/\s+/g, ' ').trim()
      if (!text) return
      const contents = el.renderer?.getContents?.() ?? []
      const entry = contents.find((item) => item.doc === doc) ?? contents[0]
      const index = typeof entry?.index === 'number' ? entry.index : 0
      const cfi = el.getCFI?.(index, range)
      if (!cfi) return
      // 段落块序号：与编辑器 blockElements 同一口径，供「送进编辑」定位
      let block: number | undefined
      let blockText: string | undefined
      let blockRange: { start: number; end: number } | undefined
      try {
        const list = blockElements(doc)
        const target = list.find((item) => item.contains(range.startContainer))
        if (target) {
          block = list.indexOf(target)
          const info = anchorRange(target, range)
          blockText = info.text || undefined
          blockRange = info.range
        }
      } catch { /* 文档结构异常时只按章节对齐 */ }
      const { x, y } = toolbarPos(rectOf(doc, range))
      setSelection({ cfi, text: text.slice(0, 600), index, block, blockText, range: blockRange, x, y })
      setShown(null)
    }

    const attachDocument = (doc: Document) => {
      if (attached.has(doc)) return
      attached.add(doc)
      const later = () => window.setTimeout(() => inspect(doc), 0)
      doc.addEventListener('mouseup', later)
      doc.addEventListener('keyup', (event) => {
        const key = (event as KeyboardEvent).key
        if (key.startsWith('Arrow') || key === 'Shift') later()
      })
      // iframe 内的 Ctrl+Z 不冒泡到窗口，在文档级再接一份
      doc.addEventListener('keydown', (event) => undoKeyRef.current(event as KeyboardEvent), true)
      // 连续滚动时正文不会重新分页，笔记和译文字都要跟着文字走
      doc.addEventListener('scroll', schedule, true)
      scrolled.add(doc)
    }

    const onLoad = (event: Event) => {
      const doc = (event as CustomEvent).detail?.doc as Document | undefined
      if (doc) {
        attachDocument(doc)
        const index =
          (el.renderer?.getContents?.() ?? []).find((item) => item.doc === doc)?.index ?? 0
        if (syncAnchors(doc, index) && bookId) {
          void saveBookAnnotations(bookId, annotationsRef.current).catch(() => undefined)
        }
      }
      // 字体/分页稳定后位置会变，补两次重排，避免小字停在旧位置
      timers.push(window.setTimeout(schedule, 500), window.setTimeout(schedule, 1400))
      // 目录/章节信息此时才齐，标注面板的章标题跟着刷新
      setPanelTick((value) => value + 1)
    }

    const onCreateOverlay = (event: Event) => {
      const index = (event as CustomEvent).detail?.index as number | undefined
      for (const annotation of annotationsRef.current) {
        if (annotation.index === index) void el.addAnnotation?.(annotation)
      }
    }

    const onDraw = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (!detail?.draw) return
      const annotation = detail.annotation as Annotation
      if (annotation.color) detail.draw(Overlayer.highlight, { color: annotation.color })
      else detail.draw(Overlayer.underline, { color: '#b07a3c', width: 2 })
    }

    const onShow = (event: Event) => {
      const detail = (event as CustomEvent).detail
      const annotation = annotationsRef.current.find((item) => item.value === detail?.value)
      if (!annotation) return
      // 有笔记的标注已经有常驻小字，不再叠一个悬停工具条
      if (annotation.note) return
      const range = detail?.range as Range | undefined
      let x = window.innerWidth / 2 - 150
      let y = window.innerHeight - 220
      if (range) {
        const pos = toolbarPos(rectOf(range.startContainer.ownerDocument ?? document, range))
        x = pos.x
        y = pos.y
      }
      setSelection(null)
      setShown({
        cfi: annotation.value,
        note: annotation.note,
        hasColor: Boolean(annotation.color),
        x,
        y,
      })
    }

    el.addEventListener('load', onLoad)
    el.addEventListener('create-overlay', onCreateOverlay)
    el.addEventListener('draw-annotation', onDraw)
    el.addEventListener('show-annotation', onShow)
    el.addEventListener('relocate', schedule)
    window.addEventListener('resize', schedule)

    // 组件可能在首屏已加载后才挂上：读壳文件 → 核对锚点 → 补画当前节标注
    const contents = el.renderer?.getContents?.() ?? []
    for (const entry of contents) {
      if (entry.doc) attachDocument(entry.doc)
    }
    let cancelled = false

    const applyLoaded = (list: Annotation[]) => {
      if (cancelled) return
      annotationsRef.current = list
      setAnnotationList(list)
      let changed = false
      // 壳文件是异步读的，读回来时 renderer 可能才刚有内容，这里必须重新取一次
      const live = el.renderer?.getContents?.() ?? []
      for (const entry of live) {
        if (!entry.doc) continue
        attachDocument(entry.doc)
        const index = typeof entry.index === 'number' ? entry.index : 0
        if (syncAnchors(entry.doc, index)) changed = true
        for (const annotation of list) {
          if (annotation.index === index) void el.addAnnotation?.(annotation)
        }
      }
      if (changed && bookId) {
        void saveBookAnnotations(bookId, annotationsRef.current).catch(() => undefined)
      }
      schedule()
    }

    const load = async () => {
      if (!bookId) {
        applyLoaded(readLegacyAnnotations(bookKey))
        return
      }
      try {
        const { list, existed } = await loadBookAnnotations(bookId)
        if (cancelled) return
        if (existed) {
          applyLoaded(list)
          return
        }
        // 首次升级：localStorage 旧标注一次性升格进阅读壳，写盘成功后再清本地副本
        const legacy = readLegacyAnnotations(bookKey)
        applyLoaded(legacy)
        if (!legacy.length) return
        try {
          await saveBookAnnotations(bookId, annotationsRef.current)
          clearLegacyAnnotations(bookKey)
        } catch {
          // 写盘失败就保留 localStorage，下次打开再试
        }
      } catch (err) {
        if (cancelled) return
        applyLoaded(readLegacyAnnotations(bookKey))
        onNotify(`读取阅读标注失败：${String(err)}`)
      }
    }
    void load()

    return () => {
      cancelled = true
      el.removeEventListener('load', onLoad)
      el.removeEventListener('create-overlay', onCreateOverlay)
      el.removeEventListener('draw-annotation', onDraw)
      el.removeEventListener('show-annotation', onShow)
      el.removeEventListener('relocate', schedule)
      window.removeEventListener('resize', schedule)
      scrolled.forEach((doc) => doc.removeEventListener('scroll', schedule, true))
      timers.forEach((id) => window.clearTimeout(id))
      if (raf) window.cancelAnimationFrame(raf)
      setSelection(null)
      setShown(null)
      setInlineNotes([])
      setInlineTrans([])
    }
  }, [view, bookKey, bookId, onNotify])

  // Esc：优先收掉笔记/工具条/标注面板，并拦住阅读页的"返回书架"
  useEffect(() => {
    if (!selection && !shown && !noteTarget && !panelOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (noteTarget) setNoteTarget(null)
      else if (shown) setShown(null)
      else if (selection) clearSelection()
      else if (panelOpen) setPanelOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selection, shown, noteTarget, panelOpen, clearSelection])

  // 点主界面空白处收起工具条
  useEffect(() => {
    if (!selection && !shown) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest?.('.ann-toolbar') || target?.closest?.('.note-card')) return
      setSelection(null)
      setShown(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [selection, shown])

  /** 选区 → 段落级锚点；拿不到段落块时返回 undefined，仍保留 CFI 画线 */
  const anchorOf = (target: Selection): AnnotationAnchor | undefined => {
    if (target.block === undefined || !target.blockText) return undefined
    return {
      href: (view as FoliateViewLike | null)?.book?.sections?.[target.index]?.id ?? '',
      blockIndex: target.block,
      textHash: hashText(target.blockText),
      blockText: target.blockText,
      range: target.range,
      state: 'ok',
    }
  }

  const addHighlight = (color: string) => {
    if (!selection) return
    const annotation: Annotation = {
      value: selection.cfi,
      color,
      index: selection.index,
      text: selection.text,
      createdAt: Date.now(),
      anchor: anchorOf(selection),
    }
    commitAnnotations([...annotationsRef.current, annotation], '添加高亮', selection.cfi)
    void (view as FoliateViewLike | null)?.addAnnotation?.(annotation)
    clearSelection()
    onNotify('已添加高亮')
  }

  /** 阅读器实时翻译：调 translateOne，结果写进书级草稿（编辑器可接着编辑） */
  const translateSelection = useCallback(async () => {
    if (!selection || translating) return
    setTranslating(true)
    const cfg = translateConfigFromPrefs(prefs)
    const target = selection
    const el = view as FoliateViewLike | null
    // 章节文件路径：编辑器用 samePath 匹配自己的 relPath
    const relPath = el?.book?.sections?.[target.index]?.id
    try {
      const outcome = await translateOne({
        config: cfg,
        source: target.text,
        glossary: [],
      })
      const prev = draftsRef.current[target.cfi]
      const draft = {
        cfi: target.cfi,
        text: target.text,
        translation: outcome.text,
        index: target.index,
        block: target.block,
        relPath,
        blockText: target.blockText,
        offset: prev?.offset,
      }
      // 重新翻译同一条也算一次独立操作，Ctrl+Z 可逐步回退到上一版译文
      commitDrafts(
        { ...draftsRef.current, [target.cfi]: { ...draft, updatedAt: Date.now() } },
        prev ? '重新翻译' : '添加划词译文',
        target.cfi,
      )
      clearSelection()
      const engine =
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
                  : '记忆'
      onNotify(
        bookId
          ? `已翻译（${engine} · ${outcome.elapsedMs.toFixed(0)}ms），草稿已存到本书，编辑器里可接着改`
          : `已翻译（${engine} · ${outcome.elapsedMs.toFixed(0)}ms），临时打开的书只在本次阅读中保留草稿`,
      )
    } catch (err) {
      onNotify(`翻译失败：${String(err)}`)
    } finally {
      setTranslating(false)
    }
  }, [selection, translating, prefs, bookId, view, commitDrafts, clearSelection, onNotify])

  const removeInlineTranslation = useCallback(
    (cfi: string) => {
      if (!draftsRef.current[cfi]) return
      const next = { ...draftsRef.current }
      delete next[cfi]
      commitDrafts(next, '删除划词译文', cfi)
    },
    [commitDrafts],
  )

  /** 面板数据：标注与划词译文按章节分组；孤儿/部分失效带上状态徽标 */
  const panelGroups = useMemo<PanelGroup[]>(() => {
    const el = view as FoliateViewLike | null
    const sections = el?.book?.sections ?? []
    const toc = el?.book?.toc as TocLike[] | undefined
    const groups = new Map<number, PanelGroup>()
    const push = (index: number, item: PanelItem) => {
      const key = Number.isFinite(index) && index >= 0 ? index : 999999
      if (!groups.has(key)) {
        const href = sections[key]?.id ?? ''
        const fallback = href
          ? (href.split('/').pop() ?? href).replace(/\.[^.]+$/, '')
          : `第 ${key + 1} 节`
        groups.set(key, {
          index: key,
          label: tocLabelOf(toc, href) || fallback,
          items: [],
        })
      }
      groups.get(key)?.items.push(item)
    }
    for (const item of annotationList) {
      push(item.index, {
        kind: 'annotation',
        value: item.value,
        text: item.text,
        note: item.note,
        color: item.color,
        state: item.anchor?.state,
        at: item.createdAt,
      })
    }
    for (const draft of Object.values(draftsRef.current)) {
      push(draft.index, {
        kind: 'draft',
        value: draft.cfi,
        text: draft.text,
        translation: draft.translation,
        at: draft.updatedAt,
      })
    }
    for (const group of groups.values()) group.items.sort((a, b) => a.at - b.at)
    return [...groups.values()].sort((a, b) => a.index - b.index)
  }, [annotationList, panelTick, panelOpen, view])

  const jumpToPanelItem = useCallback(
    (item: PanelItem) => {
      const el = view as FoliateViewLike | null
      setPanelOpen(false)
      if (!el?.goTo) return
      void el.goTo(item.value).catch(() => onNotify('跳转失败'))
    },
    [view, onNotify],
  )

  const removePanelItem = useCallback(
    (item: PanelItem) => {
      if (item.kind === 'annotation') removeAnnotation(item.value)
      else removeInlineTranslation(item.value)
    },
    [removeAnnotation, removeInlineTranslation],
  )

  const beginNote = () => {
    if (!selection) return
    setDrag(null)
    setNoteTarget({
      mode: 'new',
      value: selection.cfi,
      index: selection.index,
      text: selection.text,
      note: '',
      anchor: anchorOf(selection),
    })
    setSelection(null)
  }

  const openNoteEditor = (value: string) => {
    const annotation = annotationsRef.current.find((item) => item.value === value)
    if (!annotation) return
    setDrag(null)
    setNoteTarget({
      mode: 'edit',
      value: annotation.value,
      index: annotation.index,
      text: annotation.text,
      note: annotation.note ?? '',
      anchor: annotation.anchor,
    })
    setShown(null)
  }

  const beginEdit = () => {
    if (!shown) return
    openNoteEditor(shown.cfi)
  }

  const saveNote = () => {
    const el = view as FoliateViewLike | null
    if (!noteTarget) return
    const note = noteTarget.note.trim().slice(0, NOTE_MAX_CHARS)
    const existing = annotationsRef.current.find((item) => item.value === noteTarget.value)
    if (existing) {
      if ((existing.note ?? '') === note) {
        setNoteTarget(null)
        setShown(null)
        return
      }
      const updated: Annotation = { ...existing, note: note || undefined, updatedAt: Date.now() }
      commitAnnotations(
        annotationsRef.current.map((item) => (item.value === updated.value ? updated : item)),
        note ? '修改笔记' : '删除笔记',
        updated.value,
      )
      void el?.addAnnotation?.(updated)
    } else if (note) {
      const annotation: Annotation = {
        value: noteTarget.value,
        index: noteTarget.index,
        text: noteTarget.text,
        note,
        createdAt: Date.now(),
        // 笔记按段落挂靠：段落还在，笔记就不因段内改字而失效
        anchor: noteTarget.anchor,
      }
      commitAnnotations([...annotationsRef.current, annotation], '添加笔记', annotation.value)
      void el?.addAnnotation?.(annotation)
    }
    setNoteTarget(null)
    setShown(null)
    window.setTimeout(() => syncRef.current(), 0)
    onNotify('笔记已保存')
  }

  // 二级弹窗拖动：按住标题栏移动
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const originX = event.clientX
    const originY = event.clientY
    const base = drag ?? { x: 0, y: 0 }
    const move = (e: PointerEvent) =>
      setDrag({ x: base.x + e.clientX - originX, y: base.y + e.clientY - originY })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // 小字拖动：松手后把位移换算成相对原句的偏移存进标注，下次打开书沿用
  const startChipDrag = (event: ReactPointerEvent<HTMLButtonElement>, item: InlineNote) => {
    if (event.button !== 0) return
    event.preventDefault()
    const el = event.currentTarget
    const startX = event.clientX
    const startY = event.clientY
    const baseX = item.x
    const baseY = item.y
    let x = baseX
    let y = baseY
    let moved = false
    const move = (e: PointerEvent) => {
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return
      moved = true
      x = Math.min(Math.max(6, baseX + dx), Math.max(6, window.innerWidth - 80))
      y = Math.min(Math.max(48, baseY + dy), Math.max(48, window.innerHeight - 32))
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      el.style.cursor = 'grabbing'
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.style.removeProperty('cursor')
      if (!moved) return
      chipDraggedRef.current = true
      const offset = { x: Math.round(x - item.ax), y: Math.round(y - item.ay) }
      persist(
        annotationsRef.current.map((annotation) =>
          annotation.value === item.value ? { ...annotation, noteOffset: offset } : annotation,
        ),
      )
      window.setTimeout(() => syncRef.current(), 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // 译文拖动：松手后把位移存成偏移，翻页/滚动后仍按用户挪到的位置显示
  const startTransChipDrag = (event: ReactPointerEvent<HTMLDivElement>, item: InlineTranslation) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('.ann-translate__close')) return
    event.preventDefault()
    const el = event.currentTarget
    const startX = event.clientX
    const startY = event.clientY
    const baseX = item.x
    const baseY = item.y
    let x = baseX
    let y = baseY
    let moved = false
    const move = (e: PointerEvent) => {
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return
      moved = true
      x = Math.min(Math.max(6, baseX + dx), Math.max(6, window.innerWidth - 120))
      y = Math.min(Math.max(46, baseY + dy), Math.max(46, window.innerHeight - 40))
      el.style.left = `${x}px`
      el.style.top = `${y}px`
      el.style.cursor = 'grabbing'
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      el.style.removeProperty('cursor')
      if (!moved) return
      const offset = { x: Math.round(x - item.ax), y: Math.round(y - item.ay) }
      if (bookId) {
        updateDraftOffset(bookId, item.cfi, offset)
      } else {
        const draft = draftsRef.current[item.cfi]
        if (draft) {
          draftsRef.current = {
            ...draftsRef.current,
            [item.cfi]: { ...draft, offset, updatedAt: Date.now() },
          }
        }
      }
      setInlineTrans((prev) => prev.map((entry) => (entry.cfi === item.cfi ? { ...entry, x, y } : entry)))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <>
      {inlineNotes.map((item) => (
        <button
          key={item.value}
          className="ann-inline"
          style={{ left: item.x, top: item.y, maxWidth: item.width }}
          data-tip="点击展开编辑，按住可拖到别处"
          aria-label="编辑笔记"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => startChipDrag(event, item)}
          onClick={(event) => {
            event.stopPropagation()
            if (chipDraggedRef.current) {
              chipDraggedRef.current = false
              return
            }
            openNoteEditor(item.value)
          }}
        >
          <Icon name="sticky_note_2" size={13} />
          <span className="text">
            {item.note.length > NOTE_PREVIEW_CHARS
              ? `${item.note.slice(0, NOTE_PREVIEW_CHARS)}…`
              : item.note}
          </span>
        </button>
      ))}

      {inlineTrans.map((item) => (
        <div
          key={`t-${item.cfi}`}
          className="ann-translate"
          style={{ left: item.x, top: item.y, maxWidth: item.width }}
          data-tip="译文字草稿：按住可拖到别处；已存进本书，编辑档里能接着改"
          aria-label="翻译草稿"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => startTransChipDrag(event, item)}
        >
          <Icon name="translate" size={13} />
          <span className="ann-translate__text">{item.translation}</span>
          {onSendToEdit && (
            <button
              className="ann-translate__send"
              data-tip="把这条译文送进编辑器，变成该段的可编辑草稿"
              aria-label="送进编辑"
              onClick={(event) => {
                event.stopPropagation()
                onSendToEdit({
                  cfi: item.cfi,
                  text: item.text,
                  translation: item.translation,
                  index: item.index,
                  block: item.block,
                })
              }}
            >
              送进编辑
            </button>
          )}
          <button
            className="ann-translate__close"
            aria-label="删除这条译文字"
            title="删除这条译文字（只删草稿，不动书里的正文）"
            onClick={(event) => {
              event.stopPropagation()
              removeInlineTranslation(item.cfi)
            }}
          >
            <Icon name="close" size={10} />
          </button>
        </div>
      ))}

      {selection && (
        <div
          className="ann-toolbar"
          style={{ left: selection.x, top: selection.y }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="ann-quote" title={selection.text}>
            {selection.text.length > 16 ? `${selection.text.slice(0, 16)}…` : selection.text}
          </span>
          {HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color.value}
              className="ann-swatch"
              data-tip={color.name}
              aria-label={color.name}
              style={{ background: color.value }}
              onClick={() => addHighlight(color.value)}
            />
          ))}
          <button
            className="ann-action icon-only"
            data-tip={translating ? '正在翻译…' : '把选中的文字翻译一下（草稿存进本书）'}
            aria-label="翻译选中的文字"
            disabled={translating}
            onClick={translateSelection}
          >
            <Icon name={translating ? 'hourglass_top' : 'translate'} size={16} />
          </button>
          <button
            className="ann-action icon-only"
            data-tip="为选中的文字写一条笔记"
            aria-label="写笔记"
            onClick={beginNote}
          >
            <Icon name="note_add" size={16} />
          </button>
          <button
            className="ann-action icon-only"
            data-tip="取消本次选择"
            aria-label="取消选择"
            onClick={clearSelection}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {shown && (
        <div
          className="ann-toolbar"
          style={{ left: shown.x, top: shown.y }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="ann-quote" title={shown.note ?? ''}>
            {shown.note
              ? shown.note.length > 18
                ? `${shown.note.slice(0, 18)}…`
                : shown.note
              : shown.hasColor
                ? '已高亮'
                : '标注'}
          </span>
          <button
            className="ann-action icon-only"
            data-tip={shown.note ? '修改这条标注的笔记' : '为这条标注写笔记'}
            aria-label="编辑笔记"
            onClick={beginEdit}
          >
            <Icon name={shown.note ? 'edit' : 'note_add'} size={16} />
          </button>
          <button
            className="ann-action icon-only danger"
            data-tip="删除这条标注"
            aria-label="删除标注"
            onClick={() => removeAnnotation(shown.cfi)}
          >
            <Icon name="delete" size={16} />
          </button>
          <button
            className="ann-action icon-only"
            data-tip="关闭标注工具条"
            aria-label="关闭"
            onClick={() => setShown(null)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {panelOpen && (
        <aside className="ann-panel" onMouseDown={(event) => event.stopPropagation()}>
          <header className="ann-panel__head">
            <Icon name="bookmarks" size={18} />
            <span className="ann-panel__title">标注面板</span>
            <span className="ann-panel__count">
              {annotationList.length + Object.keys(draftsRef.current).length} 条
            </span>
            <span className="grow" />
            <button
              className="btn icon-only tip-top"
              data-tip="关闭标注面板（Esc）"
              aria-label="关闭标注面板"
              onClick={() => setPanelOpen(false)}
            >
              <Icon name="close" size={16} />
            </button>
          </header>
          <div className="ann-panel__body">
            {panelGroups.length === 0 ? (
              <div className="ann-panel__empty">
                还没有高亮、笔记或划词译文。选中正文即可添加；非输入区按 Ctrl+Z 可撤销最近一次操作。
              </div>
            ) : (
              panelGroups.map((group) => (
                <section key={group.index} className="ann-group">
                  <h4 className="ann-group__title">
                    <span>{group.label}</span>
                    <span className="ann-group__count">{group.items.length}</span>
                  </h4>
                  {group.items.map((item) => (
                    <div key={`${item.kind}-${item.value}`} className="ann-item">
                      <button
                        className="ann-item__main"
                        data-tip={item.kind === 'draft' ? '跳转到这条译文对应的原文' : '跳转到这条标注'}
                        onClick={() => jumpToPanelItem(item)}
                      >
                        <span
                          className={`ann-item__dot ${item.kind}`}
                          style={
                            item.kind === 'annotation' && item.color
                              ? { background: item.color }
                              : undefined
                          }
                        />
                        <span className="ann-item__text">
                          {item.kind === 'annotation'
                            ? item.note || item.text
                            : item.translation}
                          <em>
                            {item.kind === 'draft' ? `原文：${item.text}` : item.text}
                          </em>
                        </span>
                      </button>
                      {item.kind === 'annotation' && item.state && item.state !== 'ok' && (
                        <span className={`ann-badge ${item.state}`}>
                          {item.state === 'orphan' ? '原文已删除' : '部分失效'}
                        </span>
                      )}
                      <div className="ann-item__actions">
                        {item.kind === 'annotation' && (
                          <button
                            className="ann-item__btn"
                            data-tip="编辑这条笔记"
                            aria-label="编辑笔记"
                            onClick={() => openNoteEditor(item.value)}
                          >
                            <Icon name="edit" size={14} />
                          </button>
                        )}
                        <button
                          className="ann-item__btn danger"
                          data-tip={item.kind === 'draft' ? '删除这条划词译文（可撤销）' : '删除这条标注（可撤销）'}
                          aria-label="删除"
                          onClick={() => removePanelItem(item)}
                        >
                          <Icon name="delete" size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </section>
              ))
            )}
          </div>
        </aside>
      )}

      {noteTarget && (
        <div className="note-mask" onClick={() => setNoteTarget(null)}>
          <div
            className="note-card"
            style={drag ? { transform: `translate(${drag.x}px, ${drag.y}px)` } : undefined}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="note-head" onPointerDown={startDrag} title="按住标题栏可拖动弹窗">
              <Icon name="drag_indicator" size={16} />
              <h3>{noteTarget.mode === 'edit' ? '修改笔记' : '写笔记'}</h3>
            </div>
            <blockquote className="note-quote">{noteTarget.text}</blockquote>
            <textarea
              autoFocus
              value={noteTarget.note}
              maxLength={NOTE_MAX_CHARS}
              placeholder={`写点什么（最多 ${NOTE_MAX_CHARS} 字），保存后会以小字贴在原文旁`}
              title="笔记内容"
              onChange={(event) =>
                setNoteTarget({ ...noteTarget, note: event.target.value })
              }
            />
            <div className="note-actions">
              {noteTarget.mode === 'edit' && (
                <button
                  className="btn danger-solid icon-only tip-top"
                  data-tip="删除这条标注与笔记"
                  aria-label="删除标注"
                  onClick={() => removeAnnotation(noteTarget.value)}
                >
                  <Icon name="delete" size={16} />
                </button>
              )}
              <span className="grow" />
              <button
                className="btn icon-only tip-top"
                data-tip="放弃本次编辑"
                aria-label="取消"
                onClick={() => setNoteTarget(null)}
              >
                <Icon name="close" size={16} />
              </button>
              <button
                className="btn primary icon-only tip-top"
                data-tip="保存笔记"
                aria-label="保存"
                onClick={saveNote}
              >
                <Icon name="check" size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
