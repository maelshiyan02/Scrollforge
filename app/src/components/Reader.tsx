import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import '../vendor/foliate-js/view.js'
import { FootnoteHandler } from '../vendor/foliate-js/footnotes.js'
import AnnotationTools from './AnnotationTools'
import ForgePanel from './ForgePanel'
import EpubEditPanel from './EpubEditPanel'
import Icon from './Icon'
import ImageViewer, { type ViewerImage } from './ImageViewer'
import { decodeText } from '../lib/encoding'
import { toPlainText } from '../lib/book-text'
import { analyzeTxt, type TxtAnalysis } from '../lib/txt-chapters'
import { buildTxtBook } from '../lib/txt-book'
import { buildEpub, bytesToBase64 } from '../lib/epub-writer'
import type { Prefs } from '../lib/prefs'
import { nextTheme, themeLabel } from '../lib/prefs'
import { applyReaderTheme, applyTheme } from '../lib/theme'
import { readPageImages, releaseImages, type PageImage } from '../lib/gallery'
import { applyTypography, clampFontSize, DEFAULT_TYPOGRAPHY } from '../lib/typography'
import { clearProgress, progressKeyOf, readProgress, writeProgress } from '../lib/progress'
import { forgetCover } from '../lib/cover'
import { formatLabel, isDirectFormat } from '../lib/formats'
import type { ReaderSource, TocEntry, Typography } from '../types'

type FoliateView = HTMLElement & {
  open: (book: File | string | any) => Promise<void>
  init: (opts: { lastLocation?: unknown; showTextStart?: boolean }) => Promise<void>
  goTo: (target: unknown) => Promise<void>
  goToFraction: (fraction: number) => Promise<void>
  next: () => Promise<void>
  prev: () => Promise<void>
  close: () => void
  book: any
  renderer: any
  lastLocation: any
}

type RawTocItem = {
  label?: string
  href?: string
  subitems?: RawTocItem[]
}

type Footnote = {
  type: string | null
  hidden: boolean
  href: string
}

function footnoteLabel(type: string | null): string {
  if (type === 'endnote') return '尾注'
  if (type === 'biblioentry') return '参考条目'
  if (type === 'definition') return '词义'
  if (type === 'note') return '注释'
  return '脚注'
}

type Props = {
  source: ReaderSource
  typography: Typography
  onTypography: (value: Typography) => void
  onBack: () => void
  onOpenEpub: () => void
  onNotify: (message: string) => void
  libraryDir?: string | null
  /** 最终成品文件夹：编辑面板「另存为」的默认位置 */
  exportDir?: string | null
  /** 阅读/编辑偏好（默认翻页方式、竖排、编辑器字号等） */
  prefs: Prefs
  /** 修改偏好（顶栏主题按钮用） */
  onPrefs: (patch: Partial<Prefs>) => void
  /** F1 说明书（iframe 内按键不会冒泡到窗口，需要在这里转发） */
  onHelp?: () => void
  /** 非空且匹配 source.meta.id 时，自动打开编辑面板（一次性消费） */
  autoEditBookId?: string | null
  onAutoEditConsumed?: () => void
}

function flattenToc(items: RawTocItem[] | undefined, depth = 0): TocEntry[] {
  if (!items?.length) return []
  const out: TocEntry[] = []
  items.forEach((item, index) => {
    const label = (item.label ?? '').trim() || `第 ${index + 1} 节`
    if (item.href) out.push({ label, href: item.href, depth })
    else if (item.subitems?.length) out.push({ label, href: '', depth, group: true })
    out.push(...flattenToc(item.subitems, depth + 1))
  })
  return out
}

/** href 比较用：去掉 #片段 并解码，避免 nav 与 relocate 的编码差异导致对不上 */
function hrefKey(href: string | undefined | null): string {
  if (!href) return ''
  let value = href
  try {
    value = decodeURIComponent(value)
  } catch {
    // 非法编码就按原样比
  }
  return value.split('#')[0]
}

/** 封面页：打开新书时优先停在这里 */
const COVER_PAGE_RE = /(^|\/)(cover|cover[-_.]?\w*)\.[a-z]+$/i
/** 前置页：封面、书名页、简介、目录页都不算正文起点 */
const FRONT_PAGE_RE = /(^|\/)(cover|cover[-_.]?\w*|title_?page|titlepage|intro|about|preface|foreword|nav|toc|contents)\.[a-z]+$/i

function findCoverHref(sections: any[] | undefined, toc: any[] | undefined): string | undefined {
  const fromToc = toc?.find((entry: any) => entry?.href && COVER_PAGE_RE.test(hrefKey(entry.href)))
  if (fromToc) return fromToc.href
  const section = sections?.find((item: any) => COVER_PAGE_RE.test(hrefKey(item?.id)))
  return section?.id
}

function findFirstBodyHref(sections: any[] | undefined, toc: any[] | undefined): string | undefined {
  const fromToc = toc?.find((entry: any) => entry?.href && !FRONT_PAGE_RE.test(hrefKey(entry.href)))
  if (fromToc) return fromToc.href
  const section = sections?.find((item: any) => item?.id && !FRONT_PAGE_RE.test(hrefKey(item.id)))
  return section?.id
}

function isCoverSection(sections: any[] | undefined, index: unknown): boolean {
  const sectionId = typeof index === 'number' ? sections?.[index]?.id : undefined
  return !!sectionId && COVER_PAGE_RE.test(hrefKey(sectionId))
}

/** 固定版式页面的原始尺寸：优先 viewport meta，其次页内图片的自然尺寸 */
function pageSizeOf(doc: any): { width: number; height: number } | null {
  if (!doc?.documentElement) return null
  const meta = doc.querySelector?.('meta[name="viewport"]')?.getAttribute?.('content') ?? ''
  const width = Number(/(?:^|[\s,;])width=([0-9.]+)/.exec(meta)?.[1])
  const height = Number(/(?:^|[\s,;])height=([0-9.]+)/.exec(meta)?.[1])
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height }
  }
  const img = doc.querySelector?.('img')
  if (img?.naturalWidth > 0 && img?.naturalHeight > 0) {
    return { width: img.naturalWidth, height: img.naturalHeight }
  }
  return null
}


/** 当前阅读位置在可跳转目录里的下标；先按 tocItem，再按 section id 兜底 */
function chapterIndexOf(detail: any, list: TocEntry[], sections: any[] | undefined): number {
  if (!list.length) return -1
  const byToc = hrefKey(detail?.tocItem?.href)
  if (byToc) {
    const index = list.findIndex((entry) => hrefKey(entry.href) === byToc)
    if (index >= 0) return index
  }
  const sectionIndex = detail?.section?.current
  const sectionId = typeof sectionIndex === 'number' ? sections?.[sectionIndex]?.id : undefined
  const bySection = hrefKey(sectionId)
  if (bySection) {
    const index = list.findIndex((entry) => hrefKey(entry.href) === bySection)
    if (index >= 0) return index
  }
  return -1
}

function displayName(source: ReaderSource): string {
  if (source.kind === 'library') return source.meta.title
  return source.name.replace(/\.[a-z0-9]+$/i, '')
}

function formatOf(source: ReaderSource): string {
  if (source.kind === 'library') return (source.meta.format || 'txt').toLowerCase()
  return (source.name.split('.').pop() ?? 'txt').toLowerCase()
}

export default function Reader({
  source,
  typography,
  onTypography,
  onBack,
  onOpenEpub,
  onNotify,
  libraryDir,
  exportDir,
  prefs,
  onPrefs,
  onHelp,
  autoEditBookId,
  onAutoEditConsumed,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<FoliateView | null>(null)
  const docsRef = useRef<Set<any>>(new Set())
  const saveEnabledRef = useRef(false)
  const keyRef = useRef(progressKeyOf(source))
  const verticalRef = useRef(prefs.readerVertical)
  const typographyRef = useRef(typography)
  const themeRef = useRef(prefs.theme)
  const flowRef = useRef<'paginated' | 'scrolled'>(prefs.readerFlow)
  const doubleRef = useRef(prefs.readerDoublePage)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const helpRef = useRef(onHelp)
  helpRef.current = onHelp
  const tocRef = useRef<TocEntry[]>([])
  const progressTrackRef = useRef<HTMLDivElement>(null)
  const progressDraggingRef = useRef(false)
  /** 目录第一条正文，用于封面页「开始阅读」 */
  const firstBodyRef = useRef<string | undefined>(undefined)

  const [title, setTitle] = useState(displayName(source))
  const [chapter, setChapter] = useState('')
  const [percent, setPercent] = useState(0)
  const [vertical, setVertical] = useState(prefs.readerVertical)
  const [doublePage, setDoublePage] = useState(prefs.readerDoublePage)
  const [flow, setFlow] = useState<'paginated' | 'scrolled'>(prefs.readerFlow)
  const [toc, setToc] = useState<TocEntry[]>([])
  const [chapterIndex, setChapterIndex] = useState(-1)
  const [onCover, setOnCover] = useState(false)
  const [fractionKnown, setFractionKnown] = useState(false)
  const [dragPercent, setDragPercent] = useState<number | null>(null)
  const [tocOpen, setTocOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [meta, setMeta] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [viewEl, setViewEl] = useState<FoliateView | null>(null)
  const [footnote, setFootnote] = useState<Footnote | null>(null)
  const [forgeOpen, setForgeOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const editDirtyRef = useRef(false)
  // 最近一次 relocate 的位置，用于「阅读 → 编辑」时对齐章节与段落
  const lastLocRef = useRef<any>(null)
  const [editSeed, setEditSeed] = useState<{ href?: string; block?: number } | null>(null)
  /** 非 EPUB 书：转出的工作副本 EPUB 路径（编辑保存落在它上面） */
  const [workingEpub, setWorkingEpub] = useState<string | null>(null)
  const [preparingEdit, setPreparingEdit] = useState(false)
  const [forgeData, setForgeData] = useState<{ text: string; analysis: TxtAnalysis; encoding: string } | null>(null)
  /** S6：EPUB 源 ForgePanel 映射表 + 编辑解压目录 */
  const [forgeEpubFlat, setForgeEpubFlat] = useState<{ chapterIndex: number; paragraphIndex: number; relPath: string; blockIndex: number; text: string }[] | null>(null)
  const [forgeEpubEditDir, setForgeEpubEditDir] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [galleryLoading, setGalleryLoading] = useState(false)
  const [galleryItems, setGalleryItems] = useState<PageImage[]>([])
  const [viewer, setViewer] = useState<{ items: ViewerImage[]; index: number } | null>(null)
  // 固定版式（PDF / 漫画 / 固定版式 EPUB）：整页缩放，不调字号
  const [fixedLayout, setFixedLayout] = useState(false)
  const [fixedZoom, setFixedZoom] = useState<'fit-page' | 'fit-width' | number>('fit-page')
  const fixedLayoutRef = useRef(false)
  const fixedZoomRef = useRef<'fit-page' | 'fit-width' | number>('fit-page')
  const lastDocRef = useRef<any>(null)
  const imageClickRef = useRef<(event: Event) => void>(() => {})
  const sourceFormat = formatOf(source)
  /** 可进入编辑：书库内 EPUB 直接编辑；文本格式先生成工作副本 EPUB 再编辑 */
  const editableFormat = source.kind === 'library'
    && (sourceFormat === 'epub' || ['txt', 'md', 'html', 'fb2'].includes(sourceFormat))
  const imageFormat = ['epub', 'cbz', 'zip'].includes(sourceFormat)
  const galleryAvailable = imageFormat && source.kind === 'library'
  const galleryHint = !imageFormat
    ? sourceFormat === 'pdf'
      ? 'PDF 是固定版式，用工具栏的「整页缩放」查看，没有插图画廊'
      : `${formatLabel(sourceFormat)} 是纯文本格式，没有内嵌插图`
    : '彩页浏览只支持从书架打开的图书'
  const galleryTip = galleryAvailable
    ? '彩页与插图：单独浏览书里的整页大图'
    : galleryHint

  // ─── 自动打开编辑面板（从 Shelf 右键跳转时，放到 seedFromReading 之后处理） ───

  const footnoteHostRef = useRef<HTMLDivElement>(null)
  const footnoteRef = useRef<Footnote | null>(null)
  const footnoteViewRef = useRef<FoliateView | null>(null)
  // 书籍正文在 iframe 里，键盘事件不会冒泡到顶层窗口，需要在每个文档里再挂一份
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {})
  // 滚轮同理：iframe 内的滚轮不会冒泡到窗口
  const wheelHandlerRef = useRef<(event: WheelEvent) => void>(() => {})
  const closeFootnote = useCallback(() => {
    const current = footnoteViewRef.current
    if (current) {
      try {
        current.close()
      } catch {
        // 已经销毁就忽略
      }
      current.remove()
      footnoteViewRef.current = null
    }
    setFootnote(null)
  }, [])

  footnoteRef.current = footnote

  typographyRef.current = typography
  themeRef.current = prefs.theme

  const paintDoc = useCallback((doc: any) => {
    if (!doc?.documentElement) return
    const isVertical = verticalRef.current
    doc.documentElement.style.setProperty(
      'writing-mode',
      isVertical ? 'vertical-rl' : 'horizontal-tb',
      'important',
    )
    doc.documentElement.style.setProperty(
      'text-orientation',
      isVertical ? 'mixed' : 'initial',
      'important',
    )
    applyTypography(doc, typographyRef.current)
    applyReaderTheme(doc, themeRef.current)
  }, [])

  /** 固定版式整页缩放：数值 = 「适应整页」的倍数，换算成绝对 scale 交给渲染器 */
  const applyFixedZoom = useCallback(() => {
    const renderer = viewRef.current?.renderer
    if (!renderer || !fixedLayoutRef.current) return
    const mode = fixedZoomRef.current
    if (mode === 'fit-page' || mode === 'fit-width') {
      renderer.setAttribute('zoom', mode)
      return
    }
    const size = pageSizeOf(lastDocRef.current)
    const host = hostRef.current
    if (!size || !host) return
    const fit = Math.min(host.clientWidth / size.width, host.clientHeight / size.height)
    if (!Number.isFinite(fit) || fit <= 0) return
    renderer.setAttribute('zoom', String(fit * mode))
  }, [])

  // 窗口大小变化时，固定版式的缩放要重新算
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const observer = new ResizeObserver(() => applyFixedZoom())
    observer.observe(host)
    return () => observer.disconnect()
  }, [applyFixedZoom])

  useEffect(() => {
    fixedZoomRef.current = fixedZoom
    applyFixedZoom()
  }, [fixedZoom, applyFixedZoom])

  // 创建 foliate 视图并注册事件（每个 Reader 实例只跑一次）
  useEffect(() => {
    const host = hostRef.current
    if (!host || viewRef.current) return

    const el = document.createElement('foliate-view') as FoliateView
    el.style.display = 'block'
    el.style.width = '100%'
    el.style.height = '100%'
    host.appendChild(el)
    viewRef.current = el
    setViewEl(el)

    el.addEventListener('load', (event: Event) => {
      const doc = (event as CustomEvent).detail?.doc
      if (doc) {
        docsRef.current.add(doc)
        lastDocRef.current = doc
        // iframe 内的按键不会冒泡到窗口，这里补一份转发
        doc.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'F1') {
            e.preventDefault()
            helpRef.current?.()
            return
          }
          keyHandlerRef.current(e)
        })
        doc.addEventListener('wheel', (e: WheelEvent) => wheelHandlerRef.current(e), {
          passive: false,
        })
        // 内嵌图片点击 → 全屏看图（同一文档里的图片可左右切换）
        doc.addEventListener('click', (e: Event) => imageClickRef.current(e))
        // 图片给个「可点」的鼠标提示；每个文档只插一次
        if (!doc.__sfImageCursor && doc.head) {
          const style = doc.createElement('style')
          style.textContent = 'img { cursor: zoom-in; }'
          doc.head.appendChild(style)
          doc.__sfImageCursor = true
        }
        paintDoc(doc)
        requestAnimationFrame(() => applyFixedZoom())
      }
    })

    el.addEventListener('relocate', (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {}
      lastLocRef.current = detail
      const fraction = typeof detail.fraction === 'number' ? detail.fraction : 0
      if (typeof detail.fraction === 'number') setFractionKnown(true)
      setPercent(Math.round(fraction * 100))
      setChapterIndex(chapterIndexOf(detail, tocRef.current, viewRef.current?.book?.sections))
      setOnCover(isCoverSection(viewRef.current?.book?.sections, detail?.section?.current))
      const label = detail.tocItem?.label
      if (label) setChapter(String(label).trim())
      if (saveEnabledRef.current && keyRef.current && detail.cfi) {
        writeProgress(keyRef.current, detail.cfi, fraction)
      }
    })

    return () => {
      el.close()
      el.remove()
      viewRef.current = null
      docsRef.current.clear()
      setViewEl(null)
    }
    // 只在挂载时创建一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 脚注：由 vendor 的 FootnoteHandler 抽取片段，我们只负责气泡外壳
  useEffect(() => {
    const view = viewEl
    if (!view) return
    // vendor 是 JS，类型信息不全，这里按实际用法声明
    const handler: {
      handle: (book: unknown, event: CustomEvent) => Promise<unknown> | undefined
      addEventListener: (type: string, listener: (event: Event) => void) => void
      removeEventListener: (type: string, listener: (event: Event) => void) => void
    } = new FootnoteHandler()
    const onLink = (event: Event) => {
      const book = view.book
      if (!book) return
      const pending = handler.handle(book, event as CustomEvent)
      if (pending) {
        void pending.catch((err: unknown) => {
          console.warn(err)
          onNotify('脚注打开失败')
        })
      }
    }
    const onRender = (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {}
      setFootnote({
        type: (detail.type as string | null) ?? null,
        hidden: Boolean(detail.hidden),
        href: String(detail.href ?? ''),
      })
    }
    // 临时视图默认脱离文档，尺寸为 0 时渲染不出内容。
    // 在渲染前先把它塞进气泡里的固定尺寸容器，这样分页器才算得出栏宽。
    const onBeforeRender = (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {}
      const host = footnoteHostRef.current
      const next = detail.view as FoliateView | undefined
      if (!host || !next) return
      const previous = footnoteViewRef.current
      if (previous && previous !== next) {
        try {
          previous.close()
        } catch {
          // 已经销毁就忽略
        }
        previous.remove()
      }
      next.style.display = 'block'
      next.style.width = '100%'
      next.style.height = '100%'
      next.addEventListener('load', (e: Event) => {
        const doc = (e as CustomEvent).detail?.doc
        if (doc) {
          doc.addEventListener('keydown', (ev: KeyboardEvent) => {
            if (ev.key === 'F1') {
              ev.preventDefault()
              helpRef.current?.()
              return
            }
            keyHandlerRef.current(ev)
          })
        }
      })
      host.replaceChildren(next)
      footnoteViewRef.current = next
    }
    view.addEventListener('link', onLink)
    handler.addEventListener('before-render', onBeforeRender)
    handler.addEventListener('render', onRender)
    return () => {
      view.removeEventListener('link', onLink)
      handler.removeEventListener('before-render', onBeforeRender)
      handler.removeEventListener('render', onRender)
      setFootnote(null)
    }
  }, [viewEl, onNotify])

  // 打开当前来源
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError('')
      saveEnabledRef.current = false
      setFractionKnown(false)
      setChapterIndex(-1)
      const saved = readProgress(keyRef.current)
      if (saved) setPercent(Math.round(saved.fraction * 100))

      const loadSource = async () => {
        view.close()
        docsRef.current.clear()

        let tocEntries: TocEntry[] = []
        let extraMeta = ''
        const bookTitle = displayName(source)

        const format = formatOf(source)
        // zip 只有改名成 .cbz 才会命中 foliate 的漫画分支
        const directName = (name: string) =>
          format === 'zip' ? name.replace(/\.zip$/i, '.cbz') : name

        if (isDirectFormat(format)) {
          if (source.kind === 'file') {
            const file = source.file
            await view.open(format === 'zip' ? new File([file], directName(file.name), { type: file.type }) : file)
          } else {
            const buffer = await invoke<ArrayBuffer>('read_book_bytes', { id: source.meta.id })
            if (cancelled) return
            const name = directName(source.meta.sourceName || `${bookTitle}.${format}`)
            await view.open(new File([new Uint8Array(buffer)], name))
          }
          // ─── S6：EPUB 书也生成 ForgePanel 数据（调 forge_epub_index） ───
          if (format === 'epub' && source.kind === 'library') {
            try {
              const dir = (libraryDir ?? '').replace(/[\\/]$/, '')
              const epubPath = source.meta.path || (dir ? `${dir}/${source.meta.id}/source.epub` : '')
              const editDir = dir ? `${dir}/${source.meta.id}/forge_edit` : ''
              if (epubPath && editDir) {
                const idx = await invoke<{ text: string; analysis: any; flatBlocks: any[]; editDir: string }>(
                  'forge_epub_index',
                  { epubPath, editDir },
                )
                if (cancelled) return
                if (idx.analysis?.chapters?.length > 0) {
                  setForgeData({ text: idx.text, analysis: idx.analysis as TxtAnalysis, encoding: 'UTF-8' })
                  setForgeEpubFlat(idx.flatBlocks)
                  setForgeEpubEditDir(editDir)
                } else {
                  setForgeData(null); setForgeEpubFlat(null); setForgeEpubEditDir(null)
                }
              } else {
                setForgeData(null); setForgeEpubFlat(null); setForgeEpubEditDir(null)
              }
            } catch (err) {
              console.warn('forge_epub_index 失败：', err)
              setForgeData(null); setForgeEpubFlat(null); setForgeEpubEditDir(null)
            }
          } else {
            setForgeData(null); setForgeEpubFlat(null); setForgeEpubEditDir(null)
          }
          extraMeta = formatLabel(format)
        } else {
          let buffer: ArrayBuffer
          if (source.kind === 'file') {
            buffer = await source.file.arrayBuffer()
          } else {
            buffer = await invoke<ArrayBuffer>('read_book_bytes', { id: source.meta.id })
          }
          if (cancelled) return
          const decoded = decodeText(buffer)
          // Markdown / HTML 先归一化成纯文本，再共用 TXT 的章节识别与排版
          const plain = toPlainText(decoded.text, format)
          const analysis = analyzeTxt(plain)
          if (cancelled) return
          if (!analysis.chapters.some((chapter) => chapter.paragraphs.length > 0)) {
            throw new Error('这本书没有可显示的文字')
          }
          // 只有书库里的 TXT 才有锻造的源文件可写回
          if (source.kind === 'library' && format === 'txt') {
            setForgeData({ text: decoded.text, analysis, encoding: decoded.encoding })
          } else {
            setForgeData(null)
          }
          const built = await buildTxtBook(bookTitle, analysis.chapters, analysis.headingCount)
          if (cancelled) return
          await view.open(built.book)
          tocEntries = built.toc.map((entry) => ({ ...entry, depth: 0 }))
          const label = formatLabel(format)
          extraMeta = analysis.fallback
            ? `${label} · 未识别到章节 · ${decoded.encoding}`
            : `${label} · ${built.headingCount} 章 · ${decoded.encoding}`
        }

        // 固定版式（PDF / 漫画 / 固定版式 EPUB）用整页缩放，文字类书籍用字号排版
        const isFixed = Boolean(view.book?.rendition?.layout === 'pre-paginated')
        fixedLayoutRef.current = isFixed
        setFixedLayout(isFixed)

        if (cancelled) return null
        return { tocEntries, extraMeta, bookTitle, format }
      }

      const applyViewOptions = () => {
        if (flowRef.current) view.renderer?.setAttribute('flow', flowRef.current)
        view.renderer?.setAttribute('max-column-count', doubleRef.current ? '2' : '1')
      }

      try {
        let loaded = await loadSource()
        if (!loaded) return
        applyViewOptions()

        // 有历史进度就回原位；没有历史进度时优先停在封面页（无封面则从第一条正文开始）。
        // 不再无条件跳过封面/书名页/nav：那些页面本身就是书籍结构的一部分。
        const isEpub = loaded.format === 'epub'
        const sections = view.book?.sections
        const coverHref = isEpub ? findCoverHref(sections, view.book?.toc) : undefined
        const firstBodyHref = isEpub ? findFirstBodyHref(sections, view.book?.toc) : undefined
        firstBodyRef.current = firstBodyHref
        const startTarget = saved?.cfi ?? coverHref ?? firstBodyHref

        try {
          await view.init({ lastLocation: startTarget, showTextStart: !startTarget })
        } catch (initError) {
          // 进度 CFI 或封面/正文首条可能和这本书对不上（例如旧版曾按 TXT 打开过），
          // 清掉进度、重新装载一次，保证书一定能打开；仍按「封面优先」落位。
          if (!startTarget) throw initError
          clearProgress(keyRef.current)
          loaded = await loadSource()
          if (!loaded) return
          applyViewOptions()
          const fallbackTarget = coverHref ?? firstBodyHref
          await view.init({ lastLocation: fallbackTarget, showTextStart: !fallbackTarget })
        }
        if (cancelled) return

        setOnCover(isCoverSection(view.book?.sections, view.lastLocation?.section?.current))
        requestAnimationFrame(() => applyFixedZoom())

        let tocEntries = loaded.tocEntries
        saveEnabledRef.current = true
        const cfi = view.lastLocation?.cfi
        if (cfi) writeProgress(keyRef.current, cfi, view.lastLocation?.fraction ?? 0)

        if (!tocEntries.length && view.book?.toc) {
          tocEntries = flattenToc(view.book.toc)
        }
        tocRef.current = tocEntries
        setChapterIndex(chapterIndexOf(lastLocRef.current, tocEntries, view.book?.sections))
        setToc(tocEntries)
        setMeta(loaded.extraMeta)
        setTitle(loaded.bookTitle)
        setLoading(false)
        // 锻造写回后重载时不再提示位置，避免盖掉"已保存"的提示
        if (reloadToken === 0) onNotify(saved?.cfi ? '已回到上次位置' : '已打开')
      } catch (err) {
        if (cancelled) return
        console.error(err)
        const raw = String((err as Error)?.message ?? err)
        const message = raw.includes('File type not supported')
          ? '不支持这种文件格式，请在「设置 · 导入格式」里检查是否已勾选对应扩展名'
          : raw.includes('Failed to load container') || raw.includes('XML parsing error')
            ? '书籍结构损坏，无法打开'
            : raw.includes('File not found')
              ? '文件为空或找不到'
              : raw.includes('没有可显示的文字')
                ? '这本书没有可显示的文字'
                : raw
        setError(`打开失败：${message}`)
        setLoading(false)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
    // source 变化时由上层用 key 重新挂载 Reader；reloadToken 用于锻造写回后重新读取源文件
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken])

  // 方向切换：所有已加载文档 + 后续文档
  useEffect(() => {
    verticalRef.current = vertical
    docsRef.current.forEach((doc) => paintDoc(doc))
    viewRef.current?.renderer?.render?.()
  }, [vertical, paintDoc])

  // 分页/滚动与单双页
  useEffect(() => {
    flowRef.current = flow
    const renderer = viewRef.current?.renderer
    if (!renderer) return
    renderer.setAttribute('flow', flow)
    renderer.setAttribute('max-column-count', doublePage ? '2' : '1')
    renderer.render?.()
  }, [flow, doublePage])

  // 排版设置
  useEffect(() => {
    typographyRef.current = typography
    docsRef.current.forEach((doc) => applyTypography(doc, typography))
    viewRef.current?.renderer?.render?.()
  }, [typography])

  // 主题切换：正文底色与文字色跟着外壳走
  useEffect(() => {
    themeRef.current = prefs.theme
    applyTheme(prefs.theme)
    docsRef.current.forEach((doc) => applyReaderTheme(doc, prefs.theme))
    // foliate 的分页器自己有一层铺底（页面四周的留白），不会随 iframe 变色；
    // 调用 vendor 里新增的 refreshBackground 让它按章节文档的实际底色重刷
    const renderer = viewRef.current?.renderer as { refreshBackground?: () => void } | undefined
    renderer?.refreshBackground?.()
  }, [prefs.theme])

  const flip = useCallback(
    async (dir: 1 | -1) => {
      const view = viewRef.current
      if (!view?.book) return
      try {
        if (dir === 1) await view.next()
        else await view.prev()
      } catch (err) {
        console.warn(err)
      }
    },
    [],
  )

  /**
   * 章级跳转：以当前 relocate 的 tocItem 在可跳转目录里定位，
   * 跳过无 href 的分组条目；首末章由按钮禁用挡住。
   */
  const jumpChapter = useCallback(
    async (dir: 1 | -1) => {
      const view = viewRef.current
      const list = tocRef.current
      if (!view?.book || !list.length) return
      const index = chapterIndexOf(lastLocRef.current, list, view.book?.sections)
      if (index < 0) return
      let target = index + dir
      while (target >= 0 && target < list.length && list[target].group) target += dir
      if (target < 0 || target >= list.length) return
      try {
        await view.goTo(list[target].href)
      } catch (err) {
        console.warn(err)
        onNotify('章节跳转失败')
      }
    },
    [onNotify],
  )

  // ─── 底部进度条：按下/移动只改预览，松手才真正跳转 ───

  const percentAt = (clientX: number) => {
    const track = progressTrackRef.current
    if (!track) return 0
    const rect = track.getBoundingClientRect()
    const ratio = (clientX - rect.left) / Math.max(1, rect.width)
    return Math.max(0, Math.min(100, ratio * 100))
  }

  const commitPercent = (value: number) => {
    const view = viewRef.current
    if (!view) return
    void view.goToFraction(value / 100).catch((err: unknown) => {
      console.warn(err)
      onNotify('进度跳转失败')
    })
  }

  const onProgressDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    progressDraggingRef.current = true
    setDragPercent(Math.round(percentAt(event.clientX)))
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 合成指针或已释放时忽略
    }
  }

  const onProgressMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!progressDraggingRef.current) return
    event.stopPropagation()
    setDragPercent(Math.round(percentAt(event.clientX)))
  }

  const onProgressUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!progressDraggingRef.current) return
    event.stopPropagation()
    const value = Math.round(percentAt(event.clientX))
    progressDraggingRef.current = false
    setDragPercent(null)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 指针已释放时忽略
    }
    commitPercent(value)
  }

  const onProgressCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!progressDraggingRef.current) return
    progressDraggingRef.current = false
    setDragPercent(null)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 指针已释放时忽略
    }
  }

  const jumpTo = useCallback(async (href: string) => {
    const view = viewRef.current
    if (!view || !href) return
    try {
      await view.goTo(href)
      setTocOpen(false)
    } catch (err) {
      console.warn(err)
    }
  }, [])

  /** 封面页「开始阅读」：跳到目录第一条正文 */
  const startReading = useCallback(async () => {
    const view = viewRef.current
    const href = firstBodyRef.current
    if (!view || !href) return
    try {
      await view.goTo(href)
    } catch (err) {
      console.warn(err)
      onNotify('无法进入正文')
    }
  }, [onNotify])

  /** 正文里点图片 → 全屏查看；同一文档内的图片可用 ←/→ 切换 */
  const onDocImageClick = useCallback((event: Event) => {
    const target = event.target as any
    const img = target?.closest?.('img') as HTMLImageElement | null
    if (!img) return
    if (!(img.naturalWidth >= 64 && img.naturalHeight >= 64)) return
    const doc = img.ownerDocument
    const list = Array.from(doc.querySelectorAll('img')) as HTMLImageElement[]
    const usable = list.filter(
      (item) => item.naturalWidth >= 64 && item.naturalHeight >= 64 && (item.currentSrc || item.src),
    )
    const index = usable.indexOf(img)
    if (index < 0) return
    event.preventDefault()
    event.stopPropagation()
    setViewer({
      items: usable.map((item, order) => ({
        url: item.currentSrc || item.src,
        width: item.naturalWidth,
        height: item.naturalHeight,
        label: `插图 ${order + 1}`,
      })),
      index,
    })
  }, [])
  imageClickRef.current = onDocImageClick

  // 彩页面板：EPUB 取 manifest 大图，CBZ/ZIP 按页取图
  const openGallery = useCallback(async () => {
    if (!galleryAvailable) {
      onNotify(galleryHint)
      return
    }
    if (source.kind !== 'library') {
      onNotify(galleryHint)
      return
    }
    setGalleryOpen(true)
    if (galleryItems.length > 0) return
    setGalleryLoading(true)
    try {
      const items = await readPageImages(source.meta)
      setGalleryItems(items)
      if (items.length === 0) {
        onNotify(imageFormat ? '这本书里没有找到彩页或插图' : galleryHint)
      }
    } catch (err) {
      onNotify(`读取彩页失败：${String(err)}`)
    } finally {
      setGalleryLoading(false)
    }
  }, [galleryAvailable, galleryHint, galleryItems.length, imageFormat, onNotify, source])

  // 组件卸载时释放图片 blob，避免占着内存
  useEffect(() => {
    return () => releaseImages(galleryItems)
  }, [galleryItems])

  // 快捷键：翻页、Esc 关面板
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'SELECT') return
      // 全屏看图优先：←/→ 切图，Esc 退出，不再翻页
      if (viewer) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setViewer(null)
        } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
          event.preventDefault()
          setViewer((value) =>
            value ? { ...value, index: Math.min(value.items.length - 1, value.index + 1) } : value,
          )
        } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
          event.preventDefault()
          setViewer((value) =>
            value ? { ...value, index: Math.max(0, value.index - 1) } : value,
          )
        }
        return
      }
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault()
        void flip(vertical ? -1 : 1)
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        void flip(vertical ? 1 : -1)
      } else if (event.key === 'Escape') {
        if (footnoteRef.current) closeFootnote()
        else if (galleryOpen) setGalleryOpen(false)
        else if (settingsOpen) setSettingsOpen(false)
        else if (tocOpen) setTocOpen(false)
        else onBack()
      }
    }
    window.addEventListener('keydown', onKey)
    keyHandlerRef.current = onKey
    return () => {
      window.removeEventListener('keydown', onKey)
      keyHandlerRef.current = () => {}
    }
  }, [flip, vertical, settingsOpen, tocOpen, onBack, closeFootnote, galleryOpen, viewer])

  // 滚轮翻页 + Ctrl+滚轮缩放字号（窗口与 iframe 各挂一份）
  useEffect(() => {
    let lastFlip = 0
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null
      // 面板内部滚动（目录、排版、笔记、锻造）不抢滚轮
      if (
        target?.closest?.(
          '.edit-panel, .typo-panel, .toc-panel, .footnote-pop, .forge-panel, .note-card, .note-mask, .ann-toolbar, .gallery-panel, .gallery-viewer, .read-progress',
        )
      ) {
        return
      }
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        // 固定版式不支持改字号：Ctrl+滚轮按倍数缩放整页
        if (fixedLayoutRef.current) {
          if (!prefsRef.current.experimentalFixedWheelZoom) return
          const current = typeof fixedZoomRef.current === 'number' ? fixedZoomRef.current : 1
          const step = event.deltaY > 0 ? -0.1 : 0.1
          const next = Math.min(2.5, Math.max(0.5, Math.round((current + step) * 100) / 100))
          setFixedZoom(next)
          return
        }
        const step = event.deltaY > 0 ? -1 : 1
        const next = clampFontSize(typographyRef.current.fontSize + step)
        if (next !== typographyRef.current.fontSize) {
          onTypography({ ...typographyRef.current, fontSize: next })
        }
        return
      }
      if (flowRef.current !== 'paginated') return
      if (Math.abs(event.deltaY) < 2) return
      event.preventDefault()
      const now = Date.now()
      if (now - lastFlip < 90) return
      lastFlip = now
      const forward = event.deltaY > 0 ? 1 : -1
      void flip(verticalRef.current ? (forward === 1 ? -1 : 1) : forward)
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    wheelHandlerRef.current = onWheel
    return () => {
      window.removeEventListener('wheel', onWheel)
      wheelHandlerRef.current = () => {}
    }
  }, [flip, onTypography])

  const setFontSize = (next: number) => {
    onTypography({ ...typography, fontSize: clampFontSize(next) })
  }

  /**
   * 非 EPUB：先转出一个工作副本 EPUB（library/<id>/working.epub），已存在则复用，
   * 避免每次编辑都重转、也避免覆盖上次的编辑成果。
   */
  const prepareWorkingCopy = async (): Promise<string | null> => {
    if (source.kind !== 'library') return null
    const root = (libraryDir ?? '').replace(/[\\/]$/, '')
    if (!root) return null
    const target = `${root}/${source.meta.id}/working.epub`
    if (await invoke<boolean>('file_exists', { path: target })) return target
    const buffer = await invoke<ArrayBuffer>('read_book_bytes', { id: source.meta.id })
    const decoded = decodeText(buffer)
    const plain = toPlainText(decoded.text, sourceFormat)
    const analysis = analyzeTxt(plain)
    if (!analysis.chapters.some((chapter) => chapter.paragraphs.length > 0)) {
      throw new Error('这本书没有可编辑的文字')
    }
    const bytes = buildEpub(analysis.chapters, {
      title: source.meta.title || displayName(source),
      author: '佚名',
      language: 'zh-CN',
      indent: prefs.convertIndent,
      centerHeading: prefs.convertCenterHeading,
    })
    await invoke('save_epub', { path: target, base64: bytesToBase64(bytes) })
    return target
  }

  /**
   * 阅读 → 编辑：EPUB 直接进编辑器；文本格式先生成工作副本 EPUB。
   * EPUB 会把当前章节与顶层段落块作为「种子」，让编辑器直接定位。
   */
  const seedFromReading = async () => {
    if (editOpen) return
    if (sourceFormat !== 'epub') {
      setPreparingEdit(true)
      try {
        const target = await prepareWorkingCopy()
        if (!target) { onNotify('无法创建工作副本：缺少书库目录'); return }
        setWorkingEpub(target)
        setEditSeed(null)
        setEditOpen(true)
        onNotify('已生成工作副本 EPUB，编辑保存只写在这个副本上')
      } catch (err) {
        onNotify(`生成工作副本失败：${String(err)}`)
      } finally {
        setPreparingEdit(false)
      }
      return
    }
    const view = viewRef.current
    let index: number | undefined
    try {
      const contents = view?.renderer?.getContents?.() as Array<{ index?: number }> | undefined
      if (contents?.length) index = contents[0]?.index
    } catch {
      // 渲染器还没就绪
    }
    // sections[i].id 才是相对 OPF 的 href（如 OEBPS/content.opf + text/ch1.xhtml）
    const href: string | undefined = typeof index === 'number'
      ? (view?.book?.sections?.[index]?.id as string | undefined)
      : undefined
    let block: number | undefined
    const range: Range | undefined = lastLocRef.current?.range
    if (range) {
      try {
        const doc = range.startContainer.ownerDocument as Document
        let node: Node | null = range.startContainer
        while (node && node.parentNode && node.parentNode !== doc.body) node = node.parentNode
        if (node && doc.body && node.parentNode === doc.body) {
          const idx = Array.prototype.indexOf.call(doc.body.children, node as Element)
          if (idx >= 0) block = idx
        }
      } catch {
        // 位置信息拿不到就只按章节对齐
      }
    }
    setEditSeed({ href, block })
    setEditOpen(true)
  }

  // ─── 自动打开编辑面板（从 Shelf 右键跳转时） ───
  useEffect(() => {
    if (autoEditBookId && source.kind === 'library' && source.meta.id === autoEditBookId) {
      if (sourceFormat === 'epub') setEditOpen(true)
      else void seedFromReading()
      onAutoEditConsumed?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditBookId, source, onAutoEditConsumed])

  return (
    <div className="app">
      <header className="bar">
        <button className="btn icon-only" data-tip="返回书架（Esc）" aria-label="返回书架" onClick={onBack}>
          <Icon name="arrow_back" />
        </button>
        <span className="sep" />
        {editableFormat && (
          <div className="mode-switch" role="group" aria-label="阅读与编辑模式">
            <button
              className={editOpen ? '' : 'on'}
              data-tip="阅读模式：正常翻页阅读"
              onClick={() => {
                if (editDirtyRef.current && !confirm('编辑区有未保存改动，确定切回阅读模式？')) return
                setEditOpen(false)
              }}
            >
              阅读
            </button>
            <button
              className={editOpen ? 'on' : ''}
              disabled={preparingEdit}
              data-tip={sourceFormat === 'epub'
                ? '编辑模式：段落 / 源码 / 元数据 / 目录'
                : `编辑模式：先把 ${formatLabel(sourceFormat)} 转成工作副本 EPUB`}
              onClick={() => void seedFromReading()}
            >
              {preparingEdit ? '转换中…' : '编辑'}
            </button>
          </div>
        )}
        {!editOpen && (
        <>
        <button
          className="btn primary icon-only"
          data-tip="打开一本 EPUB（不加入书架）"
          aria-label="打开 EPUB"
          onClick={onOpenEpub}
        >
          <Icon name="folder_open" />
        </button>
        <button
          className="btn icon-only"
          data-tip="上一页（←）"
          aria-label="上一页"
          onClick={() => void flip(vertical ? 1 : -1)}
        >
          <Icon name="chevron_left" />
        </button>
        <button
          className="btn icon-only"
          data-tip="下一页（→ 或 空格 / 滚轮）"
          aria-label="下一页"
          onClick={() => void flip(vertical ? -1 : 1)}
        >
          <Icon name="chevron_right" />
        </button>
        <button
          className="btn icon-only"
          disabled={toc.length === 0 || chapterIndex <= 0}
          data-tip={
            toc.length === 0 ? '这本书没有目录' : chapterIndex <= 0 ? '已经是第一章' : '上一章（跳到上一章开头）'
          }
          aria-label="上一章"
          onClick={() => void jumpChapter(-1)}
        >
          <Icon name={vertical ? 'skip_next' : 'skip_previous'} />
        </button>
        <button
          className="btn icon-only"
          disabled={toc.length === 0 || chapterIndex < 0 || chapterIndex >= toc.length - 1}
          data-tip={
            toc.length === 0
              ? '这本书没有目录'
              : chapterIndex >= toc.length - 1
                ? '已经是最后一章'
                : '下一章（跳到下一章开头）'
          }
          aria-label="下一章"
          onClick={() => void jumpChapter(1)}
        >
          <Icon name={vertical ? 'skip_previous' : 'skip_next'} />
        </button>
        <span className="sep" />
        <button
          className={`btn icon-only ${tocOpen ? 'on' : ''}`}
          data-tip="展开目录（点击章节跳转）"
          aria-label="目录"
          onClick={() => setTocOpen((v) => !v)}
        >
          <Icon name="toc" />
        </button>
        <button
          className={`btn icon-only ${doublePage ? 'on' : ''}`}
          data-tip="在单页与双页之间切换"
          aria-label="单双页切换"
          onClick={() => setDoublePage((v) => !v)}
        >
          <Icon name="chrome_reader_mode" />
        </button>
        <button
          className={`btn icon-only ${vertical ? 'on' : ''}`}
          data-tip="在横排与竖排之间切换（竖排从右向左）"
          aria-label="横竖排切换"
          onClick={() => setVertical((v) => !v)}
        >
          <Icon name={vertical ? 'swap_vert' : 'swap_horiz'} />
        </button>
        <button
          className={`btn icon-only ${flow === 'scrolled' ? 'on' : ''}`}
          data-tip="在分页与连续滚动之间切换"
          aria-label="分页与滚动切换"
          onClick={() => setFlow((f) => (f === 'paginated' ? 'scrolled' : 'paginated'))}
        >
          <Icon name={flow === 'paginated' ? 'auto_stories' : 'view_stream'} />
        </button>
        <button
          className={`btn icon-only ${settingsOpen ? 'on' : ''}`}
          data-tip={
            fixedLayout
              ? '整页缩放：适应整页 / 页宽或按倍数放大'
              : '调整字号、行距与首行缩进（Ctrl+滚轮可直接缩放字号）'
          }
          aria-label={fixedLayout ? '整页缩放' : '排版'}
          onClick={() => setSettingsOpen((v) => !v)}
        >
          <Icon name={fixedLayout ? 'zoom_out_map' : 'text_fields'} />
        </button>
        <button
          className={`btn icon-only ${galleryOpen ? 'on' : ''}`}
          data-tip={galleryTip}
          aria-label="彩页与插图"
          onClick={() => {
            if (galleryOpen) setGalleryOpen(false)
            else void openGallery()
          }}
        >
          <Icon name="photo_library" />
        </button>
        <button
          className={`btn icon-only ${forgeOpen ? 'on' : ''}`}
          disabled={!forgeData || source.kind !== 'library'}
          data-tip={
            forgeData && source.kind === 'library'
              ? '逐段改写、翻译、注释，写回 EPUB / TXT 源文件（可回滚）'
              : '锻造只支持从书架打开的 EPUB / TXT 图书'
          }
          aria-label="锻造"
          onClick={() => setForgeOpen((v) => !v)}
        >
          <Icon name="build" />
        </button>
        </>
        )}
        <button
          className="btn icon-only"
          data-tip={`界面主题：${themeLabel(prefs.theme)}（点击切换日间 / 护眼 / 夜间）`}
          aria-label="切换界面主题"
          onClick={() => onPrefs({ theme: nextTheme(prefs.theme) })}
        >
          <Icon name={prefs.theme === 'night' ? 'brightness_3' : prefs.theme === 'eye' ? 'visibility' : 'wb_sunny'} />
        </button>
        <span className="grow" />
        <span className="bookname" title={title}>{title || '未打开书籍'}</span>
      </header>

      <main className="stage">
        <div className="viewhost" ref={hostRef} />

        {onCover && fractionKnown && (
          <div className="start-reading-wrap">
            <button className="btn primary start-reading" onClick={() => void startReading()}>
              开始阅读
            </button>
          </div>
        )}

        <AnnotationTools view={viewEl} bookKey={keyRef.current} prefs={prefs} onNotify={onNotify} />

        {galleryOpen && (
          <div className="gallery-panel">
            <header className="gallery-head">
              <Icon name="photo_library" size={18} />
              <span className="gallery-title">彩页与插图</span>
              <span className="gallery-count">
                {galleryLoading ? '正在读取…' : `${galleryItems.length} 张`}
              </span>
              <span className="grow" />
              <button
                className="btn icon-only tip-top"
                data-tip="关闭彩页"
                aria-label="关闭彩页"
                onClick={() => setGalleryOpen(false)}
              >
                <Icon name="close" />
              </button>
            </header>
            {galleryLoading ? (
              <div className="gallery-empty">正在从书里抽出整页大图…</div>
            ) : galleryItems.length === 0 ? (
              <div className="gallery-empty">
                {imageFormat
                  ? '这本书没有彩页，只有文字和普通插图。'
                  : '这个格式没有内嵌插图，彩页浏览不适用。'}
              </div>
            ) : (
              <div className="gallery-grid">
                {galleryItems.map((item, index) => (
                  <button
                    key={item.href}
                    className="gallery-thumb"
                    aria-label={`查看第 ${index + 1} 张彩页`}
                    onClick={() =>
                      setViewer({
                        items: galleryItems.map((page) => ({
                          url: page.url,
                          width: page.width,
                          height: page.height,
                          label: page.href,
                        })),
                        index,
                      })
                    }
                  >
                    <img src={item.url} alt="" loading="lazy" />
                    <span className="gallery-size">{item.width}×{item.height}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {viewer && (
          <ImageViewer
            items={viewer.items}
            index={viewer.index}
            onIndex={(next) =>
              setViewer((value) => (value ? { ...value, index: next } : value))
            }
            onClose={() => setViewer(null)}
          />
        )}

        {forgeOpen && forgeData && source.kind === 'library' && (() => {
          const dir = (libraryDir ?? '').replace(/[\\/]$/, '')
          const epubOutputPath = sourceFormat === 'epub'
            ? (source.meta.path || (dir ? `${dir}/${source.meta.id}/source.epub` : ''))
            : ''
          return (
          <ForgePanel
            bookId={source.meta.id}
            bookTitle={title}
            rawText={forgeData.text}
            analysis={forgeData.analysis}
            prefs={prefs}
            currentChapter={chapter}
            onClose={() => setForgeOpen(false)}
            onNotify={onNotify}
            onCommitted={() => setReloadToken((n) => n + 1)}
            // S6：EPUB 源即时写回
            epubEditDir={forgeEpubEditDir ?? undefined}
            epubFlatBlocks={forgeEpubFlat ?? undefined}
            epubOutputPath={epubOutputPath || undefined}
          />
          )
        })()}

        {/* EPUB 编辑器侧滑面板（E1；E6 支持文本格式经工作副本进入） */}
        {editOpen && editableFormat && (() => {
          const dir = (libraryDir ?? '').replace(/[\\/]$/, '')
          // EPUB 用原文件；非 EPUB 用转出的工作副本（working.epub）
          const epubPath = sourceFormat === 'epub'
            ? (source.meta.path || (dir ? `${dir}/${source.meta.id}/source.epub` : ''))
            : (workingEpub ?? '')
          if (!epubPath) return null
          return (
            <EpubEditPanel
              epubPath={epubPath}
              bookId={source.meta.id}
              exportDir={exportDir ?? undefined}
              initialHref={editSeed?.href}
              initialBlock={editSeed?.block}
              initialBlockFont={prefs.editorBlockFont}
              initialSrcFont={prefs.editorSrcFont}
              autoRebuild={prefs.editorAutoRebuild}
              createRevision={prefs.editorCreateRevision}
              prefs={prefs}
              onClose={() => setEditOpen(false)}
              onNotify={onNotify}
              onDirtyChange={(v) => { editDirtyRef.current = v }}
              onCommitted={() => {
                // 封面可能被替换过：丢掉内存里的旧封面 blob，回书架时重新从 EPUB 抽取
                forgetCover(source.meta.id)
                setReloadToken((n) => n + 1)
              }}
            />
          )
        })()}

        {loading && <div className="reader-loading">正在整理这本书…</div>}

        {error && !loading && (
          <div className="reader-error">
            <p>{error}</p>
            <button className="btn icon-only" data-tip="返回书架" aria-label="返回书架" onClick={onBack}>
              <Icon name="arrow_back" />
            </button>
          </div>
        )}

        {settingsOpen && fixedLayout && (
          <div className="typo-panel">
            <div className="typo-row">
              <span className="typo-label">整页缩放</span>
              <span className="typo-value">
                {typeof fixedZoom === 'number' ? `${Math.round(fixedZoom * 100)}%` : '适应'}
              </span>
            </div>
            <div className="zoom-modes">
              {([
                { key: 'fit-page', label: '适应整页' },
                { key: 'fit-width', label: '适应页宽' },
                { key: 1.25, label: '125%' },
                { key: 1.5, label: '150%' },
                { key: 2, label: '200%' },
              ] as const).map((mode) => (
                <button
                  key={String(mode.key)}
                  className={`zoom-mode ${fixedZoom === mode.key ? 'on' : ''}`}
                  onClick={() => setFixedZoom(mode.key)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
            <div className="typo-hint">
              固定版式书（PDF / 漫画 / 固定版式 EPUB）按整页缩放；字号与行距对它无效，Ctrl+滚轮可直接缩放。
            </div>
          </div>
        )}

        {settingsOpen && !fixedLayout && (
          <div className="typo-panel">
            <div className="typo-row">
              <span className="typo-label">字号</span>
              <button
                className="btn small icon-only"
                data-tip="缩小字号（Ctrl+滚轮向下）"
                aria-label="缩小字号"
                onClick={() => setFontSize(typography.fontSize - 1)}
              >
                <Icon name="remove" size={16} />
              </button>
              <span className="typo-value">{typography.fontSize} px</span>
              <button
                className="btn small icon-only"
                data-tip="放大字号（Ctrl+滚轮向上）"
                aria-label="放大字号"
                onClick={() => setFontSize(typography.fontSize + 1)}
              >
                <Icon name="add" size={16} />
              </button>
            </div>
            <label className="typo-row">
              <span className="typo-label">行距</span>
              <select
                value={typography.lineHeight}
                onChange={(e) => onTypography({ ...typography, lineHeight: Number(e.target.value) })}
                title="选择正文行距"
              >
                <option value={1.5}>紧凑</option>
                <option value={1.7}>较紧</option>
                <option value={1.9}>标准</option>
                <option value={2.1}>宽松</option>
                <option value={2.3}>很宽</option>
              </select>
            </label>
            <label className="typo-row">
              <span className="typo-label">首行缩进</span>
              <input
                type="checkbox"
                checked={typography.indent}
                onChange={(e) => onTypography({ ...typography, indent: e.target.checked })}
                title="控制每段开头是否缩进两个字"
              />
            </label>
            <button
              className="btn small icon-only tip-top"
              data-tip="把字号、行距、缩进恢复为默认值"
              aria-label="恢复默认排版"
              onClick={() => onTypography({ ...DEFAULT_TYPOGRAPHY })}
            >
              <Icon name="restore" size={16} />
            </button>
          </div>
        )}

        {tocOpen && (
          <aside className="toc-panel">
            <div className="toc-head">
              <span>目录</span>
              <span className="toc-count">{toc.length ? `${toc.length} 节` : ''}</span>
              <span className="grow" />
              <button
                className="btn small icon-only"
                data-tip="收起目录"
                aria-label="收起目录"
                onClick={() => setTocOpen(false)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            {toc.length === 0 ? (
              <div className="toc-empty">这本书没有目录信息</div>
            ) : (
              <ol className="toc-list">
                {toc.map((entry, index) => (
                  <li
                    key={`${entry.href}-${index}`}
                    className={entry.group ? 'toc-group' : undefined}
                    style={{ paddingLeft: `${12 + entry.depth * 14}px` }}
                  >
                    {entry.group ? (
                      <span>{entry.label}</span>
                    ) : (
                      <button onClick={() => void jumpTo(entry.href)} title={`跳转到：${entry.label}`}>
                        {entry.label}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </aside>
        )}

        {/* 气泡常驻但默认隐藏：临时视图需要有真实尺寸才能排版，隐藏时保留占位 */}
        <aside
          className={`footnote-pop ${footnote ? 'open' : ''}`}
          aria-label="脚注"
          aria-hidden={!footnote}
        >
          <div className="footnote-head">
            <span className="footnote-kind">{footnoteLabel(footnote?.type ?? null)}</span>
            <span className="grow" />
            <button
              className="btn small icon-only tip-top"
              data-tip="关闭脚注（Esc）"
              aria-label="关闭脚注"
              onClick={closeFootnote}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
          <div className="footnote-body" ref={footnoteHostRef} />
        </aside>
      </main>

      {!editOpen && (
        <div className="read-bottom">
          {fractionKnown && (
            <div
              className={`read-progress ${dragPercent != null ? 'dragging' : ''}`}
              role="slider"
              aria-label="阅读进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={dragPercent ?? percent}
              onPointerDown={onProgressDown}
              onPointerMove={onProgressMove}
              onPointerUp={onProgressUp}
              onPointerCancel={onProgressCancel}
            >
              <div className="read-progress-track" ref={progressTrackRef}>
                <div className="read-progress-fill" style={{ width: `${dragPercent ?? percent}%` }} />
                <div className="read-progress-knob" style={{ left: `${dragPercent ?? percent}%` }} />
              </div>
              {dragPercent != null && (
                <span
                  className="read-progress-bubble"
                  style={{ left: `calc(14px + (100% - 28px) * ${dragPercent / 100})` }}
                >
                  {dragPercent}%
                </span>
              )}
            </div>
          )}

          <footer className="status">
            <span className="chapter">{chapter || '—'}</span>
            <span className="grow" />
            <span className="meta">{percent}%</span>
            <span className="meta">{meta}</span>
            <span className="meta">{vertical ? '竖排 · 右→左' : '横排 · 左→右'}</span>
            <span className="meta">{flow === 'paginated' ? (doublePage ? '双页' : '单页') : '连续滚动'}</span>
          </footer>
        </div>
      )}
    </div>
  )
}
