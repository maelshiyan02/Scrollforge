import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import Icon from './Icon'
import {
  KIND_LABEL,
  TERM_KINDS,
  mergeGlossary,
  newEntryId,
  parseGlossary,
  parseGlossaryCsv,
  serializeGlossary,
  simplifyEntries,
  toGlossaryCsv,
  toSimplifiedZh,
  type GlossaryEntry,
  type TermKind,
} from '../lib/glossary'

type Props = {
  onClose: () => void
  onNotify: (message: string) => void
}

type Filter = 'all' | TermKind

export default function GlossaryDialog({ onClose, onNotify }: Props) {
  const [entries, setEntries] = useState<GlossaryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [exportText, setExportText] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const raw = await invoke<string>('read_glossary')
        setEntries(parseGlossary(raw))
      } catch (err) {
        onNotify(`读取术语表失败：${String(err)}`)
      } finally {
        setLoading(false)
      }
    })()
  }, [onNotify])

  // Esc 关闭：输入框内不抢
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const counts = useMemo(() => {
    const base: Record<Filter, number> = { all: entries.length, person: 0, place: 0, org: 0, term: 0 }
    for (const entry of entries) base[entry.kind] += 1
    return base
  }, [entries])

  const visible = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return entries.filter((entry) => {
      if (filter !== 'all' && entry.kind !== filter) return false
      if (!keyword) return true
      return (
        entry.source.toLowerCase().includes(keyword)
        || entry.target.toLowerCase().includes(keyword)
        || (entry.note ?? '').toLowerCase().includes(keyword)
      )
    })
  }, [entries, filter, search])

  const patchEntry = (id: string, patch: Partial<GlossaryEntry>) => {
    setEntries((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)))
    setDirty(true)
  }

  const addEntry = () => {
    setEntries((prev) => [
      { id: newEntryId(), source: '', target: '', kind: filter === 'all' ? 'term' : filter, note: '' },
      ...prev,
    ])
    setDirty(true)
  }

  const removeEntry = (id: string) => {
    setEntries((prev) => prev.filter((entry) => entry.id !== id))
    setDirty(true)
  }

  const normalizeAll = () => {
    setEntries((prev) => simplifyEntries(prev))
    setDirty(true)
    onNotify('已把全部译名转为简体')
  }

  const persist = async () => {
    if (saving) return
    const cleaned = entries
      .map((entry) => ({
        ...entry,
        source: entry.source.replace(/\s+/g, ' ').trim(),
        target: toSimplifiedZh(entry.target).replace(/\s+/g, ' ').trim(),
        note: (entry.note ?? '').trim() || undefined,
      }))
      .filter((entry) => entry.source && entry.target)
    setSaving(true)
    try {
      await invoke('write_glossary', { json: serializeGlossary(cleaned) })
      setEntries(cleaned)
      setDirty(false)
      onNotify(`术语表已保存：${cleaned.length} 条`)
    } catch (err) {
      onNotify(`保存术语表失败：${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const applyImport = (text: string, label: string) => {
    const trimmed = text.trim()
    if (!trimmed) {
      onNotify('没有可导入的内容')
      return
    }
    const incoming = trimmed.startsWith('{') || trimmed.startsWith('[')
      ? parseGlossary(trimmed)
      : parseGlossaryCsv(trimmed)
    if (incoming.length === 0) {
      onNotify('没有解析到有效条目：请用 source,target,kind,note 或 JSON')
      return
    }
    setEntries((prev) => mergeGlossary(prev, incoming))
    setDirty(true)
    setImportOpen(false)
    setImportText('')
    onNotify(`${label}：导入 ${incoming.length} 条（同原文已覆盖译名）`)
  }

  const importFile = async () => {
    try {
      const picked = await open({
        multiple: false,
        title: '导入术语表',
        filters: [{ name: '术语表', extensions: ['csv', 'tsv', 'json', 'txt'] }],
      })
      if (!picked || Array.isArray(picked)) return
      const text = await invoke<string>('read_text_file', { path: picked })
      applyImport(text, '文件导入')
    } catch (err) {
      onNotify(`导入失败：${String(err)}`)
    }
  }

  const buildExport = () => {
    const csv = toGlossaryCsv(entries)
    setExportText(csv)
    return csv
  }

  const exportFile = async () => {
    try {
      const target = await save({
        title: '导出术语表',
        defaultPath: 'glossary.csv',
        filters: [{ name: 'CSV', extensions: ['csv'] }, { name: 'JSON', extensions: ['json'] }],
      })
      if (!target) return
      const content = target.toLowerCase().endsWith('.json') ? serializeGlossary(entries) : toGlossaryCsv(entries)
      await invoke('write_text_file', { path: target, content })
      onNotify(`已导出 ${entries.length} 条到 ${target}`)
    } catch (err) {
      onNotify(`导出失败：${String(err)}`)
    }
  }

  const copyExport = async () => {
    const csv = buildExport()
    try {
      await navigator.clipboard.writeText(csv)
      onNotify('已复制 CSV 到剪贴板')
    } catch {
      onNotify('复制失败，请在下方文本框里手动全选复制')
    }
  }

  return (
    <div className="modal-mask" onClick={() => !saving && onClose()}>
      <div className="glossary-modal" onClick={(event) => event.stopPropagation()}>
        <header className="glossary-head">
          <span className="glossary-head__icon"><Icon name="translate" size={20} /></span>
          <div>
            <h2>术语表 · 人名地名组织名</h2>
            <p>专名在翻译前锁定为占位符，译后还原成这里的简体译名；跨书共用。</p>
          </div>
          <span className="grow" />
          {dirty && <em className="glossary-dirty">未保存</em>}
          <button className="btn small icon-only" data-tip="关闭（Esc）" aria-label="关闭术语表" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="glossary-toolbar">
          <input
            className="glossary-search"
            value={search}
            placeholder="搜索原文 / 译名 / 备注"
            spellCheck={false}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="glossary-chips">
            {(['all', ...TERM_KINDS.map((item) => item.value)] as Filter[]).map((item) => (
              <button
                key={item}
                className={`chip ${filter === item ? 'on' : ''}`}
                onClick={() => setFilter(item)}
              >
                {item === 'all' ? '全部' : KIND_LABEL[item]} {counts[item]}
              </button>
            ))}
          </div>
          <span className="grow" />
          <button className="btn small" onClick={addEntry}>
            <Icon name="add" size={15} />新增一行
          </button>
          <button className="btn small" onClick={normalizeAll}>
            <Icon name="chinese_simplified" size={15} />全部转简体
          </button>
          <button className="btn small" onClick={() => setImportOpen((value) => !value)}>
            <Icon name="upload" size={15} />导入
          </button>
          <button className="btn small" onClick={() => void exportFile()}>
            <Icon name="download" size={15} />导出文件
          </button>
          <button className="btn primary small" onClick={() => void persist()} disabled={saving}>
            <Icon name={saving ? 'hourglass_top' : 'save'} size={15} />{saving ? '保存中…' : '保存术语表'}
          </button>
        </div>

        {importOpen && (
          <div className="glossary-import">
            <div className="glossary-import__head">
              <b>粘贴导入</b>
              <small>支持 CSV（source,target,kind,note）或 JSON；同原文会覆盖译名。</small>
              <span className="grow" />
              <button className="btn small" onClick={() => void importFile()}>
                <Icon name="folder_open" size={15} />选择文件
              </button>
            </div>
            <textarea
              rows={5}
              value={importText}
              spellCheck={false}
              placeholder={'서울,首尔,place,首都\n장민수,张民秀,person,主角\n...'}
              onChange={(event) => setImportText(event.target.value)}
            />
            <div className="glossary-import__actions">
              <button className="btn small" onClick={() => { setImportOpen(false); setImportText('') }}>取消</button>
              <button className="btn primary small" onClick={() => applyImport(importText, '粘贴导入')}>
                合并导入
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="glossary-empty">正在读取术语表…</div>
        ) : entries.length === 0 ? (
          <div className="glossary-empty">
            还没有术语条目。点「新增一行」，或用 CSV / JSON 导入；导出后可交给他人复用。
          </div>
        ) : (
          <div className="glossary-table-wrap">
            <table className="glossary-table">
              <thead>
                <tr>
                  <th>原文</th>
                  <th>简体译名</th>
                  <th>类型</th>
                  <th>备注</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <input
                        value={entry.source}
                        spellCheck={false}
                        placeholder="原文写法"
                        onChange={(event) => patchEntry(entry.id, { source: event.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        value={entry.target}
                        spellCheck={false}
                        placeholder="简体译名"
                        onChange={(event) => patchEntry(entry.id, { target: event.target.value })}
                        onBlur={(event) => {
                          const next = toSimplifiedZh(event.target.value)
                          if (next !== entry.target) patchEntry(entry.id, { target: next })
                        }}
                      />
                    </td>
                    <td>
                      <select
                        value={entry.kind}
                        onChange={(event) => patchEntry(entry.id, { kind: event.target.value as TermKind })}
                      >
                        {TERM_KINDS.map((item) => (
                          <option key={item.value} value={item.value}>{item.label}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        value={entry.note ?? ''}
                        spellCheck={false}
                        placeholder="可选"
                        onChange={(event) => patchEntry(entry.id, { note: event.target.value })}
                      />
                    </td>
                    <td>
                      <button
                        className="btn small icon-only tip-top"
                        data-tip="删除这一条"
                        aria-label="删除术语"
                        onClick={() => removeEntry(entry.id)}
                      >
                        <Icon name="delete" size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length === 0 && <div className="glossary-empty">没有匹配的条目</div>}
          </div>
        )}

        <footer className="glossary-foot">
          <button className="btn small" onClick={() => void copyExport()}>
            <Icon name="content_copy" size={15} />复制 CSV
          </button>
          <span className="glossary-count">
            共 {entries.length} 条 · 人名 {counts.person} · 地名 {counts.place} · 组织 {counts.org} · 术语 {counts.term}
          </span>
          <span className="grow" />
          <button className="btn small" onClick={() => setExportText(buildExport())}>
            <Icon name="preview" size={15} />预览导出
          </button>
        </footer>

        {exportText && (
          <textarea
            className="glossary-export"
            rows={5}
            readOnly
            value={exportText}
            spellCheck={false}
            onFocus={(event) => event.target.select()}
          />
        )}
      </div>
    </div>
  )
}
