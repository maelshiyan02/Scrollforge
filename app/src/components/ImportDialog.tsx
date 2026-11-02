import { useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import Icon from './Icon'
import { ALL_FORMATS, IMPORT_FILTERS, importFormatsHint } from '../lib/formats'
import type { AppSettings, ScanItem } from '../types'

type Pending = { path: string; title: string; format: string; byteLen: number; group?: string }

export type ImportRequest = {
  items: Pending[]
  forceHistory: boolean
}

type Props = {
  settings: AppSettings
  onClose: () => void
  onNotify: (message: string) => void
  onImport: (request: ImportRequest) => Promise<{ ok: number; failed: string[] }>
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function ImportDialog({ settings, onClose, onNotify, onImport }: Props) {
  const [tab, setTab] = useState<'file' | 'folder'>('file')
  const [pending, setPending] = useState<Pending[]>([])
  const [scanned, setScanned] = useState<ScanItem[] | null>(null)
  const [scanDir, setScanDir] = useState('')
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [forceHistory, setForceHistory] = useState(
    settings.storageMode === 'history' || settings.keepOriginal,
  )
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')

  const formats = settings.importFormats.length ? settings.importFormats : ALL_FORMATS
  const chosen = tab === 'file' ? pending.length : scanned?.filter((item) => checked.has(item.path)).length ?? 0

  const filters = useMemo(
    () =>
      IMPORT_FILTERS.map((group) => ({
        name: group.name,
        extensions: group.extensions.filter((ext) =>
          formats.includes(ext === 'htm' ? 'html' : ext),
        ),
      })).filter((group) => group.extensions.length > 0),
    [formats],
  )

  const groups = useMemo(() => {
    if (!scanned) return []
    const map = new Map<string, ScanItem[]>()
    for (const item of scanned) {
      const key = settings.folderGroup && item.group ? item.group : '未分组'
      const list = map.get(key) ?? []
      list.push(item)
      map.set(key, list)
    }
    return [...map.entries()]
  }, [scanned, settings.folderGroup])

  const chooseFiles = async () => {
    try {
      const picked = await open({
        multiple: true,
        title: '选择要导入的电子书',
        filters,
      })
      if (!picked) return
      const paths = Array.isArray(picked) ? picked : [picked]
      const existing = new Set(pending.map((item) => item.path))
      const added: Pending[] = paths
        .filter((path) => !existing.has(path))
        .map((path) => ({
          path,
          title: baseName(path).replace(/\.[^.]+$/, ''),
          format: (path.split('.').pop() ?? '').toLowerCase(),
          byteLen: 0,
        }))
      setPending((prev) => [...prev, ...added])
    } catch (err) {
      onNotify(`选择文件失败：${String(err)}`)
    }
  }

  const chooseFolder = async () => {
    try {
      const picked = await open({ directory: true, multiple: false, title: '选择要扫描的文件夹' })
      if (!picked || Array.isArray(picked)) return
      setBusy(true)
      setProgress('正在扫描文件夹…')
      const items = await invoke<ScanItem[]>('scan_books', {
        dir: picked,
        formats,
        minBytes: settings.minBytes,
      })
      setScanned(items)
      setScanDir(picked)
      setChecked(new Set(items.map((item) => item.path)))
      setProgress(items.length ? `找到 ${items.length} 本可导入的书` : '这个文件夹里没有匹配的书')
    } catch (err) {
      onNotify(`扫描失败：${String(err)}`)
      setProgress('')
    } finally {
      setBusy(false)
    }
  }

  const toggle = (path: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const runImport = async () => {
    const items: Pending[] =
      tab === 'file'
        ? pending
        : (scanned ?? [])
            .filter((item) => checked.has(item.path))
            .map((item) => ({
              path: item.path,
              title: item.title,
              format: item.format,
              byteLen: item.byteLen,
              group: settings.folderGroup ? item.group : undefined,
            }))
    if (items.length === 0) {
      onNotify('还没有选择要导入的书')
      return
    }
    setBusy(true)
    setProgress(`正在导入 0 / ${items.length}`)
    try {
      const result = await onImport({ items, forceHistory })
      if (result.failed.length === 0) {
        onNotify(forceHistory ? `已登记 ${result.ok} 本书的阅读历史` : `已导入 ${result.ok} 本书`)
        onClose()
      } else {
        onNotify(`成功 ${result.ok} 本，失败 ${result.failed.length} 本：${result.failed[0]}`)
        setProgress('')
      }
    } catch (err) {
      onNotify(`导入失败：${String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={() => !busy && onClose()}>
      <div className="import-modal" onClick={(event) => event.stopPropagation()}>
        <header className="import-head">
          <div>
            <h2>导入书籍</h2>
            <p>支持 {importFormatsHint(formats) || formats.map((ext) => ext.toUpperCase()).join(' · ')}，可一次选多本，也可以整个文件夹扫描。</p>
          </div>
          <button className="btn icon-only tip-top" data-tip="关闭" aria-label="关闭导入" onClick={onClose} disabled={busy}>
            <Icon name="close" />
          </button>
        </header>

        <div className="import-tabs">
          <button className={tab === 'file' ? 'on' : ''} onClick={() => setTab('file')}>
            <Icon name="upload_file" size={17} /> 选择文件
          </button>
          <button className={tab === 'folder' ? 'on' : ''} onClick={() => setTab('folder')}>
            <Icon name="folder_copy" size={17} /> 扫描文件夹
          </button>
          <span className="grow" />
          <span className="import-count">已选 {chosen} 本</span>
        </div>

        <div className="import-body">
          {tab === 'file' ? (
            <>
              <button className="import-drop" onClick={() => void chooseFiles()} disabled={busy}>
                <Icon name="add_circle" size={38} />
                <span className="drop-title">点这里选择电子书</span>
                <span className="drop-text">也可以直接把文件拖进主窗口</span>
              </button>
              {pending.length > 0 && (
                <ul className="pick-list">
                  {pending.map((item) => (
                    <li key={item.path}>
                      <span className={`fmt fmt-${item.format}`}>{item.format.toUpperCase()}</span>
                      <span className="pick-title" title={item.path}>{item.title}</span>
                      <button
                        className="pick-remove"
                        aria-label={`移除 ${item.title}`}
                        data-tip="从本次导入中移除"
                        onClick={() => setPending((prev) => prev.filter((row) => row.path !== item.path))}
                      >
                        <Icon name="close" size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              <button className="import-drop small" onClick={() => void chooseFolder()} disabled={busy}>
                <Icon name="folder_open" size={30} />
                <span className="drop-title">{scanDir ? '换一个文件夹' : '选择文件夹开始扫描'}</span>
                <span className="drop-text">会递归查找子文件夹，按格式与大小过滤</span>
              </button>
              {progress && <div className="import-progress">{progress}</div>}
              {scanned && scanned.length > 0 && (
                <>
                  <div className="scan-tools">
                    <button className="btn small" onClick={() => setChecked(new Set(scanned.map((item) => item.path)))}>
                      全选
                    </button>
                    <button className="btn small" onClick={() => setChecked(new Set())}>
                      全不选
                    </button>
                    <span className="grow" />
                    <span className="scan-dir" title={scanDir}>{scanDir}</span>
                  </div>
                  <div className="scan-list">
                    {groups.map(([group, items]) => (
                      <div className="scan-group" key={group}>
                        <div className="scan-group-title">{group}（{items.length}）</div>
                        {items.map((item) => (
                          <label className="scan-row" key={item.path}>
                            <input
                              type="checkbox"
                              checked={checked.has(item.path)}
                              onChange={() => toggle(item.path)}
                            />
                            <span className={`fmt fmt-${item.format}`}>{item.format.toUpperCase()}</span>
                            <span className="pick-title" title={item.path}>{item.title}</span>
                            <span className="scan-size">{sizeOf(item.byteLen)}</span>
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <footer className="import-foot">
          <label className="settings-switch compact">
            <input
              type="checkbox"
              checked={forceHistory}
              onChange={(event) => setForceHistory(event.target.checked)}
            />
            <span>
              只登记阅读历史
              <small>不复制文件，原文件移动后会读不到</small>
            </span>
          </label>
          <span className="grow" />
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn primary" onClick={() => void runImport()} disabled={busy || chosen === 0}>
            {busy ? '正在导入…' : `导入 ${chosen} 本`}
          </button>
        </footer>
      </div>
    </div>
  )
}
