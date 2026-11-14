import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { open } from '@tauri-apps/plugin-dialog'
import Icon from './Icon'
import PageBar from './PageBar'
import GlossaryDialog from './GlossaryDialog'
import { FORMATS } from '../lib/formats'
import {
  FEATURES,
  GROUP_LABEL,
  SHORTCUTS,
  SHORTCUT_SCOPE_LABEL,
  STATUS_LABEL,
  type FeatureEntry,
  type SettingMeta,
  type ShortcutScope,
} from '../lib/features'
import { probeEngine, translateConfigFromPrefs, type EngineName } from '../lib/translate'
import type { Prefs } from '../lib/prefs'
import type { AppSettings } from '../types'

const ENGINE_LABEL: Record<EngineName, string> = {
  online: '在线',
  local: '本机 HTTP',
  builtin: '内置离线',
  baidu: '百度翻译',
  baiduLlm: '百度大模型',
  memory: '翻译记忆',
}

/** 与 Rust 端 default_dirs 保持一致，仅作为接口失败时的兜底 */
const FALLBACK_DIRS = {
  library: 'D:\\AI Coding Project Management\\Scrollforge\\local book repository',
  readingHistory: 'D:\\AI Coding Project Management\\Scrollforge\\reading history',
  finalExport: 'D:\\AI Coding Project Management\\Scrollforge\\final export',
}

/** 旧版浮动窗口的位置与尺寸持久化键；现在设置是整页，挂载时清掉历史脏数据。 */
const LEGACY_POS_KEY = 'scrollforge:settings-window-pos'
const LEGACY_SIZE_KEY = 'scrollforge:settings-window-size'

const ALL_FORMATS: { ext: string; label: string }[] = FORMATS.map((item) => ({
  ext: item.ext,
  label: item.label,
}))

/** library_check 的返回结构（与 Rust 端 LibraryReport 保持一致） */
type LibraryReport = {
  scanned: number
  books: number
  renamed: number
  indexRebuilt: boolean
  missingDirs: string[]
  unregistered: string[]
  duplicates: string[]
  changedSources: string[]
  legacyDirs: string[]
  sidecarsMoved: number
  legacySidecars: string[]
  unknownSidecars: string[]
}

export type SettingsSection =
  | 'storage'
  | 'import'
  | 'reading'
  | 'editing'
  | 'forge'
  | 'translate'
  | 'general'
  | 'shortcuts'
  | 'about'

type Props = {
  settings: AppSettings
  prefs: Prefs
  onClose: () => void
  onSave: (settings: AppSettings, prefs: Prefs) => Promise<void>
  onNotify: (message: string) => void
  /** 打开时定位到的分类（左下角菜单「关于」用） */
  initialSection?: SettingsSection
}

type Section = SettingsSection

/** 功能分区的键，设置页与帮助页共用同一顺序 */
const GROUP_KEYS = ['reading', 'editing', 'forge', 'translate', 'general'] as const
const SCOPE_ORDER: ShortcutScope[] = ['universal', 'shelf', 'reading', 'editing', 'forge']

type DirKey = 'libraryDir' | 'readingHistoryDir' | 'finalExportDir'

type PathCardProps = {
  icon: string
  title: string
  desc: string
  value: string
  placeholder: string
  onChange: (value: string) => void
  onChoose: () => void
  onOpen: () => void
  onReset: () => void
}

/** 一个文件夹切面：图标 + 说明 + 路径 + 选择/打开/恢复默认 */
function PathCard({
  icon, title, desc, value, placeholder, onChange, onChoose, onOpen, onReset,
}: PathCardProps) {
  return (
    <div className="path-card">
      <div className="path-card__head">
        <span className="path-card__icon"><Icon name={icon} size={18} /></span>
        <div className="path-card__text">
          <span className="path-card__title">{title}</span>
          <span className="path-card__desc">{desc}</span>
        </div>
      </div>
      <input
        className="path-card__input"
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <div className="path-card__actions">
        <button className="btn" onClick={onChoose}>
          <Icon name="folder_open" size={16} />选择
        </button>
        <button className="btn" onClick={onOpen}>
          <Icon name="open_in_new" size={16} />打开
        </button>
        <button className="btn" onClick={onReset}>
          <Icon name="restart_alt" size={16} />恢复默认
        </button>
      </div>
    </div>
  )
}

type SettingRowProps = {
  setting: SettingMeta
  prefs: Prefs
  onChange: (patch: Partial<Prefs>) => void
  onAction: (action: 'storage' | 'glossary' | 'translateTest' | 'translateModel') => void
  /** 内置离线模型的状态与下载进度（只有翻译设置项用得到） */
  model?: { installed: boolean; bytes: number; approxBytes: number; dir: string } | null
  download?: { done: number; total: number } | null
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 MB'
  // 用十进制换算，和文案里的「约 900MB」保持同一口径
  const mb = bytes / 1_000_000
  return mb >= 1000 ? `${(mb / 1000).toFixed(2)} GB` : `${Math.round(mb)} MB`
}

const ACTION_LABEL: Record<
  'storage' | 'glossary' | 'translateTest' | 'translateModel',
  { icon: string; text: string }
> = {
  storage: { icon: 'folder_open', text: '去设置文件夹' },
  glossary: { icon: 'translate', text: '打开术语表' },
  translateTest: { icon: 'network_check', text: '测试连接' },
  translateModel: { icon: 'download', text: '下载离线模型' },
}

/** 功能注册表里的一个设置项：开关 / 下拉 / 数字 / 文本 / 说明 */
function SettingRow({ setting, prefs, onChange, onAction, model, download }: SettingRowProps) {
  if (setting.kind === 'note') {
    const pct =
      download && download.total > 0
        ? Math.min(100, Math.round((download.done / download.total) * 100))
        : download
          ? 0
          : null
    return (
      <div className="feature-setting feature-setting__note">
        <span className="feature-setting__label">{setting.label}</span>
        <small>{setting.hint}</small>
        {setting.action === 'translateModel' && model && (
          <div className="feature-model">
            <span className={`feature-model__state ${model.installed ? 'ok' : ''}`}>
              {model.installed
                ? `已安装 · ${formatSize(model.bytes)}`
                : model.bytes > 0
                  ? `下载中断 · ${formatSize(model.bytes)} / 约 ${formatSize(model.approxBytes)}`
                  : `未安装 · 约 ${formatSize(model.approxBytes)}`}
            </span>
            <span className="feature-model__dir" title={model.dir}>
              存放：{model.dir}
            </span>
            {pct !== null && (
              <div className="feature-progress" role="progressbar" aria-valuenow={pct}>
                <i style={{ width: `${pct}%` }} />
                <span>
                  {pct}% · {formatSize(download?.done ?? 0)} / 约 {formatSize(download?.total ?? 0)}
                </span>
              </div>
            )}
          </div>
        )}
        {setting.action && (
          <button className="btn feature-setting__action" onClick={() => onAction(setting.action!)}>
            <Icon name={ACTION_LABEL[setting.action].icon} size={15} />
            {ACTION_LABEL[setting.action].text}
          </button>
        )}
      </div>
    )
  }

  const value = setting.key ? (prefs[setting.key] as unknown) : undefined

  if (setting.kind === 'toggle') {
    return (
      <label className={`feature-setting feature-toggle ${setting.disabled ? 'disabled' : ''}`}>
        <input
          type="checkbox"
          disabled={setting.disabled}
          checked={Boolean(value)}
          onChange={(event) => {
            if (setting.key) onChange({ [setting.key]: event.target.checked } as Partial<Prefs>)
          }}
        />
        <span>
          <span className="feature-setting__label">{setting.label}</span>
          <small>{setting.hint}</small>
        </span>
      </label>
    )
  }

  if (setting.kind === 'text') {
    return (
      <div className="feature-setting">
        <div className="feature-setting__head">
          <span className="feature-setting__label">{setting.label}</span>
          <small>{setting.hint}</small>
        </div>
        <input
          className="feature-input"
          type={setting.secret ? 'password' : 'text'}
          spellCheck={false}
          disabled={setting.disabled}
          placeholder={setting.placeholder}
          value={String(value ?? '')}
          onChange={(event) => {
            if (setting.key) onChange({ [setting.key]: event.target.value } as Partial<Prefs>)
          }}
        />
      </div>
    )
  }

  if (setting.kind === 'select') {
    return (
      <div className="feature-setting">
        <div className="feature-setting__head">
          <span className="feature-setting__label">{setting.label}</span>
          <small>{setting.hint}</small>
        </div>
        <select
          className="feature-select"
          disabled={setting.disabled}
          value={String(value ?? '')}
          onChange={(event) => {
            if (setting.key) onChange({ [setting.key]: event.target.value } as Partial<Prefs>)
          }}
        >
          {setting.options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
    )
  }

  return (
    <div className="feature-setting">
      <div className="feature-setting__head">
        <span className="feature-setting__label">{setting.label}</span>
        <small>{setting.hint}</small>
      </div>
      <div className="feature-number">
        <input
          type="number"
          min={setting.min}
          max={setting.max}
          step={setting.step ?? 1}
          disabled={setting.disabled}
          value={Number(value ?? setting.min)}
          onChange={(event) => {
            if (!setting.key) return
            const num = Number(event.target.value)
            if (!Number.isFinite(num)) return
            const clamped = Math.min(setting.max, Math.max(setting.min, Math.round(num)))
            onChange({ [setting.key]: clamped } as Partial<Prefs>)
          }}
        />
        {setting.unit && <span>{setting.unit}</span>}
      </div>
    </div>
  )
}

type FeatureSectionProps = {
  group: FeatureEntry['group']
  prefs: Prefs
  query: string
  onChange: (patch: Partial<Prefs>) => void
  onAction: (action: 'storage' | 'glossary' | 'translateTest' | 'translateModel') => void
  model?: { installed: boolean; bytes: number; approxBytes: number; dir: string } | null
  download?: { done: number; total: number } | null
}

function featureMatches(feature: FeatureEntry, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  return (
    feature.title.toLowerCase().includes(needle) ||
    feature.desc.toLowerCase().includes(needle) ||
    feature.where.toLowerCase().includes(needle) ||
    feature.settings.some(
      (setting) => setting.label.toLowerCase().includes(needle) || setting.hint.toLowerCase().includes(needle),
    )
  )
}

/** 一个功能分区：功能卡片可展开/收起，支持搜索过滤（设置页与帮助页共用口径） */
function FeatureSection({ group, prefs, query, onChange, onAction, model, download }: FeatureSectionProps) {
  const items = FEATURES.filter((feature) => feature.group === group && featureMatches(feature, query))
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  return (
    <>
      <h2>{GROUP_LABEL[group]}功能</h2>
      <p className="settings-hint">
        每个功能都来自同一份功能注册表，帮助说明书（F1）由它生成；点击标题可展开或收起细节。
      </p>
      {items.length === 0 && <p className="settings-hint">没有匹配「{query}」的功能。</p>}
      <div className="feature-list">
        {items.map((feature) => {
          const open = !collapsed[feature.id]
          return (
            <div
              key={feature.id}
              className={`feature-card ${feature.status === 'planned' ? 'feature-card--planned' : ''} ${open ? 'is-open' : ''}`}
            >
              <button
                className="feature-card__head"
                aria-expanded={open}
                onClick={() => setCollapsed((prev) => ({ ...prev, [feature.id]: !prev[feature.id] }))}
              >
                <span className="feature-icon"><Icon name={feature.icon} size={20} /></span>
                <span className="feature-title">
                  {feature.title}
                  <em
                    className={`feature-tag ${
                      feature.status === 'online' ? 'on' : feature.status === 'beta' ? 'beta' : ''
                    }`}
                  >
                    {STATUS_LABEL[feature.status]}
                  </em>
                </span>
                <Icon name={open ? 'expand_less' : 'expand_more'} size={18} />
              </button>
              {open && (
                <div className="feature-text">
                  <span className="feature-desc">{feature.desc}</span>
                  <span className="feature-where">{feature.where}</span>
                  {feature.settings.length > 0 && (
                    <div className="feature-settings">
                      {feature.settings.map((setting) => (
                        <SettingRow
                          key={setting.label}
                          setting={setting}
                          prefs={prefs}
                          onChange={onChange}
                          onAction={onAction}
                          model={
                            'action' in setting && setting.action === 'translateModel' ? model : undefined
                          }
                          download={
                            'action' in setting && setting.action === 'translateModel' ? download : undefined
                          }
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}

export default function SettingsDialog({
  settings,
  prefs,
  onClose,
  onSave,
  onNotify,
  initialSection = 'storage',
}: Props) {
  const [section, setSection] = useState<Section>(initialSection)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<AppSettings>({ ...settings })
  const [draftPrefs, setDraftPrefs] = useState<Prefs>({ ...prefs })
  const [saving, setSaving] = useState(false)
  const [defaults, setDefaults] = useState(FALLBACK_DIRS)
  // 版本号单一来源：tauri.conf.json → getVersion()；不写死兜底值
  const [version, setVersion] = useState('')
  const [glossaryOpen, setGlossaryOpen] = useState(false)
  const [testing, setTesting] = useState(false)
  const [model, setModel] = useState<{
    installed: boolean
    bytes: number
    approxBytes: number
    dir: string
  } | null>(null)
  const [download, setDownload] = useState<{ done: number; total: number } | null>(null)
  const [checkingLibrary, setCheckingLibrary] = useState(false)
  const [libraryReport, setLibraryReport] = useState<LibraryReport | null>(null)

  // 清掉旧版浮动窗口留下的坐标/尺寸，避免历史脏数据继续影响任何组件
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_POS_KEY)
      localStorage.removeItem(LEGACY_SIZE_KEY)
    } catch {
      // 隐私模式等场景忽略
    }
  }, [])

  // 切换分类时清空搜索，避免上一页关键词把下一页过滤空
  useEffect(() => {
    setQuery('')
  }, [section])

  // Esc 关闭（整页与说明书一致：Esc 关闭）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!saving) onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, saving])


  useEffect(() => {
    void getVersion()
      .then((value) => value && setVersion(value))
      .catch(() => {
        // 读不到就显示「读取中」
      })
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const value = await invoke<typeof FALLBACK_DIRS>('default_dirs')
        if (value) setDefaults(value)
      } catch {
        // 用兜底常量
      }
    })()
  }, [])

  const patch = (value: Partial<AppSettings>) => setDraft((prev) => ({ ...prev, ...value }))
  const patchPrefs = (value: Partial<Prefs>) =>
    setDraftPrefs((prev) => ({ ...prev, ...value }))

  const toggleFormat = (ext: string) => {
    const has = draft.importFormats.includes(ext)
    const next = has
      ? draft.importFormats.filter((item) => item !== ext)
      : [...draft.importFormats, ext]
    if (next.length === 0) {
      onNotify('至少保留一种导入格式')
      return
    }
    patch({ importFormats: next })
  }

  const chooseDir = async (key: DirKey, title: string) => {
    try {
      const picked = await open({ directory: true, multiple: false, title })
      if (!picked || Array.isArray(picked)) return
      patch({ [key]: picked } as Partial<AppSettings>)
    } catch (err) {
      onNotify(`选择文件夹失败：${String(err)}`)
    }
  }

  const revealDir = async (path: string) => {
    try {
      await invoke('open_folder', { path })
    } catch (err) {
      onNotify(`打开文件夹失败：${String(err)}`)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      await onSave(draft, draftPrefs)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const testTranslate = async () => {
    if (testing) return
    setTesting(true)
    try {
      const result = await probeEngine(translateConfigFromPrefs(draftPrefs))
      onNotify(`翻译引擎连接正常（${ENGINE_LABEL[result.engine]} · ${result.ms} ms）`)
    } catch (err) {
      onNotify(`翻译引擎连接失败：${String(err)}`)
    } finally {
      setTesting(false)
    }
  }

  const modelDir = draftPrefs.translateModelDir

  useEffect(() => {
    let alive = true
    void invoke<Array<{ installed: boolean; bytes: number; approxBytes: number; dir: string }>>(
      'nmt_status',
      { dir: modelDir || null },
    )
      .then((list) => {
        if (alive) setModel(list[0] ?? null)
      })
      .catch((err) => console.warn('读取离线模型状态失败：', err))
    return () => {
      alive = false
    }
  }, [modelDir])

  /** 下载内置离线模型：用轮询 nmt_status 驱动进度条（比事件更可靠）。 */
  const downloadModel = async () => {
    if (download) return
    setDownload({ done: 0, total: 0 })
    onNotify('开始下载内置离线模型（约 900MB），请保持网络连通…')
    let lastPct = -25
    const timer = window.setInterval(() => {
      void invoke<Array<{ installed: boolean; bytes: number; approxBytes: number; dir: string }>>(
        'nmt_status',
        { dir: modelDir || null },
      )
        .then((list) => {
          const current = list[0]
          if (!current) return
          setModel(current)
          setDownload({ done: current.bytes, total: current.approxBytes })
          if (current.approxBytes > 0) {
            const pct = Math.min(100, Math.round((current.bytes / current.approxBytes) * 100))
            if (pct - lastPct >= 25) {
              lastPct = pct
              onNotify(`离线模型下载中：${pct}%`)
            }
          }
        })
        .catch(() => undefined)
    }, 1500)
    try {
      const status = await invoke<{
        installed: boolean
        bytes: number
        approxBytes: number
        dir: string
      }>('nmt_download', { id: 'nllb_600m', dir: modelDir || null })
      setModel(status)
      onNotify(
        status.installed
          ? `离线模型已就绪（${formatSize(status.bytes)}），之后可断网翻译。`
          : '离线模型下载未完成，可重试。',
      )
    } catch (err) {
      onNotify(`离线模型下载失败：${String(err)}`)
    } finally {
      window.clearInterval(timer)
      setDownload(null)
      void invoke<Array<{ installed: boolean; bytes: number; approxBytes: number; dir: string }>>(
        'nmt_status',
        { dir: modelDir || null },
      )
        .then((list) => setModel(list[0] ?? null))
        .catch(() => undefined)
    }
  }

  const checkLibrary = async () => {
    if (checkingLibrary) return
    setCheckingLibrary(true)
    try {
      const report = await invoke<LibraryReport>('library_check')
      setLibraryReport(report)
      const issues =
        report.missingDirs.length +
        report.duplicates.length +
        report.changedSources.length +
        report.unregistered.length +
        report.legacyDirs.length +
        report.legacySidecars.length +
        report.unknownSidecars.length
      onNotify(issues ? `书库检查完成：发现 ${issues} 处需要留意` : '书库检查完成：索引与目录一致')
    } catch (err) {
      onNotify(`书库检查失败：${String(err)}`)
    } finally {
      setCheckingLibrary(false)
    }
  }

  const handleAction = (action: 'storage' | 'glossary' | 'translateTest' | 'translateModel') => {
    if (action === 'storage') setSection('storage')
    else if (action === 'glossary') setGlossaryOpen(true)
    else if (action === 'translateModel') void downloadModel()
    else void testTranslate()
  }

  return (
    <>
    <div className="settings-page" role="dialog" aria-label="设置">
      <PageBar title="设置" icon="settings" onBack={onClose} />

      <div className="settings-modal">
        <aside className="settings-nav">
          <button className={section === 'storage' ? 'on' : ''} onClick={() => setSection('storage')}>
            <Icon name="inventory_2" size={17} />
            <span>文件夹与书库</span>
          </button>
          <button className={section === 'import' ? 'on' : ''} onClick={() => setSection('import')}>
            <Icon name="file_open" size={17} />
            <span>导入</span>
          </button>
          <div className="settings-nav__group">功能</div>
          {(['reading', 'editing', 'forge', 'translate', 'general'] as const).map((group) => (
            <button
              key={group}
              className={section === group ? 'on' : ''}
              onClick={() => setSection(group)}
            >
              <Icon
                name={
                  group === 'reading'
                    ? 'auto_stories'
                    : group === 'editing'
                      ? 'edit_note'
                      : group === 'forge'
                        ? 'build'
                        : group === 'translate'
                          ? 'translate'
                          : 'widgets'
                }
                size={17}
              />
              <span>{GROUP_LABEL[group]}</span>
            </button>
          ))}
          <div className="settings-nav__group">其他</div>
          <button className={section === 'shortcuts' ? 'on' : ''} onClick={() => setSection('shortcuts')}>
            <Icon name="keyboard" size={17} />
            <span>快捷键</span>
          </button>
          <button className={section === 'about' ? 'on' : ''} onClick={() => setSection('about')}>
            <Icon name="info" size={17} />
            <span>关于</span>
          </button>
        </aside>

        <section className="settings-main">
          {GROUP_KEYS.includes(section as (typeof GROUP_KEYS)[number]) && (
            <div className="settings-search">
              <Icon name="search" size={16} />
              <input
                type="search"
                value={query}
                placeholder="搜索功能、设置项或说明"
                onChange={(event) => setQuery(event.target.value)}
              />
              {query && (
                <button className="btn small" onClick={() => setQuery('')}>清空</button>
              )}
            </div>
          )}
          {section === 'storage' && (
            <>
              <h2>书籍与文件夹</h2>
              <p className="settings-hint">
                阅读历史与本地书库并存，不再二选一：历史只记录读过什么、读到哪一页；本地书库保存副本。
                三个文件夹各自独立，可分别指定位置。
              </p>

              <div className="path-list">
                <PathCard
                  icon="history"
                  title="阅读历史"
                  desc="只记录读过哪些书、读到哪一页，不复制文件；原文件移动或删除后会提示找不到。"
                  value={draft.readingHistoryDir}
                  placeholder={defaults.readingHistory}
                  onChange={(value) => patch({ readingHistoryDir: value })}
                  onChoose={() => void chooseDir('readingHistoryDir', '选择阅读历史文件夹')}
                  onOpen={() => void revealDir(draft.readingHistoryDir)}
                  onReset={() => patch({ readingHistoryDir: defaults.readingHistory })}
                />
                <PathCard
                  icon="local_library"
                  title="本地书库"
                  desc="导入时把书复制到这里的文件夹，原文件移动、改名、删除都不影响阅读；也方便整库备份。"
                  value={draft.libraryDir}
                  placeholder={defaults.library}
                  onChange={(value) => patch({ libraryDir: value })}
                  onChoose={() => void chooseDir('libraryDir', '选择本地书库文件夹')}
                  onOpen={() => void revealDir(draft.libraryDir)}
                  onReset={() => patch({ libraryDir: defaults.library })}
                />
                <PathCard
                  icon="workspace_premium"
                  title="最终成品"
                  desc="转换、导出 EPUB 的默认保存位置；导出时仍可在保存对话框里另存到任意磁盘位置。"
                  value={draft.finalExportDir}
                  placeholder={defaults.finalExport}
                  onChange={(value) => patch({ finalExportDir: value })}
                  onChoose={() => void chooseDir('finalExportDir', '选择最终成品文件夹')}
                  onOpen={() => void revealDir(draft.finalExportDir)}
                  onReset={() => patch({ finalExportDir: defaults.finalExport })}
                />
              </div>

              <div className="library-check">
                <div className="library-check__head">
                  <span className="library-check__icon"><Icon name="fact_check" size={18} /></span>
                  <div className="library-check__text">
                    <span className="library-check__title">书库索引自检</span>
                    <small>
                      书籍目录已按「书名__短编号」命名；索引缺失或损坏会自动重建，不阻塞阅读。
                      检查会核对正文是否缺失、目录是否未登记、编号是否重复。
                    </small>
                  </div>
                  <button className="btn" disabled={checkingLibrary} onClick={() => void checkLibrary()}>
                    <Icon name={checkingLibrary ? 'hourglass_top' : 'fact_check'} size={16} />
                    {checkingLibrary ? '检查中…' : '检查书库'}
                  </button>
                </div>
                {libraryReport && (
                  <div className="library-check__body">
                    <div className="library-check__stats">
                      <span>目录 {libraryReport.scanned}</span>
                      <span>索引 {libraryReport.books}</span>
                      {libraryReport.renamed > 0 && <span>本次整理 {libraryReport.renamed}</span>}
                      {libraryReport.sidecarsMoved > 0 && (
                        <span>迁入阅读壳 {libraryReport.sidecarsMoved}</span>
                      )}
                    </div>
                    {(
                      [
                        ['正文缺失', libraryReport.missingDirs],
                        ['目录未登记', libraryReport.unregistered],
                        ['编号重复', libraryReport.duplicates],
                        ['正文已变动', libraryReport.changedSources],
                        ['旧式目录', libraryReport.legacyDirs],
                        ['旧壳文件未迁入', libraryReport.legacySidecars],
                        ['未识别的壳文件', libraryReport.unknownSidecars],
                      ] as const
                    ).map(([label, items]) =>
                      items.length > 0 && (
                        <div className="library-check__row" key={label}>
                          <span>{label}</span>
                          <em>
                            {items.slice(0, 6).join('、')}
                            {items.length > 6 ? ` 等 ${items.length} 本` : ''}
                          </em>
                        </div>
                      ),
                    )}
                    {libraryReport.missingDirs.length === 0 &&
                      libraryReport.unregistered.length === 0 &&
                      libraryReport.duplicates.length === 0 &&
                      libraryReport.changedSources.length === 0 &&
                      libraryReport.legacyDirs.length === 0 &&
                      libraryReport.legacySidecars.length === 0 &&
                      libraryReport.unknownSidecars.length === 0 && (
                        <div className="library-check__ok">
                          <Icon name="check_circle" size={15} />索引与目录一致
                        </div>
                      )}
                  </div>
                )}
              </div>

              <h3>阅读数据存在哪</h3>
              <p className="settings-hint">
                高亮、笔记、划词译文都写在书目录内的 <strong>阅读壳/</strong>，与母本同层；
                文件名固定，不随书名变化。复制或搬走整个书目录，阅读数据就跟着书一起走。
                <br />
                <code>&lt;书名&gt;__&lt;短编号&gt;/</code>：<code>source.epub</code>（母本）+
                <code>阅读壳/manifest.json</code>（母本指纹）、
                <code>阅读壳/annotations.json</code>（高亮与笔记）、
                <code>阅读壳/translate-drafts.json</code>（划词译文）。
                <br />
                清浏览器缓存不会丢标注；锻造译文仍在书目录根的 <code>forge-draft.json</code>，导出只读不写回。
              </p>

              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={draft.keepOriginal}
                  onChange={(event) => patch({ keepOriginal: event.target.checked })}
                />
                <span>
                  导入时建立书库链接（无痕模式）
                  <small>不复制副本到本地书库，只在阅读历史里记录原文件路径；原文件移动或删除后会提示找不到。</small>
                </span>
              </label>
            </>
          )}

          {section === 'import' && (
            <>
              <h2>导入偏好</h2>
              <p className="settings-hint">决定导入弹窗默认接受哪些格式与文件。</p>

              <div className="settings-field">
                <span>支持的格式</span>
                <div className="chip-row">
                  {ALL_FORMATS.map((item) => (
                    <button
                      key={item.ext}
                      className={`chip ${draft.importFormats.includes(item.ext) ? 'on' : ''}`}
                      onClick={() => toggleFormat(item.ext)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="settings-hint">
                勾选后才会出现在导入对话框里：EPUB / MOBI / AZW3 / FB2 / CBZ / PDF 直接阅读，
                TXT / Markdown / HTML 走文本排版；可转换的来源还会出现在「转换为 EPUB」向导里。
              </p>

              <label className="settings-field">
                <span>忽略小于（KB）</span>
                <input
                  type="number"
                  min={0}
                  max={20480}
                  value={Math.round(draft.minBytes / 1024)}
                  onChange={(event) =>
                    patch({ minBytes: Math.max(0, Number(event.target.value) || 0) * 1024 })
                  }
                />
              </label>
              <p className="settings-hint">用于文件夹扫描时过滤封面图、说明文件等小文件。</p>

              <label className="settings-switch">
                <input
                  type="checkbox"
                  checked={draft.folderGroup}
                  onChange={(event) => patch({ folderGroup: event.target.checked })}
                />
                <span>
                  按子文件夹建立分组
                  <small>导入整个文件夹时，把子文件夹名记为书的分组，方便以后按系列浏览。</small>
                </span>
              </label>
            </>
          )}

          {(['reading', 'editing', 'forge', 'translate', 'general'] as const).map((group) =>
            section === group ? (
              <FeatureSection
                key={group}
                group={group}
                prefs={draftPrefs}
                query={query}
                onChange={patchPrefs}
                onAction={handleAction}
                model={group === 'translate' ? model : undefined}
                download={group === 'translate' ? download : undefined}
              />
            ) : null,
          )}

          {section === 'shortcuts' && (
            <>
              <h2>快捷键</h2>
              <p className="settings-hint">
                与说明书（F1）同源，按使用场景分组；通用键在任何页面都成立。Ctrl + Z 是通用撤销，只在编辑段落与译文框里生效。
              </p>
              {SCOPE_ORDER.map((scope) => {
                const rows = SHORTCUTS.filter((item) => item.scope === scope)
                if (!rows.length) return null
                return (
                  <div className="settings-shortcut-group" key={scope}>
                    <h3>{SHORTCUT_SCOPE_LABEL[scope]}</h3>
                    <table className="shortcut-table">
                      <tbody>
                        {rows.map((item) => (
                          <tr key={`${scope}-${item.keys}-${item.label}`}>
                            <td><kbd>{item.keys}</kbd></td>
                            <td>{item.label}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })}
            </>
          )}

          {section === 'about' && (
            <>
              <h2>关于 Scrollforge</h2>
              <p className="settings-hint">
                本地电子书阅读器。EPUB / MOBI / AZW / AZW3 / FB2 / CBZ / PDF 直接按原书排版渲染；
                TXT / Markdown / HTML 归一化成文本排版。转换以 EPUB 为中枢，笔记、进度、书架都保存在本机。
              </p>
              <dl className="about-list">
                <dt>版本</dt><dd>{version || '读取中…'}</dd>
                <dt>直接阅读</dt>
                <dd>{FORMATS.filter((item) => item.direct).map((item) => item.label).join(' · ')}</dd>
                <dt>文本排版</dt>
                <dd>{FORMATS.filter((item) => item.text).map((item) => item.label).join(' · ')}</dd>
                <dt>转换为 EPUB</dt>
                <dd>{FORMATS.filter((item) => item.toEpub).map((item) => item.label).join(' · ')}（PDF 仅文字层）</dd>
                <dt>从 EPUB 导出</dt><dd>TXT · Markdown · HTML</dd>
                <dt>可编辑</dt><dd>EPUB（其它格式请先转成 EPUB 工作副本）</dd>
                <dt>需外部工具</dt><dd>EPUB → PDF / MOBI / AZW3 暂不内置，可用本机 Calibre 转换</dd>
                <dt>阅读历史</dt><dd>{draft.readingHistoryDir}</dd>
                <dt>本地书库</dt><dd>{draft.libraryDir}</dd>
                <dt>最终成品</dt><dd>{draft.finalExportDir}</dd>
              </dl>
              <p className="settings-hint">
                快捷键与全部功能的详细说明已独立成「帮助说明书」，可从书架左下角菜单或按 F1 打开。
              </p>
            </>
          )}

          <div className="settings-actions">
            <button className="btn" aria-label="取消设置" onClick={onClose} disabled={saving}>
              <Icon name="close" size={16} />
              取消
            </button>
            <button
              className="btn primary"
              aria-label="保存设置"
              onClick={() => void save()}
              disabled={saving}
            >
              <Icon name={saving ? 'hourglass_top' : 'check'} size={16} />
              {saving ? '正在保存…' : '保存设置'}
            </button>
          </div>
        </section>
      </div>
    </div>
      {glossaryOpen && (
        <GlossaryDialog
          onClose={() => setGlossaryOpen(false)}
          onNotify={onNotify}
        />
      )}
    </>
  )
}
