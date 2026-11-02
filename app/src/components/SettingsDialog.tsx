import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getVersion } from '@tauri-apps/api/app'
import { open } from '@tauri-apps/plugin-dialog'
import Icon from './Icon'
import GlossaryDialog from './GlossaryDialog'
import { FORMATS } from '../lib/formats'
import { FEATURES, STATUS_LABEL, type SettingMeta } from '../lib/features'
import { probeEngine, translateConfigFromPrefs } from '../lib/translate'
import type { Prefs } from '../lib/prefs'
import type { AppSettings } from '../types'

/** 与 Rust 端 default_dirs 保持一致，仅作为接口失败时的兜底 */
const FALLBACK_DIRS = {
  library: 'D:\\AI Coding Project Management\\Scrollforge\\local book repository',
  readingHistory: 'D:\\AI Coding Project Management\\Scrollforge\\reading history',
  finalExport: 'D:\\AI Coding Project Management\\Scrollforge\\final export',
}

/** 可拖动/缩放设置窗口的持久化键（存位置和尺寸） */
const POS_KEY = 'scrollforge:settings-window-pos'
const SIZE_KEY = 'scrollforge:settings-window-size'
const MIN_W = 640
const MIN_H = 420
const MAX_W = 1600
const MAX_H = 1100

const ALL_FORMATS: { ext: string; label: string }[] = FORMATS.map((item) => ({
  ext: item.ext,
  label: item.label,
}))

type Props = {
  settings: AppSettings
  prefs: Prefs
  onClose: () => void
  onSave: (settings: AppSettings, prefs: Prefs) => Promise<void>
  onNotify: (message: string) => void
  onHelp: () => void
}

type Section = 'storage' | 'import' | 'features' | 'about'

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
  onAction: (action: 'storage' | 'glossary' | 'translateTest') => void
}

const ACTION_LABEL: Record<'storage' | 'glossary' | 'translateTest', { icon: string; text: string }> = {
  storage: { icon: 'folder_open', text: '去设置文件夹' },
  glossary: { icon: 'translate', text: '打开术语表' },
  translateTest: { icon: 'network_check', text: '测试连接' },
}

/** 功能注册表里的一个设置项：开关 / 下拉 / 数字 / 文本 / 说明 */
function SettingRow({ setting, prefs, onChange, onAction }: SettingRowProps) {
  if (setting.kind === 'note') {
    return (
      <div className="feature-setting feature-setting__note">
        <span className="feature-setting__label">{setting.label}</span>
        <small>{setting.hint}</small>
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

export default function SettingsDialog({ settings, prefs, onClose, onSave, onNotify, onHelp }: Props) {
  const [section, setSection] = useState<Section>('storage')
  const [draft, setDraft] = useState<AppSettings>({ ...settings })
  const [draftPrefs, setDraftPrefs] = useState<Prefs>({ ...prefs })
  const [saving, setSaving] = useState(false)
  const [defaults, setDefaults] = useState(FALLBACK_DIRS)
  // 版本号单一来源：tauri.conf.json → getVersion()；不写死兜底值
  const [version, setVersion] = useState('')
  const [glossaryOpen, setGlossaryOpen] = useState(false)
  const [testing, setTesting] = useState(false)

  // ── 设置窗口拖动 / 缩放状态 ──
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    try {
      const raw = localStorage.getItem(POS_KEY)
      if (raw) return JSON.parse(raw)
    } catch { /* ignore */ }
    return { x: Math.max(24, (window.innerWidth - 840) / 2), y: Math.max(24, (window.innerHeight - 660) / 2) }
  })
  const [size, setSize] = useState<{ w: number; h: number }>(() => {
    try {
      const raw = localStorage.getItem(SIZE_KEY)
      if (raw) {
        const { w, h } = JSON.parse(raw)
        if (Number.isFinite(w) && Number.isFinite(h)) return { w: Math.min(MAX_W, Math.max(MIN_W, w)), h: Math.min(MAX_H, Math.max(MIN_H, h)) }
      }
    } catch { /* ignore */ }
    return { w: 840, h: 660 }
  })
  const posRef = useRef(pos)
  const sizeRef = useRef(size)
  const dragOffsetRef = useRef<{ dx: number; dy: number } | null>(null)
  const resizeStartRef = useRef<{ w: number; h: number; px: number; py: number } | null>(null)
  posRef.current = pos
  sizeRef.current = size

  // Esc 关闭（保持和说明书一致：Esc 关闭弹层）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!saving) onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, saving])

  // 拖动 / 缩放的全局 pointermove / pointerup 监听（挂 window，确保拖出元素仍能收到）
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (dragOffsetRef.current) {
        const newX = posRef.current.x + (e.clientX - dragOffsetRef.current.dx)
        const newY = posRef.current.y + (e.clientY - dragOffsetRef.current.dy)
        const clampedX = Math.max(-posRef.current.x + 40, Math.min(window.innerWidth - 60, newX))
        const clampedY = Math.max(-posRef.current.y + 40, Math.min(window.innerHeight - 60, newY))
        setPos({ x: clampedX, y: clampedY })
        return
      }
      if (resizeStartRef.current) {
        const s = resizeStartRef.current
        const nw = Math.min(MAX_W, Math.max(MIN_W, s.w + (e.clientX - s.px)))
        const nh = Math.min(MAX_H, Math.max(MIN_H, s.h + (e.clientY - s.py)))
        if (nw !== s.w || nh !== s.h) setSize({ w: nw, h: nh })
      }
    }
    const onUp = () => {
      if (dragOffsetRef.current) {
        dragOffsetRef.current = null
        try { localStorage.setItem(POS_KEY, JSON.stringify(posRef.current)) } catch { /* ignore */ }
      }
      if (resizeStartRef.current) {
        resizeStartRef.current = null
        try { localStorage.setItem(SIZE_KEY, JSON.stringify(sizeRef.current)) } catch { /* ignore */ }
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  const startDrag = useCallback((e: ReactPointerEvent) => {
    dragOffsetRef.current = { dx: e.clientX - posRef.current.x, dy: e.clientY - posRef.current.y }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }, [])

  const startResize = useCallback((e: ReactPointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    resizeStartRef.current = { w: sizeRef.current.w, h: sizeRef.current.h, px: e.clientX, py: e.clientY }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }, [])

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
      onNotify(`翻译引擎连接正常（${result.engine === 'online' ? '在线' : '本地'} · ${result.ms} ms）`)
    } catch (err) {
      onNotify(`翻译引擎连接失败：${String(err)}`)
    } finally {
      setTesting(false)
    }
  }

  const handleAction = (action: 'storage' | 'glossary' | 'translateTest') => {
    if (action === 'storage') setSection('storage')
    else if (action === 'glossary') setGlossaryOpen(true)
    else void testTranslate()
  }

  return (
    <>
    <div className="modal-mask" role="dialog" aria-label="设置">
      <div
        className="settings-float"
        style={{
          transform: `translate(${pos.x}px, ${pos.y}px)`,
          width: size.w,
          height: size.h,
        }}
      >
        <div
          className="modal-titlebar"
          onPointerDown={startDrag}
        >
          <div className="modal-titlebar__brand">
            <Icon name="settings" size={16} />
            <span>设置</span>
          </div>
          <button
            className="modal-titlebar__close"
            aria-label="关闭设置（Esc）"
            onClick={onClose}
            disabled={saving}
            title="关闭设置（Esc）"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

      <div className="settings-modal">
        <aside className="settings-nav">
          <div className="settings-brand">
            <Icon name="settings" size={20} />
            <span>设置</span>
          </div>
          <button className={section === 'storage' ? 'on' : ''} onClick={() => setSection('storage')}>
            <Icon name="inventory_2" size={17} />
            <span>文件夹与书库</span>
          </button>
          <button className={section === 'import' ? 'on' : ''} onClick={() => setSection('import')}>
            <Icon name="file_open" size={17} />
            <span>导入</span>
          </button>
          <button className={section === 'features' ? 'on' : ''} onClick={() => setSection('features')}>
            <Icon name="widgets" size={17} />
            <span>功能</span>
          </button>
          <button className={section === 'about' ? 'on' : ''} onClick={() => setSection('about')}>
            <Icon name="info" size={17} />
            <span>关于</span>
          </button>
          <button className="settings-nav__help" onClick={onHelp}>
            <Icon name="menu_book" size={17} />
            <span>说明书（F1）</span>
          </button>
        </aside>

        <section className="settings-main">
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

          {section === 'features' && (
            <>
              <h2>功能与设置</h2>
              <p className="settings-hint">
                下面每一项都来自同一份功能注册表，F1 说明书也由它生成。
                「已上线」功能至少有一个可调项；「实验中」可以随时关闭；「规划中」只做入口占位。
              </p>

              <div className="feature-list">
                {FEATURES.map((feature) => (
                  <div
                    key={feature.id}
                    className={`feature-card ${feature.status === 'planned' ? 'feature-card--planned' : ''}`}
                  >
                    <span className="feature-icon"><Icon name={feature.icon} size={20} /></span>
                    <div className="feature-text">
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
                      <span className="feature-desc">{feature.desc}</span>
                      <span className="feature-where">{feature.where}</span>
                      <div className="feature-settings">
                        {feature.settings.map((setting) => (
                          <SettingRow
                            key={setting.label}
                            setting={setting}
                            prefs={draftPrefs}
                            onChange={patchPrefs}
                            onAction={handleAction}
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
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
              <button className="btn about-help" onClick={onHelp}>
                <Icon name="menu_book" size={16} />打开说明书（F1）
              </button>
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
        <div
          className="resize-handle"
          aria-label="拖动右下角调整大小"
          title="拖动右下角调整大小"
          onPointerDown={startResize}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1 11 L11 1 M5 11 L11 5 M9 11 L11 9" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
          </svg>
        </div>
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
