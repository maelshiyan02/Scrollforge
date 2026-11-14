import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { open } from '@tauri-apps/plugin-dialog'
import Shelf from './components/Shelf'
import Reader from './components/Reader'
import ConvertWizard from './components/ConvertWizard'
import ExportTextDialog from './components/ExportTextDialog'
import NewBookWizard from './components/NewBookWizard'
import SettingsDialog, { type SettingsSection } from './components/SettingsDialog'
import HelpDialog from './components/HelpDialog'
import ImportDialog, { type ImportRequest } from './components/ImportDialog'
import CheckDialog from './components/CheckDialog'
import { clearProgress } from './lib/progress'
import { extractCover, forgetCover, clearCoverCache } from './lib/cover'
import { loadTypography, saveTypography } from './lib/typography'
import { loadPrefs, savePrefs, type Prefs } from './lib/prefs'
import { applyTheme } from './lib/theme'
import { ALL_FORMATS, IMPORT_FILTERS, formatLabel } from './lib/formats'
import type { AppSettings, BookMeta, ReaderSource, Typography } from './types'
import './styles.css'

const FALLBACK_FORMATS = ALL_FORMATS

type ShelfHealthReport = {
  scanned: number
  coversRepaired: number
  coversRemoved: number
  repairedTitles: string[]
  removedFiles: string[]
  missingSources: string[]
  uncoveredTitles: string[]
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? '未命名'
}

function bookExtension(path: string): string {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  return ext === 'htm' ? 'html' : ext
}

export default function App() {
  const [library, setLibrary] = useState<BookMeta[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [route, setRoute] = useState<'shelf' | 'reader'>('shelf')
  const [source, setSource] = useState<ReaderSource | null>(null)
  const [openSeq, setOpenSeq] = useState(0)
  const [editBookId, setEditBookId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [toast, setToast] = useState('')
  const [wizard, setWizard] = useState<{ initial?: BookMeta } | null>(null)
  const [newBookOpen, setNewBookOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('storage')
  const [helpOpen, setHelpOpen] = useState(false)
  const [checkBook, setCheckBook] = useState<BookMeta | null>(null)
  const [exportBook, setExportBook] = useState<BookMeta | null>(null)
  const [typography, setTypography] = useState<Typography>(loadTypography)
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const toastTimer = useRef<number | null>(null)

  const notify = useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2800)
  }, [])

  useEffect(() => () => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
  }, [])

  // F1 内置说明书 / Ctrl+, 设置：窗口级监听；阅读器 iframe 内另由 Reader 转发
  // Esc 用捕获阶段：先关最上层整页（说明书 / 设置），避免阅读页同时收到 Esc 直接退出书
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (helpOpen || settingsOpen)) {
        event.preventDefault()
        event.stopPropagation()
        if (helpOpen) setHelpOpen(false)
        else setSettingsOpen(false)
        return
      }
      if (event.key === 'F1') {
        event.preventDefault()
        setHelpOpen((value) => !value)
      } else if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault()
        setSettingsSection('storage')
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [helpOpen, settingsOpen])

  // 启动与「刷新书架」共用：先自检（修复封面、清理冗余、检查正文），再列书架
  const refreshLibrary = useCallback(async () => {
    try {
      const report = await invoke<ShelfHealthReport>('shelf_health')
      const changed =
        report.coversRepaired > 0 ||
        report.coversRemoved > 0 ||
        report.missingSources.length > 0 ||
        report.uncoveredTitles.length > 0
      if (changed) {
        clearCoverCache()
        const parts: string[] = []
        if (report.coversRepaired > 0) parts.push(`修复封面 ${report.coversRepaired} 本`)
        if (report.coversRemoved > 0) parts.push(`清理冗余封面 ${report.coversRemoved} 个`)
        if (report.missingSources.length > 0) parts.push(`正文缺失 ${report.missingSources.length} 本`)
        if (report.uncoveredTitles.length > 0) parts.push(`无封面 ${report.uncoveredTitles.length} 本`)
        notify(`书架自检：${parts.join('，')}`)
      }
    } catch (err) {
      console.warn('书架自检失败', err)
    }
    try {
      const books = await invoke<BookMeta[]>('list_books')
      setLibrary(Array.isArray(books) ? books : [])
    } catch (err) {
      console.warn('读取书架失败', err)
      setLibrary([])
    }
  }, [notify])

  const loadSettings = useCallback(async () => {
    try {
      const value = await invoke<AppSettings>('get_settings')
      setSettings(value)
    } catch (err) {
      console.warn('读取设置失败', err)
    }
  }, [])

  useEffect(() => {
    void refreshLibrary()
    void loadSettings()
  }, [refreshLibrary, loadSettings])

  const updateTypography = useCallback((value: Typography) => {
    setTypography(value)
    saveTypography(value)
  }, [])

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      savePrefs(next)
      return next
    })
  }, [])

  // 三档主题挂到根元素，所有界面（含弹窗/浮层）同步换色
  useEffect(() => {
    applyTheme(prefs.theme)
  }, [prefs.theme])

  const allowedFormats = settings?.importFormats?.length ? settings.importFormats : FALLBACK_FORMATS

  /** 导入一批书：书库模式复制副本，历史模式只登记路径，EPUB 顺手抽封面。 */
  const runImport = useCallback(
    async (request: ImportRequest) => {
      let ok = 0
      const failed: string[] = []
      for (const item of request.items) {
        try {
          const meta = await invoke<BookMeta>('import_book', {
            path: item.path,
            group: item.group ?? null,
            forceHistory: request.forceHistory,
          })
          if (meta.format === 'epub' && !meta.cover) await extractCover(meta)
          ok += 1
        } catch (err) {
          failed.push(`${baseName(item.path)}：${String(err)}`)
        }
      }
      await refreshLibrary()
      return { ok, failed }
    },
    [refreshLibrary],
  )

  const importDropped = useCallback(
    async (paths: string[]) => {
      const bookPaths = paths.filter((path) => allowedFormats.includes(bookExtension(path)))
      if (bookPaths.length === 0) {
        notify(`当前只导入 ${allowedFormats.map(formatLabel).join(' / ')}`)
        return
      }
      setBusy(true)
      try {
        const result = await runImport({
          items: bookPaths.map((path) => ({
            path,
            title: baseName(path).replace(/\.[^.]+$/, ''),
            format: bookExtension(path),
            byteLen: 0,
          })),
          forceHistory: Boolean(settings?.keepOriginal),
        })
        if (result.failed.length === 0) notify(`已导入 ${result.ok} 本书`)
        else notify(`导入 ${result.ok} 本，失败 ${result.failed.length} 本：${result.failed[0]}`)
      } finally {
        setBusy(false)
      }
    },
    [allowedFormats, notify, runImport, settings],
  )

  /** 打开磁盘上的书：按当前存储模式登记，再按书架条目打开，进度可以续上。 */
  const openExternal = useCallback(
    async (path: string, opts?: { edit?: boolean }) => {
      try {
        let meta = await invoke<BookMeta>('open_path', { path })
        if (meta.format === 'epub' && !meta.cover) {
          await extractCover(meta)
          // 封面扩展名可能是 png/webp，重新取一遍书目拿真实的 cover 字段
          const books = await invoke<BookMeta[]>('list_books')
          const list = Array.isArray(books) ? books : []
          setLibrary(list)
          meta = list.find((item) => item.id === meta.id) ?? meta
        }
        setSource({ kind: 'library', meta })
        if (opts?.edit) setEditBookId(meta.id)
        setOpenSeq((n) => n + 1)
        setRoute('reader')
        await refreshLibrary()
        notify(
          settings?.keepOriginal
            ? `已记入阅读历史：《${meta.title}》`
            : `已在书库打开：《${meta.title}》`,
        )
      } catch (err) {
        notify(`打开失败：${String(err)}`)
      }
    },
    [notify, refreshLibrary, settings],
  )

  const chooseOpenFile = useCallback(async () => {
    try {
      const picked = await open({
        multiple: false,
        title: '打开一本电子书',
        filters: IMPORT_FILTERS.map((group) => ({
          name: group.name,
          extensions: group.extensions.filter((ext) => allowedFormats.includes(ext === 'htm' ? 'html' : ext)),
        })).filter((group) => group.extensions.length > 0),
      })
      if (!picked || Array.isArray(picked)) return
      await openExternal(picked)
    } catch (err) {
      notify(`打开文件失败：${String(err)}`)
    }
  }, [allowedFormats, notify, openExternal])

  const openSavedEpub = useCallback(
    async (path: string, editAfter = false) => {
      try {
        await openExternal(path, { edit: editAfter })
      } catch (err) {
        notify(`打开生成的 EPUB 失败：${String(err)}`)
      }
    },
    [notify, openExternal],
  )

  const openLibraryBook = useCallback(
    (book: BookMeta) => {
      setSource({ kind: 'library', meta: book })
      setOpenSeq((n) => n + 1)
      setRoute('reader')
      // 立即把最近打开时间写回（书库书目 / 历史记录都支持）
      void invoke('touch_book', { id: book.id })
        .catch((err) => console.warn('更新最近打开失败', err))
    },
    [],
  )

  const deleteBook = useCallback(
    async (book: BookMeta) => {
      try {
        await invoke('delete_book', { id: book.id })
        forgetCover(book.id)
        clearProgress(`lib:${book.id}`)
        await refreshLibrary()
        notify(book.storage === 'history' ? `已移除阅读记录《${book.title}》` : `已删除《${book.title}》`)
      } catch (err) {
        notify(`删除失败：${String(err)}`)
      }
    },
    [notify, refreshLibrary],
  )

  const saveAppSettings = useCallback(
    async (next: AppSettings, nextPrefs: Prefs) => {
      const saved = await invoke<AppSettings>('save_settings', { settings: next })
      setSettings(saved)
      setPrefs(nextPrefs)
      savePrefs(nextPrefs)
      await refreshLibrary()
      notify('设置已保存')
    },
    [notify, refreshLibrary],
  )

  // 拖拽导入：整窗监听，按设置里的格式过滤
  useEffect(() => {
    let unlisten: (() => void) | undefined
    void (async () => {
      try {
        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload as { type: string; paths?: string[] }
          if (payload.type === 'enter' || payload.type === 'over') setDragging(true)
          if (payload.type === 'leave') setDragging(false)
          if (payload.type === 'drop') {
            setDragging(false)
            void importDropped(payload.paths ?? [])
          }
        })
      } catch (err) {
        console.warn('拖拽监听不可用', err)
      }
    })()
    return () => unlisten?.()
  }, [importDropped])

  // 启动参数：命令行或“用本程序打开”传入的文件，同样登记后再读
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const args = await invoke<string[]>('start_args')
        const path = args.find((item) => FALLBACK_FORMATS.includes(bookExtension(item)))
        if (!path || cancelled) return
        await openExternal(path)
      } catch (err) {
        console.warn('命令行打开失败', err)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [openExternal])

  return (
    <>
      {route === 'shelf' || !source ? (
        <Shelf
          books={library}
          busy={busy}
          settings={settings}
          prefs={prefs}
          onPrefs={updatePrefs}
          onOpen={openLibraryBook}
          onImport={() => setImportOpen(true)}
          onNewBook={() => setNewBookOpen(true)}
          onOpenFile={chooseOpenFile}
          onRefresh={() => void refreshLibrary()}
          onSettings={() => {
            setSettingsSection('storage')
            setSettingsOpen(true)
          }}
          onHelp={() => setHelpOpen(true)}
          onAbout={() => {
            setSettingsSection('about')
            setSettingsOpen(true)
          }}
          onConvert={(book) => setWizard({ initial: book })}
          onCheck={setCheckBook}
          onEditEpub={(book) => {
            // 从书库直接打开阅读器 + 自动开编辑面板
            setEditBookId(book.id)
            openLibraryBook(book)
          }}
          onExportText={setExportBook}
          onDelete={deleteBook}
        />
      ) : (
        <Reader
          key={`reader-${openSeq}`}
          source={source}
          typography={typography}
          onTypography={updateTypography}
          prefs={prefs}
          onPrefs={updatePrefs}
          onHelp={() => setHelpOpen(true)}
          onBack={() => { setRoute('shelf'); void refreshLibrary() }}
          onOpenEpub={chooseOpenFile}
          onNotify={notify}
          exportDir={settings?.finalExportDir}
          autoEditBookId={editBookId}
          onAutoEditConsumed={() => setEditBookId(null)}
        />
      )}

      {dragging && (
        <div className="dropmask">
          松手即可导入 {allowedFormats.map((ext) => ext.toUpperCase()).join(' / ')} 到书架
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}

      {importOpen && settings && (
        <ImportDialog
          settings={settings}
          onClose={() => setImportOpen(false)}
          onNotify={notify}
          onImport={runImport}
        />
      )}

      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          prefs={prefs}
          initialSection={settingsSection}
          onClose={() => setSettingsOpen(false)}
          onSave={saveAppSettings}
          onNotify={notify}
        />
      )}

      {helpOpen && (
        <HelpDialog onClose={() => setHelpOpen(false)} />
      )}

      {checkBook && <CheckDialog book={checkBook} onClose={() => setCheckBook(null)} />}

      {exportBook && (
        <ExportTextDialog
          book={exportBook}
          exportDir={settings?.finalExportDir}
          onClose={() => setExportBook(null)}
          onNotify={notify}
        />
      )}

      {newBookOpen && (
        <NewBookWizard
          exportDir={settings?.finalExportDir}
          initialPreset={prefs.convertPreset}
          onClose={() => setNewBookOpen(false)}
          onNotify={notify}
          onOpenSaved={(path) => {
            setNewBookOpen(false)
            void openSavedEpub(path, true)
          }}
        />
      )}

      {wizard && (
        <ConvertWizard
          books={library}
          initialBook={wizard.initial}
          exportDir={settings?.finalExportDir}
          initialIndent={prefs.convertIndent}
          initialCenterHeading={prefs.convertCenterHeading}
          onClose={() => setWizard(null)}
          onNotify={notify}
          onOpenSaved={(path) => {
            setWizard(null)
            void openSavedEpub(path)
          }}
        />
      )}
    </>
  )
}
