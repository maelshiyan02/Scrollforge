import { useEffect, useMemo, useState } from 'react'
import type { AppSettings, BookMeta } from '../types'
import { nextTheme, themeLabel, type Prefs } from '../lib/prefs'
import { lastReadAt, progressPercent } from '../lib/progress'
import { coverUrl } from '../lib/cover'
import Icon from './Icon'
import Shelf3D from './Shelf3D'

type Props = {
  books: BookMeta[]
  busy: boolean
  settings: AppSettings | null
  prefs: Prefs
  onPrefs: (patch: Partial<Prefs>) => void
  onOpen: (book: BookMeta) => void
  onImport: () => void
  onNewBook: () => void
  onOpenFile: () => void
  onRefresh: () => void
  onSettings: () => void
  onConvert: (book?: BookMeta) => void
  onCheck: (book: BookMeta) => void
  onEditEpub: (book: BookMeta) => void
  onExportText: (book: BookMeta) => void
  onDelete: (book: BookMeta) => Promise<void>
}

type View = 'grid' | 'list' | 'shelf3d'
type Sort = 'recent' | 'imported' | 'title'
type Tab = 'history' | 'library'
type Category = 'all' | 'reading' | 'unread' | 'done' | 'epub' | 'txt' | 'recent' | `group:${string}`

const SHELF_KEY = 'scrollforge:shelf'
const EMPTY_CATEGORY: Category = 'all'

function loadPref<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  try {
    const raw = localStorage.getItem(`${SHELF_KEY}:${name}`)
    return allowed.includes(raw as T) ? (raw as T) : fallback
  } catch {
    return fallback
  }
}

function remember(name: string, value: string): void {
  try {
    localStorage.setItem(`${SHELF_KEY}:${name}`, value)
  } catch {
    // 忽略
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(timestamp: number): string {
  if (!timestamp) return '—'
  const date = new Date(timestamp)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function shortDate(timestamp: number): string {
  if (!timestamp) return '从未打开'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚读过'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  const days = Math.floor(diff / 86400_000)
  if (days < 30) return `${days} 天前`
  return formatDate(timestamp).slice(0, 10)
}

function coverStyle(title: string): { background: string } {
  let hash = 0
  for (let i = 0; i < title.length; i += 1) hash = (hash * 31 + title.charCodeAt(i)) % 360
  const hue = hash
  return {
    background: `linear-gradient(150deg, hsl(${hue} 34% 46%), hsl(${(hue + 44) % 360} 30% 30%))`,
  }
}

function lastOpened(book: BookMeta): number {
  return Math.max(book.lastOpenedAt ?? 0, lastReadAt(book.id))
}

/** 书封：有抽出的封面就用图，没有就按书名生成色块 + 首字 */
function BookCover({ book }: { book: BookMeta }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setUrl(null)
    // 永远尝试加载封面：后端会判断磁盘有没有、没有就从 epub 实时提取
    // 所以不能因为 book.cover 字段为空就放弃！
    void coverUrl(book).then((value) => {
      if (alive) setUrl(value)
    })
    return () => {
      alive = false
    }
  }, [book.id, book.cover])

  return (
    <div
      className={`cover ${url ? 'has-art' : ''}`}
      style={url ? { backgroundImage: `url(${url})` } : coverStyle(book.title)}
    >
      {!url && <span className="cover-letter">{book.title.slice(0, 1)}</span>}
      <span className="cover-format">{book.format.toUpperCase()}</span>
    </div>
  )
}

export default function Shelf({
  books,
  busy,
  settings,
  prefs,
  onPrefs,
  onOpen,
  onImport,
  onNewBook,
  onOpenFile,
  onRefresh,
  onSettings,
  onConvert,
  onCheck,
  onEditEpub,
  onExportText,
  onDelete,
}: Props) {
  const [view, setView] = useState<View>(prefs.shelfView)
  const [sort, setSort] = useState<Sort>(prefs.shelfSort)
  const [tab, setTab] = useState<Tab>(() => loadPref<Tab>('tab', 'library', ['history', 'library']))
  const [category, setCategory] = useState<Category>(() => {
    const raw = localStorage.getItem(`${SHELF_KEY}:category`)
    return (raw as Category) || EMPTY_CATEGORY
  })
  const [selected, setSelected] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; book: BookMeta } | null>(null)
  const [info, setInfo] = useState<BookMeta | null>(null)
  const [pendingDelete, setPendingDelete] = useState<BookMeta | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => remember('view', view), [view])
  useEffect(() => remember('sort', sort), [sort])
  useEffect(() => remember('tab', tab), [tab])
  // 设置页改了默认视图/排序后，已打开的书架立即跟随
  useEffect(() => setView(prefs.shelfView), [prefs.shelfView])
  useEffect(() => setSort(prefs.shelfSort), [prefs.shelfSort])

  const changeView = (value: View) => {
    setView(value)
    onPrefs({ shelfView: value })
  }
  const changeSort = (value: Sort) => {
    setSort(value)
    onPrefs({ shelfSort: value })
  }
  useEffect(() => {
    try {
      localStorage.setItem(`${SHELF_KEY}:category`, category)
    } catch {
      // 忽略
    }
  }, [category])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const historyBooks = useMemo(
    () => books.filter((book) => lastOpened(book) > 0),
    [books],
  )
  const libraryBooks = useMemo(
    () => books.filter((book) => (book.storage ?? 'library') === 'library'),
    [books],
  )

  const sourceBooks = tab === 'history' ? historyBooks : libraryBooks

  const categories = useMemo<{ key: Category; label: string; count: number }[]>(() => {
    const rows: { key: Category; label: string; count: number }[] = [
      { key: 'all', label: '全部', count: sourceBooks.length },
      {
        key: 'reading',
        label: '在读',
        count: sourceBooks.filter((b) => {
          const p = progressPercent(b.id)
          return p > 0 && p < 100
        }).length,
      },
      {
        key: 'unread',
        label: '未读',
        count: sourceBooks.filter((b) => progressPercent(b.id) === 0).length,
      },
      {
        key: 'done',
        label: '已读',
        count: sourceBooks.filter((b) => progressPercent(b.id) >= 100).length,
      },
      {
        key: 'epub',
        label: 'EPUB',
        count: sourceBooks.filter((b) => b.format === 'epub').length,
      },
      {
        key: 'txt',
        label: 'TXT',
        count: sourceBooks.filter((b) => b.format === 'txt').length,
      },
      {
        key: 'recent',
        label: '最近添加',
        count: sourceBooks.filter((b) => Date.now() - b.importedAt < 30 * 86400_000).length,
      },
    ]
    const groupCounts = new Map<string, number>()
    for (const book of sourceBooks) {
      const group = book.group?.trim()
      if (!group) continue
      groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1)
    }
    for (const [group, count] of groupCounts) {
      if (groupCounts.size > 6 && group === [...groupCounts.keys()][0]) continue
      rows.push({ key: `group:${group}`, label: group, count })
    }
    return rows.filter((row) => row.key === 'all' || row.count > 0)
  }, [sourceBooks])

  useEffect(() => {
    if (!categories.some((row) => row.key === category)) setCategory('all')
  }, [categories, category])

  const visible = useMemo(() => {
    const filtered = sourceBooks.filter((book) => {
      if (category === 'all') return true
      if (category === 'reading') {
        const p = progressPercent(book.id)
        return p > 0 && p < 100
      }
      if (category === 'unread') return progressPercent(book.id) === 0
      if (category === 'done') return progressPercent(book.id) >= 100
      if (category === 'epub') return book.format === 'epub'
      if (category === 'txt') return book.format === 'txt'
      if (category === 'recent') return Date.now() - book.importedAt < 30 * 86400_000
      if (category.startsWith('group:')) return book.group === category.slice(6)
      return true
    })
    const sorted = [...filtered]
    sorted.sort((a, b) => {
      if (sort === 'title') return a.title.localeCompare(b.title, 'zh-Hans-CN')
      if (sort === 'imported') return b.importedAt - a.importedAt
      if (tab === 'history') return lastOpened(b) - lastOpened(a)
      return Math.max(lastOpened(b), b.importedAt) - Math.max(lastOpened(a), a.importedAt)
    })
    return sorted
  }, [sourceBooks, category, sort, tab])

  const contextMenu = (event: React.MouseEvent, book: BookMeta) => {
    event.preventDefault()
    event.stopPropagation()
    setSelected(book.id)
    const x = Math.min(event.clientX, window.innerWidth - 200)
    const y = Math.min(event.clientY, window.innerHeight - 260)
    setMenu({ x, y, book })
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await onDelete(pendingDelete)
      setPendingDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  const cardBody = (book: BookMeta) => {
    const percent = progressPercent(book.id)
    return (
      <>
        <div className="cover-wrap">
          <BookCover book={book} />
          {percent > 0 && <span className="cover-progress">{percent}%</span>}
          <button
            className="card-open icon-only tip-top"
            data-tip="打开这本书"
            aria-label={`打开《${book.title}》`}
            onClick={(e) => {
              e.stopPropagation()
              onOpen(book)
            }}
          >
            <Icon name="menu_book" size={16} />
          </button>
        </div>
        <div className="card-text">
          <div className="card-title" title={book.title}>{book.title}</div>
          <div className="card-sub">
            {book.format.toUpperCase()}
            <span className="dot">·</span>
            {formatSize(book.byteLen)}
            <span className="dot">·</span>
            {percent > 0 ? `已读 ${percent}%` : tab === 'history' ? shortDate(lastOpened(book)) : '未开始'}
          </div>
        </div>
      </>
    )
  }

  return (
    <div className="shelf-page">
      <header className="shelf-bar">
        <div className="brand">
          <span className="brand-name">Scrollforge</span>
          <span className="brand-page">书架</span>
        </div>
        <button
          className="btn primary icon-only"
          data-tip="导入电子书（TXT / EPUB / MD / HTML / FB2）"
          aria-label="导入书籍"
          onClick={onImport}
        >
          <Icon name="library_add" />
        </button>
        <button
          className="btn icon-only"
          data-tip="从零新建一本书（书名 / 章节 / 样式）"
          aria-label="新建书"
          onClick={onNewBook}
        >
          <Icon name="note_add" />
        </button>
        <button
          className="btn icon-only"
          data-tip="直接打开磁盘上的书（读过的会自动记下）"
          aria-label="打开文件"
          onClick={onOpenFile}
        >
          <Icon name="folder_open" />
        </button>
        <button
          className="btn icon-only"
          data-tip="把选中的书转换为 EPUB（TXT/MD/HTML/FB2/CBZ/PDF）"
          aria-label="转换为 EPUB"
          onClick={() => onConvert(books.find((book) => book.id === selected))}
        >
          <Icon name="swap_horiz" />
        </button>
        <span className="grow" />
        <label className="field" title="选择书架排序方式">
          <span>排序</span>
          <select value={sort} onChange={(e) => changeSort(e.target.value as Sort)}>
            <option value="recent">最近阅读</option>
            <option value="imported">导入时间</option>
            <option value="title">书名</option>
          </select>
        </label>
      </header>

      <div className="shelf-subbar">
        <div className="shelf-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'history'}
            className={tab === 'history' ? 'on' : ''}
            onClick={() => setTab('history')}
          >
            <Icon name="history" size={16} /> 阅读历史
            <span className="tab-count">{historyBooks.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'library'}
            className={tab === 'library' ? 'on' : ''}
            onClick={() => setTab('library')}
          >
            <Icon name="local_library" size={16} /> 书库
            <span className="tab-count">{libraryBooks.length}</span>
          </button>
        </div>
        <div className="chip-row shelf-chips">
          {categories.map((row) => (
            <button
              key={row.key}
              className={`chip ${category === row.key ? 'on' : ''}`}
              onClick={() => setCategory(row.key)}
            >
              {row.label}
              <span className="chip-count">{row.count}</span>
            </button>
          ))}
        </div>
        <div className="subbar-tools">
          <button
            className={`btn icon-only ${view === 'grid' ? 'on' : ''}`}
            data-tip="网格视图（看封面）"
            aria-label="网格视图"
            onClick={() => changeView('grid')}
          >
            <Icon name="grid_view" />
          </button>
          <button
            className={`btn icon-only ${view === 'list' ? 'on' : ''}`}
            data-tip="列表视图（看详情）"
            aria-label="列表视图"
            onClick={() => changeView('list')}
          >
            <Icon name="view_list" />
          </button>
          <button
            className={`btn icon-only ${view === 'shelf3d' ? 'on' : ''}`}
            data-tip="3D 书架（可左右滑动，点书取出）"
            aria-label="3D 书架视图"
            onClick={() => changeView('shelf3d')}
          >
            <Icon name="shelves" />
          </button>
          <span className="sep" />
          <button
            className="btn icon-only"
            data-tip={`界面主题：${themeLabel(prefs.theme)}（点击切换日间 / 护眼 / 夜间）`}
            aria-label="切换界面主题"
            onClick={() => onPrefs({ theme: nextTheme(prefs.theme) })}
          >
            <Icon name={prefs.theme === 'night' ? 'brightness_3' : prefs.theme === 'eye' ? 'visibility' : 'wb_sunny'} />
          </button>
          <button
            className="btn icon-only"
            data-tip="刷新书架（重新扫描本地书库与阅读历史）"
            aria-label="刷新书架"
            disabled={busy}
            onClick={onRefresh}
          >
            <Icon name="refresh" />
          </button>
          <button
            className="btn icon-only"
            data-tip="设置：文件夹位置、导入偏好、功能开关与说明书"
            aria-label="设置"
            onClick={onSettings}
          >
            <Icon name="settings" />
          </button>
        </div>
      </div>

      <main className={`shelf-body view-${view}`}>
        {sourceBooks.length === 0 ? (
          <div className="shelf-empty">
            <div className="empty-mark" aria-hidden="true">书</div>
            <div className="empty-title">{tab === 'history' ? '还没有阅读记录' : '书库还是空的'}</div>
            <div className="empty-text">
              {tab === 'history'
                ? '打开一本书就会留下记录，下次可以从这里接着读。'
                : '导入一本电子书，或把文件直接拖进窗口。'}
            </div>
            <button className="btn primary icon-only" data-tip="导入第一本书" aria-label="导入第一本书" onClick={onImport}>
              <Icon name="library_add" />
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="shelf-empty">
            <div className="empty-title">这个分类下没有书</div>
            <div className="empty-text">换一个分类看看，或导入新的书。</div>
          </div>
        ) : view === 'grid' ? (
          <div className="grid">
            {visible.map((book) => (
              <article
                key={book.id}
                className={`book-card ${selected === book.id ? 'selected' : ''}`}
                title={`${book.title}（双击打开，右键更多操作）`}
                onClick={() => setSelected(book.id)}
                onDoubleClick={() => onOpen(book)}
                onContextMenu={(e) => contextMenu(e, book)}
              >
                {cardBody(book)}
              </article>
            ))}
          </div>
        ) : view === 'list' ? (
          <div className="list">
            <div className="list-head">
              <span>书名</span>
              <span>格式</span>
              <span>大小</span>
              <span>阅读进度</span>
              <span>最近打开</span>
            </div>
            {visible.map((book) => (
              <article
                key={book.id}
                className={`book-row ${selected === book.id ? 'selected' : ''}`}
                title={`${book.title}（双击打开，右键更多操作）`}
                onClick={() => setSelected(book.id)}
                onDoubleClick={() => onOpen(book)}
                onContextMenu={(e) => contextMenu(e, book)}
              >
                <div className="row-cover">
                  <BookCover book={book} />
                </div>
                <div className="row-text">
                  <div className="card-title" title={book.title}>{book.title}</div>
                  <div className="card-sub">
                    {book.group || (book.storage === 'history' ? '阅读历史' : '本地书库')}
                  </div>
                </div>
                <span className="row-format">{book.format.toUpperCase()}</span>
                <span className="row-size">{formatSize(book.byteLen)}</span>
                <span className="row-progress">
                  {progressPercent(book.id) > 0 ? `${progressPercent(book.id)}%` : '未开始'}
                </span>
                <span className="row-date">{shortDate(lastOpened(book))}</span>
              </article>
            ))}
          </div>
        ) : (
          <Shelf3D
            books={visible}
            selected={selected}
            onSelect={setSelected}
            onOpen={onOpen}
            onContext={contextMenu}
          />
        )}
      </main>

      <footer className="shelf-status">
        <span>{tab === 'history' ? '阅读历史' : '书库'} · 共 {sourceBooks.length} 本</span>
        <span className="dot">·</span>
        <span>TXT {sourceBooks.filter((b) => b.format === 'txt').length} 本</span>
        <span className="dot">·</span>
        <span>EPUB {sourceBooks.filter((b) => b.format === 'epub').length} 本</span>
        <span className="grow" />
        <span>
          {settings?.keepOriginal ? '无痕链接模式（不复制文件）' : '本地书库（保存副本）'}
          <span className="dot">·</span>
          双击打开 · 右键更多
        </span>
      </footer>

      {busy && <div className="shelf-busy">正在导入…</div>}

      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setMenu(null); onOpen(menu.book) }}>
            <span style={{ marginRight: 8 }}><Icon name="menu_book" size={16} /></span>
            打开
          </button>
          <button onClick={() => { setMenu(null); onConvert(menu.book) }}>
            <span style={{ marginRight: 8 }}><Icon name="swap_horiz" size={16} /></span>
            转换为 EPUB
          </button>
          {menu.book.format === 'epub' && (
            <button onClick={() => { setMenu(null); onCheck(menu.book) }}>
              <span style={{ marginRight: 8 }}><Icon name="fact_check" size={16} /></span>
              检查 EPUB
            </button>
          )}
          {menu.book.format === 'epub' && (
            <button onClick={() => { setMenu(null); onEditEpub(menu.book) }}>
              <span style={{ marginRight: 8 }}><Icon name="edit" size={16} /></span>
              编辑 EPUB
            </button>
          )}
          {menu.book.format === 'epub' && (
            <button onClick={() => { setMenu(null); onExportText(menu.book) }}>
              <span style={{ marginRight: 8 }}><Icon name="description" size={16} /></span>
              导出文本
            </button>
          )}
          <button onClick={() => { setMenu(null); setInfo(menu.book) }}>
            <span style={{ marginRight: 8 }}><Icon name="info" size={16} /></span>
            查看信息
          </button>
          <button className="danger" onClick={() => { setMenu(null); setPendingDelete(menu.book) }}>
            <span style={{ marginRight: 8 }}><Icon name="delete" size={16} /></span>
            删除
          </button>
        </div>
      )}

      {info && (
        <div className="modal-mask" onClick={() => setInfo(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>书目信息</h3>
            <dl>
              <dt>书名</dt><dd>{info.title}</dd>
              <dt>格式</dt><dd>{info.format.toUpperCase()}</dd>
              <dt>存储</dt><dd>{info.storage === 'history' ? '阅读历史（原文件）' : '本地书库（副本）'}</dd>
              {info.path && (<><dt>原文件</dt><dd className="path-text">{info.path}</dd></>)}
              {info.group && (<><dt>分组</dt><dd>{info.group}</dd></>)}
              <dt>封面</dt><dd>{info.cover ? '已收录' : '无'}</dd>
              <dt>大小</dt><dd>{formatSize(info.byteLen)}</dd>
              <dt>原文件名</dt><dd>{info.sourceName}</dd>
              <dt>导入时间</dt><dd>{formatDate(info.importedAt)}</dd>
              <dt>最近打开</dt><dd>{shortDate(lastOpened(info))}</dd>
            </dl>
            <div className="modal-actions">
              <button className="btn icon-only tip-top" data-tip="关闭" aria-label="关闭" onClick={() => setInfo(null)}>
                <Icon name="close" />
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingDelete && (
        <div className="modal-mask" onClick={() => (deleting ? null : setPendingDelete(null))}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{pendingDelete.storage === 'history' ? '从阅读历史移除' : '从书库删除'}</h3>
            <p className="modal-text">
              {pendingDelete.storage === 'history'
                ? `确定要移除《${pendingDelete.title}》的阅读记录吗？不会动你的原文件。`
                : `确定要删除《${pendingDelete.title}》吗？只会删除书库里的副本，不影响你的原文件。`}
            </p>
            <div className="modal-actions">
              <button
                className="btn icon-only tip-top"
                data-tip="取消"
                aria-label="取消"
                disabled={deleting}
                onClick={() => setPendingDelete(null)}
              >
                <Icon name="close" />
              </button>
              <button
                className="btn danger-solid icon-only tip-top"
                data-tip={deleting ? '正在删除…' : '确认删除'}
                aria-label="确认删除"
                disabled={deleting}
                onClick={confirmDelete}
              >
                <Icon name="delete" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
