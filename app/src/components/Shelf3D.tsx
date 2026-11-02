import { useEffect, useMemo, useRef, useState } from 'react'
import Icon from './Icon'
import { coverUrl } from '../lib/cover'
import { progressPercent } from '../lib/progress'
import type { BookMeta } from '../types'

function hashOf(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 100000
  return hash
}

function hueOf(text: string): number {
  return hashOf(text) % 360
}

/** 书脊厚度：按书 deterministic 变化，EPUB 普遍更厚，像真的插了一排薄厚不一的书。 */
function thicknessOf(book: BookMeta, bookH: number): number {
  const ratio = 0.075 + (hashOf(book.id) % 4) * 0.018
  return Math.round(bookH * (book.format === 'epub' ? ratio + 0.02 : ratio))
}

/** 封面幅面：真实书接近 1:1.4，封面在轴测里向右后方斜退 。 */
function coverOf(bookH: number): number {
  return Math.round(bookH * 0.72)
}

/** 每本书的稿高略有差异（93%–99.8%），一排书高低错落才像真书架。 */
function heightOf(book: BookMeta, bookH: number): number {
  return Math.round(bookH * (0.93 + (hashOf(book.id) % 5) * 0.017))
}

/** 纯 ASCII 书名按英文书脊排（整行旋转 90°，可换行）；含中日韩字符的按中文竖排。 */
function isLatin(title: string): boolean {
  return /^[\x20-\x7E]+$/.test(title.trim())
}

/**
 * 书脊放不下整条书名：按书脊高度/厚度算出字号与可容纳字数，超出用省略号。
 * 英文按"每列能排几个字符 × 能排几列"算容量，中文按逐字往下排算。
 */
function spineLabel(title: string, latin: boolean, height: number, thick: number) {
  if (latin) {
    // 英文书脊整行旋转 90°，一列排得下就一列，排不下往左折成多列（最多 3 列）
    const columns = Math.max(1, Math.min(3, Math.floor((thick - 2) / 13)))
    const size = title.length > 26 * columns ? 11 : thick >= 26 ? 13 : 12
    const perColumn = Math.max(8, Math.floor((height - 24) / (size * 0.62)))
    const capacity = Math.max(10, perColumn * columns)
    return {
      size,
      text: title.length > capacity ? `${title.slice(0, capacity - 1).trimEnd()}…` : title,
    }
  }
  const sizeCap = Math.min(22, Math.max(11, Math.round(thick * 0.34)))
  const byLength = (height - 34) / Math.max(4, title.length)
  const size = Math.min(sizeCap, Math.max(9, byLength))
  const capacity = Math.max(3, Math.floor((height - 26) / (size * 1.06)))
  return {
    size,
    text: title.length > capacity ? `${title.slice(0, capacity - 1)}…` : title,
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function CoverArt({ book, big = false }: { book: BookMeta; big?: boolean }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setUrl(null)
    // 不能因为 book.cover 为空就放弃：后端 read_cover 会实时从 epub 解封面
    void coverUrl(book).then((value) => {
      if (alive) setUrl(value)
    })
    return () => {
      alive = false
    }
  }, [book.id, book.cover])

  const hue = hueOf(book.title)
  return (
    <div
      className={`cover-art ${url ? 'has-art' : ''} ${big ? 'big' : ''}`}
      style={
        url
          ? { backgroundImage: `url(${url})` }
          : { background: `linear-gradient(150deg, hsl(${hue} 36% 48%), hsl(${(hue + 40) % 360} 32% 30%))` }
      }
    >
      {!url && (
        <>
          <span className="art-letter">{book.title.slice(0, 1)}</span>
          <span className="art-title">{book.title}</span>
        </>
      )}
      <span className="art-format">{book.format.toUpperCase()}</span>
    </div>
  )
}

type Props = {
  books: BookMeta[]
  selected: string | null
  onSelect: (id: string) => void
  onOpen: (book: BookMeta) => void
  onContext: (event: React.MouseEvent, book: BookMeta) => void
}

type Pull = { book: BookMeta; stage: 'lift' | 'pick' | 'front' }

export default function Shelf3D({ books, selected, onSelect, onOpen, onContext }: Props) {
  const [pull, setPull] = useState<Pull | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const [stage, setStage] = useState({ w: 0, h: 0 })
  /** 默认只露书脊；打开这档后整排让出封面宽度，斜着看封面 */
  const [sideView, setSideView] = useState(false)
  /** 鼠标压在哪一本：左右相邻的书会顺着抛物线往下沉，像被指尖拨了一下 */
  const [hovered, setHovered] = useState<number | null>(null)

  const items = useMemo(() => books, [books])

  // 书架跟着窗口/容器尺寸走：书的高度按可用空间算，不再固定小窗口
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const bookH = Math.round(Math.max(160, (stage.h || 420) * 0.8))
  const gap = Math.max(3, Math.round(bookH * 0.016))
  /** 相邻书的下沉量：离鼠标越远沉得越多，最多沉 3 格，像被指尖拨了一下 */
  const waveOf = (index: number) => {
    if (hovered == null || sideView) return 0
    const distance = Math.abs(index - hovered)
    if (distance === 0) return 0
    return Math.round(Math.min(3, distance) ** 2 * 0.8)
  }

  const syncEdges = () => {
    const el = viewportRef.current
    if (!el) return
    setEdges({
      left: el.scrollLeft > 8,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 8,
    })
  }

  useEffect(() => {
    syncEdges()
  }, [books.length, stage.w])

  const scrollBy = (direction: 1 | -1) => {
    const el = viewportRef.current
    if (!el) return
    el.scrollBy({ left: direction * Math.max(320, el.clientWidth * 0.7), behavior: 'smooth' })
  }

  // 按住书架左右拖动：书再多也能像真书架一样平移
  const dragRef = useRef<{ startX: number; startLeft: number; moved: boolean } | null>(null)
  const draggedAt = useRef(0)

  const endDrag = (el: HTMLElement, pointerId?: number) => {
    const drag = dragRef.current
    if (drag?.moved) draggedAt.current = Date.now()
    dragRef.current = null
    el.classList.remove('dragging')
    if (pointerId != null && el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId)
  }

  // 抽书分三段：抬起来 → 抽出来 → 拿到面前看正面封面与书名
  useEffect(() => {
    if (!pull) return
    if (pull.stage === 'lift') {
      const timer = window.setTimeout(
        () => setPull((current) => (current ? { ...current, stage: 'pick' } : null)),
        200,
      )
      return () => window.clearTimeout(timer)
    }
    if (pull.stage === 'pick') {
      const timer = window.setTimeout(
        () => setPull((current) => (current ? { ...current, stage: 'front' } : null)),
        300,
      )
      return () => window.clearTimeout(timer)
    }
  }, [pull])

  useEffect(() => {
    if (!pull) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPull(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pull])

  const close = () => setPull(null)

  const toggleSide = () => setSideView((prev) => !prev)

  return (
    <div className="shelf3d">
      <div className="rack">
        <div className="rack-head">
          <span className="rack-label">全部图书</span>
          <span className="rack-count">
            {books.length} 本 · 点书取出可看封面 · 拖动整排翻书
          </span>
          <span className="grow" />
          <button className="btn small" data-tip="整排转过去看封面" onClick={toggleSide}>
            <Icon name={sideView ? 'view_carousel' : 'auto_stories'} size={16} />
            {sideView ? '看书脊' : '看封面'}
          </button>
          <button
            className="btn small icon-only"
            data-tip="向左滑一整排"
            aria-label="向左滑动书架"
            disabled={!edges.left}
            onClick={() => scrollBy(-1)}
          >
            <Icon name="chevron_left" size={18} />
          </button>
          <button
            className="btn small icon-only"
            data-tip="向右滑一整排"
            aria-label="向右滑动书架"
            disabled={!edges.right}
            onClick={() => scrollBy(1)}
          >
            <Icon name="chevron_right" size={18} />
          </button>
        </div>

        <div
          className="rack-viewport"
          ref={viewportRef}
          onScroll={syncEdges}
          onPointerLeave={(event) => {
            if (event.buttons === 0) endDrag(event.currentTarget, event.pointerId)
          }}
          onClickCapture={(event) => {
            // 拖动结束时别把书当成被点开
            if (Date.now() - draggedAt.current < 260) {
              event.stopPropagation()
              event.preventDefault()
            }
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            const el = event.currentTarget
            // 不在这里抓取指针：一旦 setPointerCapture，click 会被架子接管，书就点不开
            dragRef.current = { startX: event.clientX, startLeft: el.scrollLeft, moved: false }
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            if (!drag || event.buttons !== 1) return
            const dx = event.clientX - drag.startX
            if (!drag.moved && Math.abs(dx) > 8) {
              drag.moved = true
              event.currentTarget.classList.add('dragging')
              try {
                event.currentTarget.setPointerCapture(event.pointerId)
              } catch {
                // 合成事件或指针已释放时忽略
              }
            }
            if (drag.moved) event.currentTarget.scrollLeft = drag.startLeft - dx
          }}
          onPointerUp={(event) => endDrag(event.currentTarget, event.pointerId)}
          onPointerCancel={(event) => endDrag(event.currentTarget, event.pointerId)}
          onWheel={(event) => {
            const el = event.currentTarget
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && el.scrollWidth > el.clientWidth) {
              el.scrollLeft += event.deltaY
            }
          }}
        >
          <div
            className={`rack-shelf ${sideView ? 'cover-view' : ''}`}
            style={
              {
                '--book-h': `${bookH}px`,
                '--gap': `${gap}px`,
              } as React.CSSProperties
            }
            onPointerLeave={() => setHovered(null)}
          >
            {items.map((book, index) => {
              const percent = progressPercent(book.id)
              const height = heightOf(book, bookH)
              const thick = thicknessOf(book, height)
              const cover = coverOf(bookH)
              const latin = isLatin(book.title)
              const hue = hueOf(book.title)
              const label = spineLabel(book.title, latin, height, thick)
              return (
                <div
                  key={book.id}
                  className="book-slot"
                  style={
                    {
                      '--thick': `${thick}px`,
                      '--cover': `${cover}px`,
                      '--h': `${height}px`,
                      '--hue': hue,
                      '--wave': `${waveOf(index)}px`,
                    } as React.CSSProperties
                  }
                  onPointerEnter={() => setHovered(index)}
                >
                  <button
                    className={`book3d ${selected === book.id ? 'selected' : ''} ${
                      pull?.book.id === book.id ? `pulling ${pull.stage}` : ''
                    }`}
                    title={`${book.title} · ${book.format.toUpperCase()}${percent > 0 ? ` · 已读 ${percent}%` : ''}`}
                    aria-label={`取出《${book.title}》`}
                    onClick={() => {
                      onSelect(book.id)
                      setPull({ book, stage: 'lift' })
                    }}
                    onDoubleClick={() => onOpen(book)}
                    onContextMenu={(event) => onContext(event, book)}
                  >
                    <span className="bk-cover" aria-hidden="true">
                      <CoverArt book={book} />
                    </span>
                    <span className="bk-cap" aria-hidden="true" />
                    <span className={`bk-spine ${latin ? 'spine-latin' : 'spine-cjk'}`}>
                      <span className="spine-label" style={{ fontSize: `${label.size}px` }}>
                        {label.text}
                      </span>
                      {percent > 0 && <span className="spine-progress" style={{ height: `${percent}%` }} />}
                    </span>
                  </button>
                </div>
              )
            })}
            <div className="rack-tail" aria-hidden="true">
              <Icon name="keyboard_double_arrow_right" size={17} />
              <span>拖动翻书</span>
            </div>
          </div>
        </div>
        <div className="rack-board" aria-hidden="true">
          <span className="rack-index">SCROLLFORGE</span>
        </div>
      </div>

      {pull && pull.stage === 'front' && (
        <div className="pullout-mask" onClick={close}>
          <div className="pullout" onClick={(event) => event.stopPropagation()}>
            <div className="pullout-cover">
              <CoverArt book={pull.book} big />
            </div>
            <div className="pullout-info">
              <span className="pullout-kicker">
                {pull.book.format.toUpperCase()}
                <span className="dot">·</span>
                {formatSize(pull.book.byteLen)}
                <span className="dot">·</span>
                {progressPercent(pull.book.id) > 0 ? `已读 ${progressPercent(pull.book.id)}%` : '未开始'}
              </span>
              <h3>{pull.book.title}</h3>
              <p className="pullout-sub">
                {pull.book.storage === 'history' ? '阅读历史 · 原文件读取' : '本地书库 · 副本'}
                {pull.book.group ? ` · ${pull.book.group}` : ''}
              </p>
              <div className="pullout-actions">
                <button
                  className="btn primary"
                  onClick={() => {
                    const book = pull.book
                    setPull(null)
                    onOpen(book)
                  }}
                >
                  <Icon name="menu_book" size={16} /> 打开这本书
                </button>
                <button className="btn" onClick={close}>
                  <Icon name="keyboard_return" size={16} /> 放回书架
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
