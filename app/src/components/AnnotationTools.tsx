import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import Icon from './Icon'
import { Overlayer } from '../vendor/foliate-js/overlayer.js'
import {
  HIGHLIGHT_COLORS,
  loadAnnotations,
  saveAnnotations,
  type Annotation,
} from '../lib/annotations'
import type { Prefs } from '../lib/prefs'
import { translateConfigFromPrefs, translateOne } from '../lib/translate'

/** 译文字草稿 sessionStorage 前缀；关闭书本/软件自动消失 */
const TRANSLATE_DRAFT_PREFIX = 'scrollforge:read-translate:'

type RendererContents = { doc?: Document; index?: number }

type FoliateViewLike = HTMLElement & {
  renderer?: {
    getContents?: () => RendererContents[]
  }
  addAnnotation?: (annotation: Annotation) => Promise<unknown>
  deleteAnnotation?: (annotation: Annotation) => Promise<unknown>
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
  prefs: Prefs
  onNotify: (message: string) => void
}

type Selection = {
  cfi: string
  text: string
  index: number
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

/** 实时翻译草稿（sessionStorage，不持久化） */
type InlineTranslation = {
  /** 用 cfi 当 key；翻页/换位置都能跟上原文 */
  cfi: string
  /** 原文片段，用于 locateByText 定位 */
  text: string
  /** 译文 */
  translation: string
  /** 章节 index，用于过滤当前页 */
  index: number
  x: number
  y: number
  width: number
}

/** 把 InlineTranslation 存进 sessionStorage；key = bookKey + ':' + cfi */
function translateDraftKey(bookKey: string, cfi: string): string {
  return `${TRANSLATE_DRAFT_PREFIX}${bookKey}:${cfi}`
}
function loadTranslations(bookKey: string): Record<string, { text: string; translation: string; index: number }> {
  const out: Record<string, { text: string; translation: string; index: number }> = {}
  try {
    const pre = TRANSLATE_DRAFT_PREFIX + bookKey + ':'
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i)
      if (!key?.startsWith(pre)) continue
      const cfi = key.slice(pre.length)
      const raw = sessionStorage.getItem(key)
      if (!raw) continue
      try { out[cfi] = JSON.parse(raw) } catch { /* ignore */ }
    }
  } catch { /* sessionStorage 不可用时静默降级 */ }
  return out
}
function saveTranslation(bookKey: string, cfi: string, text: string, translation: string, index: number) {
  try {
    sessionStorage.setItem(translateDraftKey(bookKey, cfi), JSON.stringify({ text, translation, index }))
  } catch { /* ignore */ }
}
function removeTranslation(bookKey: string, cfi: string) {
  try { sessionStorage.removeItem(translateDraftKey(bookKey, cfi)) } catch { /* ignore */ }
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

/** 小字最多显示的字数，超出省略，点开可看全文 */
const NOTE_PREVIEW_CHARS = 46
/** 单条笔记字数上限 */
const NOTE_MAX_CHARS = 500

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

export default function AnnotationTools({ view, bookKey, prefs, onNotify }: Props) {
  const annotationsRef = useRef<Annotation[]>([])
  const [selection, setSelection] = useState<Selection | null>(null)
  const [shown, setShown] = useState<Shown | null>(null)
  const [noteTarget, setNoteTarget] = useState<NoteTarget | null>(null)
  const [inlineNotes, setInlineNotes] = useState<InlineNote[]>([])
  const [inlineTrans, setInlineTrans] = useState<InlineTranslation[]>([])
  const [translating, setTranslating] = useState(false)
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null)
  /** 小字刚被拖动过：随后的 click 不应打开弹窗 */
  const chipDraggedRef = useRef(false)

  const persist = useCallback(
    (list: Annotation[]) => {
      annotationsRef.current = list
      saveAnnotations(bookKey, list)
    },
    [bookKey],
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

  /** 把翻译草稿（sessionStorage）按当前页可见原文重铺贴边译文 */
  const syncTranslations = useCallback(() => {
    const el = view as FoliateViewLike | null
    if (!el?.renderer?.getContents) {
      setInlineTrans([])
      return
    }
    const drafts = loadTranslations(bookKey)
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
        const { x, y, width } = computeInlinePos(box)
        // 避免和笔记小字重叠
        const overlapWithNote = inlineNotesRef.current.some(
          (n) => Math.abs(n.x - x) < 40 && Math.abs(n.y - y) < 26,
        )
        let ny = y
        if (overlapWithNote) ny += 26
        next.push({
          cfi, text: draft.text, translation: draft.translation,
          index, x, y: ny, width,
        })
      }
    }
    setInlineTrans(next)
  }, [view, bookKey])

  const syncRef = useRef(syncInline)
  const inlineNotesRef = useRef<InlineNote[]>([])
  syncRef.current = syncInline
  inlineNotesRef.current = inlineNotes
  // 每次滚动/换页同时重排笔记和译文
  const scheduleAll = useCallback(() => {
    syncRef.current()
    syncTranslations()
  }, [syncTranslations])

  const removeAnnotation = useCallback(
    (value: string) => {
      const el = view as FoliateViewLike | null
      const target = annotationsRef.current.find((item) => item.value === value)
      if (target && el) void el.deleteAnnotation?.(target)
      persist(annotationsRef.current.filter((item) => item.value !== value))
      setShown(null)
      setNoteTarget(null)
      window.setTimeout(() => syncRef.current(), 0)
      onNotify('已删除标注')
    },
    [view, persist, onNotify],
  )

  // 事件接线：加载、换节、绘制、点击已有标注
  useEffect(() => {
    const el = view as FoliateViewLike | null
    if (!el) return

    const list = loadAnnotations(bookKey)
    annotationsRef.current = list
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
      const { x, y } = toolbarPos(rectOf(doc, range))
      setSelection({ cfi, text: text.slice(0, 600), index, x, y })
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
      // 连续滚动时正文不会重新分页，笔记和译文字都要跟着文字走
      doc.addEventListener('scroll', schedule, true)
      scrolled.add(doc)
    }

    const onLoad = (event: Event) => {
      const doc = (event as CustomEvent).detail?.doc as Document | undefined
      if (doc) attachDocument(doc)
      // 字体/分页稳定后位置会变，补两次重排，避免小字停在旧位置
      timers.push(window.setTimeout(schedule, 500), window.setTimeout(schedule, 1400))
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

    // 组件可能在首屏已加载后才挂上，补挂当前文档并补画当前节的标注
    const contents = el.renderer?.getContents?.() ?? []
    for (const entry of contents) {
      if (entry.doc) attachDocument(entry.doc)
    }
    const first = contents[0]
    if (first?.doc) {
      const index = first.index ?? 0
      for (const annotation of annotationsRef.current) {
        if (annotation.index === index) void el.addAnnotation?.(annotation)
      }
    }
    schedule()

    return () => {
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
  }, [view, bookKey])

  // Esc：优先收掉笔记/工具条，并拦住阅读页的"返回书架"
  useEffect(() => {
    if (!selection && !shown && !noteTarget) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (noteTarget) setNoteTarget(null)
      else if (shown) setShown(null)
      else clearSelection()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [selection, shown, noteTarget, clearSelection])

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

  const addHighlight = (color: string) => {
    if (!selection) return
    const annotation: Annotation = {
      value: selection.cfi,
      color,
      index: selection.index,
      text: selection.text,
      createdAt: Date.now(),
    }
    persist([...annotationsRef.current, annotation])
    void (view as FoliateViewLike | null)?.addAnnotation?.(annotation)
    clearSelection()
    onNotify('已添加高亮')
  }

  /** 阅读器实时翻译：调 translateOne，结果存 sessionStorage（草稿不持久化），刷新贴边译文 */
  const translateSelection = useCallback(async () => {
    if (!selection || translating) return
    setTranslating(true)
    const cfg = translateConfigFromPrefs(prefs)
    try {
      const outcome = await translateOne({
        config: cfg,
        source: selection.text,
        glossary: [],
      })
      saveTranslation(bookKey, selection.cfi, selection.text, outcome.text, selection.index)
      // 立即刷新译文字（scheduleAll 会在下一帧重排）
      scheduleAll()
      clearSelection()
      const engine = outcome.engine === 'online' ? '在线' : outcome.engine === 'local' ? '本地' : '记忆'
      onNotify(`已翻译（${engine} · ${outcome.elapsedMs.toFixed(0)}ms），关闭书本或软件后会消失`)
    } catch (err) {
      onNotify(`翻译失败：${String(err)}`)
    } finally {
      setTranslating(false)
    }
  }, [selection, translating, prefs, bookKey, scheduleAll, clearSelection, onNotify])

  const removeInlineTranslation = useCallback((cfi: string) => {
    removeTranslation(bookKey, cfi)
    scheduleAll()
  }, [bookKey, scheduleAll])

  const beginNote = () => {
    if (!selection) return
    setDrag(null)
    setNoteTarget({
      mode: 'new',
      value: selection.cfi,
      index: selection.index,
      text: selection.text,
      note: '',
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
      const updated: Annotation = { ...existing, note: note || undefined, updatedAt: Date.now() }
      persist(annotationsRef.current.map((item) => (item.value === updated.value ? updated : item)))
      void el?.addAnnotation?.(updated)
    } else if (note) {
      const annotation: Annotation = {
        value: noteTarget.value,
        index: noteTarget.index,
        text: noteTarget.text,
        note,
        createdAt: Date.now(),
      }
      persist([...annotationsRef.current, annotation])
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
          data-tip="译文字草稿，关闭书本或软件后消失"
          aria-label="翻译草稿"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Icon name="translate" size={13} />
          <span className="ann-translate__text">{item.translation}</span>
          <button
            className="ann-translate__close"
            aria-label="删除这条译文字"
            title="删除这条译文字（关闭书本也会自动消失）"
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
            data-tip={translating ? '正在翻译…' : '把选中的文字翻译一下（草稿，关闭后消失）'}
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
