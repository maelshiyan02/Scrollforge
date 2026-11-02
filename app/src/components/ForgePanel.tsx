import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { decodeText } from '../lib/encoding'
import {
  applyRewrites,
  diffLines,
  editKey,
  formatBytes,
  formatTime,
  hasEdit,
  normalizeRewrite,
  parseForgeState,
  serializeForgeState,
  type DiffResult,
  type ForgeEdit,
  type ForgeEdits,
  type RevisionMeta,
} from '../lib/forge'
import type { TxtAnalysis } from '../lib/txt-chapters'
import { sanitizeInline } from '../lib/inline-format'
import { parseGlossary, type GlossaryEntry } from '../lib/glossary'
import {
  MODE_LABEL,
  STYLE_LABEL,
  detectLanguage,
  glossaryHits,
  memoryCount,
  pairLabel,
  parseMemory,
  rememberTranslation,
  serializeMemory,
  translateConfigFromPrefs,
  translateOne,
  type TranslateOutcome,
  type TranslationMemoryState,
} from '../lib/translate'
import type { Prefs } from '../lib/prefs'
import Icon from './Icon'

type Props = {
  bookId: string
  bookTitle: string
  rawText: string
  analysis: TxtAnalysis
  prefs: Prefs
  /** 当前阅读到的章节标题，用于默认定位 */
  currentChapter: string
  onClose: () => void
  onNotify: (message: string) => void
  /** 写回/回滚后通知阅读页重新载入 */
  onCommitted: () => void
  // ─── S6：EPUB 源即时写回（ForgePanel 翻译结果直接写回 working.epub） ───
  /** ForgePanel EPUB 编辑解压目录（edit_write_blocks 写这里） */
  epubEditDir?: string
  /** ForgePanel 段落序号 → EPUB rel_path + block_index 映射 */
  epubFlatBlocks?: { chapterIndex: number; paragraphIndex: number; relPath: string; blockIndex: number; text: string }[]
  /** EPUB 重打包输出路径（edit_save 的 outputPath，通常是 source.meta.path 或 working.epub） */
  epubOutputPath?: string
}

type DiffState = {
  title: string
  result: DiffResult
}

function chapterLabel(analysis: TxtAnalysis, index: number): string {
  const chapter = analysis.chapters[index]
  const title = chapter?.title?.trim()
  return title || `正文 ${index + 1}`
}

function paragraphLabel(analysis: TxtAnalysis, chapterIndex: number, paragraphIndex: number): string {
  const chapter = analysis.chapters[chapterIndex]
  const text = chapter?.paragraphs[paragraphIndex] ?? ''
  return `第 ${paragraphIndex + 1} 段 · ${text.length} 字`
}

function sameEdit(a: ForgeEdit | undefined, b: ForgeEdit | undefined): boolean {
  return (a?.rewrite ?? '') === (b?.rewrite ?? '')
    && (a?.translate ?? '') === (b?.translate ?? '')
    && (a?.note ?? '') === (b?.note ?? '')
}

export default function ForgePanel({
  bookId,
  bookTitle,
  rawText,
  analysis,
  prefs,
  currentChapter,
  onClose,
  onNotify,
  onCommitted,
  epubEditDir,
  epubFlatBlocks,
  epubOutputPath,
}: Props) {
  const [edits, setEdits] = useState<ForgeEdits>({})
  const [draft, setDraft] = useState<ForgeEdits>({})
  const [chapterIndex, setChapterIndex] = useState(0)
  const [paragraphIndex, setParagraphIndex] = useState(0)
  const [revisions, setRevisions] = useState<RevisionMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [diff, setDiff] = useState<DiffState | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [pendingRollback, setPendingRollback] = useState<RevisionMeta | null>(null)
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([])
  const [memory, setMemory] = useState<TranslationMemoryState>({ version: 1, entries: {} })
  const [translating, setTranslating] = useState(false)
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const [lastOutcome, setLastOutcome] = useState<TranslateOutcome | null>(null)
  const locatedRef = useRef(false)
  const memoryRef = useRef(memory)
  const cancelRef = useRef(false)

  useEffect(() => {
    memoryRef.current = memory
  }, [memory])

  useEffect(() => {
    void (async () => {
      try {
        const [rawGlossary, rawMemory] = await Promise.all([
          invoke<string>('read_glossary'),
          invoke<string>('read_translation_memory'),
        ])
        setGlossary(parseGlossary(rawGlossary))
        const parsed = parseMemory(rawMemory)
        setMemory(parsed)
        memoryRef.current = parsed
      } catch (err) {
        console.warn(err)
      }
    })()
  }, [])

  const loadState = useCallback(async () => {
    const raw = await invoke<string>('read_forge_state', { id: bookId })
    const parsed = parseForgeState(raw)
    setEdits(parsed)
    setDraft(parsed)
  }, [bookId])

  const loadRevisions = useCallback(async () => {
    const list = await invoke<RevisionMeta[]>('list_revisions', { id: bookId })
    setRevisions(Array.isArray(list) ? list : [])
  }, [bookId])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await Promise.all([loadState(), loadRevisions()])
      } catch (err) {
        console.warn(err)
        if (!cancelled) onNotify('读取锻造记录失败')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [loadState, loadRevisions, onNotify])

  // 默认定位到当前阅读章节（只在首次拿到数据时执行，保存后刷新不重置）
  useEffect(() => {
    if (locatedRef.current || !analysis.chapters.length) return
    locatedRef.current = true
    const target = analysis.chapters.findIndex((chapter) => chapter.title?.trim() === currentChapter.trim())
    if (target > 0) {
      setChapterIndex(target)
      setParagraphIndex(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis])

  const dirtyKeys = useMemo(() => {
    const keys = new Set([...Object.keys(draft), ...Object.keys(edits)])
    return [...keys].filter((key) => !sameEdit(draft[key], edits[key]))
  }, [draft, edits])
  const dirty = dirtyKeys.length

  const chapter = analysis.chapters[chapterIndex]
  const paragraphs = chapter?.paragraphs ?? []
  const original = paragraphs[paragraphIndex] ?? ''
  const key = editKey(chapterIndex, paragraphIndex)
  const current = draft[key] ?? {}
  const stored = edits[key]

  const setField = (field: 'rewrite' | 'translate' | 'note', value: string) => {
    const next: ForgeEdit = { ...(draft[key] ?? {}), [field]: value }
    setDraft((prev) => {
      const copy = { ...prev }
      if (!hasEdit(next)) delete copy[key]
      else copy[key] = next
      return copy
    })
  }

  const clearRewrite = () => {
    const next = { ...(draft[key] ?? {}) }
    delete next.rewrite
    setDraft((prev) => {
      const copy = { ...prev }
      if (!hasEdit(next)) delete copy[key]
      else copy[key] = next
      return copy
    })
  }

  const config = useMemo(() => translateConfigFromPrefs(prefs), [prefs])
  const lang = original ? detectLanguage(original) : 'unknown'
  const currentHits = useMemo(
    () => (original ? glossaryHits(original, glossary) : []),
    [original, glossary],
  )

  const applyTranslation = (chapterNo: number, index: number, text: string) => {
    const targetKey = editKey(chapterNo, index)
    setDraft((prev) => ({
      ...prev,
      [targetKey]: { ...(prev[targetKey] ?? {}), translate: text },
    }))
  }

  const engineLabel = (outcome: TranslateOutcome) =>
    outcome.engine === 'memory' ? '翻译记忆' : outcome.engine === 'online' ? '在线引擎' : '本地引擎'

  const translateCurrent = async () => {
    if (translating || !original.trim()) return
    setTranslating(true)
    setLastOutcome(null)
    try {
      const outcome = await translateOne({
        config,
        source: original,
        glossary,
        memory: memoryRef.current,
      })
      applyTranslation(chapterIndex, paragraphIndex, outcome.text)
      setLastOutcome(outcome)
      // ─── S6：EPUB 源即时写回（跳过 forge.json → commit_forge 链路） ───
      if (epubEditDir && epubFlatBlocks && epubOutputPath) {
        try {
          const flat = epubFlatBlocks.find(
            (f) => f.chapterIndex === chapterIndex && f.paragraphIndex === paragraphIndex,
          )
          if (flat) {
            const sanitized = sanitizeInline(outcome.text)
            await invoke('edit_write_blocks', {
              editDir: epubEditDir,
              relPath: flat.relPath,
              edits: [{ index: flat.blockIndex, inner: sanitized.xml }],
            })
            await invoke('edit_save', {
              editDir: epubEditDir,
              outputPath: epubOutputPath,
              createRevision: false,
            })
          }
        } catch (epubErr) {
          onNotify(`EPUB 写回失败：${String(epubErr)}（译文已存锻造记录，请检查后手动应用）`)
        }
      }
      const notes = [
        `${engineLabel(outcome)} · ${Math.round(outcome.elapsedMs)} ms`,
        outcome.hits.length ? `术语命中 ${outcome.hits.length}` : '',
        outcome.warning ?? '',
      ].filter(Boolean)
      onNotify(`已翻译本段（${notes.join(' · ')}）`)
      // EPUB 源时通知阅读器 reload
      if (epubEditDir) onCommitted?.()
    } catch (err) {
      onNotify(`翻译失败：${String(err)}`)
    } finally {
      setTranslating(false)
    }
  }

  const translateChapter = async () => {
    if (translating) return
    const chapterNo = chapterIndex
    const targets: number[] = []
    paragraphs.forEach((text, index) => {
      if (!text.trim()) return
      if (draft[editKey(chapterNo, index)]?.translate?.trim()) return
      targets.push(index)
    })
    if (targets.length === 0) {
      onNotify('本章没有待翻译段落；已有译文的段落会保留')
      return
    }
    setTranslating(true)
    cancelRef.current = false
    setBatch({ done: 0, total: targets.length })
    let done = 0
    let failed = 0
    let fellBack = 0
    // ─── S6：EPUB 源批量写回（按 relPath 聚合 BlockEdit） ───
    const epubEditsByRelPath = new Map<string, { index: number; inner: string }[]>()
    try {
      for (const index of targets) {
        if (cancelRef.current) break
        const source = paragraphs[index] ?? ''
        try {
          const outcome = await translateOne({
            config,
            source,
            glossary,
            memory: memoryRef.current,
          })
          applyTranslation(chapterNo, index, outcome.text)
          // EPUB 源：收集 BlockEdit
          if (epubEditDir && epubFlatBlocks && epubOutputPath) {
            const flat = epubFlatBlocks.find(
              (f) => f.chapterIndex === chapterNo && f.paragraphIndex === index,
            )
            if (flat) {
              const sanitized = sanitizeInline(outcome.text)
              const list = epubEditsByRelPath.get(flat.relPath) ?? []
              list.push({ index: flat.blockIndex, inner: sanitized.xml })
              epubEditsByRelPath.set(flat.relPath, list)
            }
          }
          done += 1
          if (outcome.fellBack) fellBack += 1
        } catch (err) {
          failed += 1
          console.warn(err)
        }
        setBatch({ done, total: targets.length })
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      // ─── S6：EPUB 源批量写回 + 重打包 ───
      if (epubEditDir && epubOutputPath && epubEditsByRelPath.size > 0) {
        let epubErr = ''
        for (const [relPath, edits] of epubEditsByRelPath) {
          try {
            await invoke('edit_write_blocks', { editDir: epubEditDir, relPath, edits })
          } catch (e) {
            epubErr += `${relPath}: ${String(e)}; `
          }
        }
        if (!epubErr) {
          try {
            await invoke('edit_save', {
              editDir: epubEditDir,
              outputPath: epubOutputPath,
              createRevision: false,
            })
            onCommitted?.()
          } catch (e) {
            epubErr += `重打包: ${String(e)}`
          }
        }
        if (epubErr) {
          onNotify(`部分写回失败：${epubErr}（译文已存锻造记录，请检查后手动应用）`)
        }
      }
    } finally {
      const stopped = cancelRef.current
      setTranslating(false)
      setBatch(null)
      onNotify(
        `本章翻译${stopped ? '已停止' : '完成'}：成功 ${done} 段` +
        `${failed ? `，失败 ${failed} 段` : ''}` +
        `${fellBack ? `，${fellBack} 段回落到本地` : ''}；请校对后保存`,
      )
    }
  }

  /** 用户校对后的译文在保存时写回翻译记忆，形成“越用越准”的本地迭代。 */
  const collectMemory = (): TranslationMemoryState => {
    let next = memoryRef.current
    for (const targetKey of dirtyKeys) {
      const after = draft[targetKey]?.translate?.trim()
      const before = edits[targetKey]?.translate?.trim()
      if (!after || after === before) continue
      const [chapterNo, paragraphNo] = targetKey.split(':').map(Number)
      const source = analysis.chapters[chapterNo]?.paragraphs[paragraphNo] ?? ''
      if (!source) continue
      next = rememberTranslation(next, source, after, 'user')
    }
    return next
  }

  const persistMemory = async (next: TranslationMemoryState) => {
    if (next === memoryRef.current) return
    setMemory(next)
    memoryRef.current = next
    try {
      await invoke('write_translation_memory', { json: serializeMemory(next) })
    } catch (err) {
      console.warn(err)
    }
  }

  const discard = () => {
    setDraft(edits)
    onNotify('已放弃未保存的改动')
  }

  const commit = async () => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      const lines = rawText.replace(/\r\n?/g, '\n').split('\n')
      const result = applyRewrites(analysis, lines, draft)
      const rewritten = dirtyKeys.filter((k) => {
        const before = edits[k]?.rewrite?.trim() ?? ''
        const after = normalizeRewrite(draft[k]?.rewrite ?? '')
        return after && after !== before
      }).length
      const label = rewritten
        ? `改写 ${rewritten} 段`
        : `保存译文/注释 ${dirtyKeys.length} 段`
      const meta = await invoke<RevisionMeta>('commit_forge', {
        id: bookId,
        text: result.text,
        forge: serializeForgeState(draft),
        label,
        note: `改动 ${dirtyKeys.length} 段`,
      })
      setEdits(draft)
      await persistMemory(collectMemory())
      await loadRevisions()
      onCommitted()
      if (result.skipped) {
        onNotify(`已保存，但有 ${result.skipped} 段因行范围缺失被跳过`)
      } else if (rewritten) {
        onNotify(`已写回源文件，改写 ${rewritten} 段；版本 ${formatTime(meta.createdAt)} 可回滚`)
      } else {
        onNotify('译文/注释已保存；保存前状态已存为版本')
      }
    } catch (err) {
      console.warn(err)
      onNotify(`保存失败：${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const showDiff = async (rev: RevisionMeta) => {
    if (diffLoading) return
    setDiffLoading(true)
    try {
      const oldBuffer = await invoke<ArrayBuffer>('read_revision', { id: bookId, rev: rev.id })
      const currentBuffer = await invoke<ArrayBuffer>('read_book_bytes', { id: bookId })
      const before = decodeText(oldBuffer).text.replace(/\r\n?/g, '\n')
      const after = decodeText(currentBuffer).text.replace(/\r\n?/g, '\n')
      setDiff({
        title: `${formatTime(rev.createdAt)} 的版本 → 当前`,
        result: diffLines(before, after),
      })
    } catch (err) {
      console.warn(err)
      onNotify(`读取版本失败：${String(err)}`)
    } finally {
      setDiffLoading(false)
    }
  }

  const rollback = async (rev: RevisionMeta) => {
    if (saving) return
    setSaving(true)
    try {
      await invoke<RevisionMeta>('restore_revision', { id: bookId, rev: rev.id })
      setPendingRollback(null)
      await Promise.all([loadState(), loadRevisions()])
      onCommitted()
      onNotify(`已回滚到 ${formatTime(rev.createdAt)}；回滚前状态已另存为版本`)
    } catch (err) {
      console.warn(err)
      onNotify(`回滚失败：${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  // Esc：优先关差异/取消回滚/关面板；正在输入时不抢 Esc
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'TEXTAREA') return
      event.preventDefault()
      event.stopPropagation()
      if (diff) setDiff(null)
      else if (pendingRollback) setPendingRollback(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [diff, pendingRollback, onClose])

  return (
    <>
      <aside className="forge-panel" aria-label="锻造台">
        <div className="forge-head">
          <span className="forge-title">锻造台</span>
          <span className="forge-book" title={bookTitle}>{bookTitle}</span>
          <span className="grow" />
          <button
            className="btn small icon-only"
            data-tip="收起锻造台（Esc）"
            aria-label="关闭锻造台"
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        {loading ? (
          <div className="forge-empty">正在读取锻造记录…</div>
        ) : analysis.chapters.length === 0 ? (
          <div className="forge-empty">这本书没有可锻造的段落</div>
        ) : (
          <div className="forge-body">
            <label className="forge-row">
              <span className="forge-label">章节</span>
              <select
                value={chapterIndex}
                title="选择要锻造的章节"
                onChange={(event) => {
                  setChapterIndex(Number(event.target.value))
                  setParagraphIndex(0)
                }}
              >
                {analysis.chapters.map((_, index) => (
                  <option key={index} value={index}>
                    {index + 1}. {chapterLabel(analysis, index)}
                  </option>
                ))}
              </select>
            </label>

            <ol className="forge-paragraphs">
              {paragraphs.map((text, index) => {
                const item = draft[editKey(chapterIndex, index)]
                return (
                  <li key={index}>
                    <button
                      className={`forge-para ${index === paragraphIndex ? 'on' : ''}`}
                      title={text}
                      onClick={() => setParagraphIndex(index)}
                    >
                      <span className="forge-para-no">{index + 1}</span>
                      <span className="forge-para-text">{text}</span>
                      <span className="forge-badges">
                        {item?.rewrite?.trim() && <i className="badge-rewrite">改</i>}
                        {item?.translate?.trim() && <i className="badge-translate">译</i>}
                        {item?.note?.trim() && <i className="badge-note">注</i>}
                      </span>
                    </button>
                  </li>
                )
              })}
              {paragraphs.length === 0 && <li className="forge-empty">这一章没有正文段落</li>}
            </ol>

            {original && (
              <div className="forge-editor">
                <div className="forge-editor-head">
                  <span>{paragraphLabel(analysis, chapterIndex, paragraphIndex)}</span>
                  {stored && <span className="forge-stored">已有存档</span>}
                </div>
                <blockquote className="forge-original" title="原文">
                  {original}
                </blockquote>

                <div className="forge-translate">
                  <div className="forge-translate__meta">
                    <span className="forge-translate__pair">{pairLabel(lang)}</span>
                    <span className="forge-translate__dot">·</span>
                    <span>{STYLE_LABEL[prefs.translateStyle]}</span>
                    <span className="forge-translate__dot">·</span>
                    <span title={MODE_LABEL[prefs.translateMode]}>{MODE_LABEL[prefs.translateMode]}</span>
                    <span className="grow" />
                    <span className="forge-translate__counts">
                      术语 {glossary.length} · 记忆 {memoryCount(memory)}
                    </span>
                  </div>
                  <div className="forge-translate__actions">
                    <button
                      className="btn small"
                      data-tip="用当前引擎翻译这一段（术语表优先，译后自动繁转简）"
                      onClick={() => void translateCurrent()}
                      disabled={translating || !original.trim()}
                    >
                      <Icon name={translating && !batch ? 'hourglass_top' : 'translate'} size={15} />
                      译本段
                    </button>
                    <button
                      className="btn small"
                      data-tip="翻译本章所有还没有译文的段落；已有译文会保留"
                      onClick={() => void translateChapter()}
                      disabled={translating || !paragraphs.length}
                    >
                      <Icon name="auto_awesome" size={15} />
                      译本章
                    </button>
                    {batch && (
                      <>
                        <span className="forge-translate__progress">
                          {batch.done} / {batch.total}
                        </span>
                        <button
                          className="btn small icon-only"
                          data-tip="停止本章翻译"
                          aria-label="停止翻译"
                          onClick={() => { cancelRef.current = true }}
                        >
                          <Icon name="stop" size={15} />
                        </button>
                      </>
                    )}
                  </div>
                  {currentHits.length > 0 && (
                    <div
                      className="forge-term-hits"
                      title={currentHits.map((entry) => `${entry.source} → ${entry.target}`).join('\n')}
                    >
                      术语命中 {currentHits.length}：{currentHits.slice(0, 6).map((entry) => entry.target).join('、')}
                      {currentHits.length > 6 ? '…' : ''}
                    </div>
                  )}
                  {lastOutcome && (
                    <div className="forge-translate__result">
                      {engineLabel(lastOutcome)} · {Math.round(lastOutcome.elapsedMs)} ms
                      {lastOutcome.masks > 0 && ` · 专名 ${lastOutcome.restored}/${lastOutcome.masks}`}
                      {lastOutcome.fellBack && <em> · 已回落本地</em>}
                      {lastOutcome.restored < lastOutcome.masks && <em> · 有占位符未还原，请校对</em>}
                    </div>
                  )}
                  <div className="forge-translate__hint">
                    引擎与 API Key 在「设置 → 功能 → 翻译」；术语表也在这里维护。译文请校对后点下方保存。
                  </div>
                </div>

                <label className="forge-field">
                  <span>改写</span>
                  <textarea
                    rows={4}
                    value={current.rewrite ?? ''}
                    placeholder="留空表示不改；换行会合并为一行，保持一段换一段"
                    title="改写这一段正文，保存后写回源文件"
                    onChange={(event) => setField('rewrite', event.target.value)}
                  />
                </label>
                {current.rewrite && (
                  <div className="forge-tools">
                    <span className="forge-hint">改写只替换这一段，标题与空行不动</span>
                    <span className="grow" />
                    <button
                      className="btn small icon-only tip-top"
                      data-tip="还原这一段原文"
                      aria-label="还原原文"
                      onClick={clearRewrite}
                    >
                      <Icon name="undo" size={16} />
                    </button>
                  </div>
                )}

                <label className="forge-field">
                  <span>译文</span>
                  <textarea
                    rows={3}
                    value={current.translate ?? ''}
                    placeholder="手工录入译文；只保存在锻造记录里，不改动 TXT 正文"
                    title="为这一段录入译文"
                    onChange={(event) => setField('translate', event.target.value)}
                  />
                </label>

                <label className="forge-field">
                  <span>注释</span>
                  <textarea
                    rows={3}
                    value={current.note ?? ''}
                    placeholder="给这一段写批注；只保存在锻造记录里"
                    title="为这一段写注释"
                    onChange={(event) => setField('note', event.target.value)}
                  />
                </label>
              </div>
            )}

            <div className="forge-commit">
              <span className="forge-hint">
                {dirty ? `待保存 ${dirty} 段` : '没有未保存的改动'}
              </span>
              <span className="grow" />
              <button
                className="btn small icon-only tip-top"
                data-tip="放弃未保存的改动"
                aria-label="放弃改动"
                onClick={discard}
                disabled={!dirty || saving}
              >
                <Icon name="restart_alt" size={16} />
              </button>
              <button
                className="btn primary small icon-only tip-top"
                data-tip={saving ? '正在保存…' : '保存并写回源文件'}
                aria-label="保存到源文件"
                onClick={() => void commit()}
                disabled={!dirty || saving}
              >
                <Icon name="save" size={16} />
              </button>
            </div>
            <p className="forge-warn">
              保存后源文件统一为 UTF-8；保存前的原始文件会存为版本，可随时回滚。
            </p>

            <div className="forge-revisions">
              <div className="forge-revisions-head">
                <span>历史版本</span>
                <span className="forge-count">{revisions.length ? `${revisions.length} 条` : ''}</span>
                <span className="grow" />
                <button
                  className="btn small icon-only tip-top"
                  data-tip="刷新版本列表"
                  aria-label="刷新版本"
                  onClick={() => void loadRevisions()}
                >
                  <Icon name="refresh" size={16} />
                </button>
              </div>
              {revisions.length === 0 ? (
                <div className="forge-empty">还没有版本；第一次保存后这里会出现记录</div>
              ) : (
                <ul className="forge-rev-list">
                  {revisions.map((rev) => (
                    <li key={rev.id}>
                      <div className="forge-rev-main">
                        <span className="forge-rev-time">{formatTime(rev.createdAt)}</span>
                        <span className="forge-rev-label" title={rev.note || rev.label}>
                          {rev.label}
                        </span>
                        <span className="forge-rev-size">{formatBytes(rev.sourceBytes)}</span>
                      </div>
                      <div className="forge-rev-actions">
                        <button
                          className="btn small icon-only tip-top"
                          data-tip={diffLoading ? '正在读取…' : '查看版本差异'}
                          aria-label="查看差异"
                          onClick={() => void showDiff(rev)}
                          disabled={diffLoading}
                        >
                          <Icon name="difference" size={16} />
                        </button>
                        <button
                          className="btn small icon-only tip-top"
                          data-tip="回滚到这个版本"
                          aria-label="回滚"
                          onClick={() => setPendingRollback(rev)}
                          disabled={saving}
                        >
                          <Icon name="restore" size={16} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {pendingRollback && (
              <div className="forge-confirm">
                <span>
                  回滚到 {formatTime(pendingRollback.createdAt)} 的版本？当前状态会先自动存档。
                </span>
                <button
                  className="btn small icon-only tip-top"
                  data-tip="取消回滚"
                  aria-label="取消回滚"
                  onClick={() => setPendingRollback(null)}
                >
                  <Icon name="close" size={16} />
                </button>
                <button
                  className="btn danger-solid small icon-only tip-top"
                  data-tip="确认回滚"
                  aria-label="确认回滚"
                  onClick={() => void rollback(pendingRollback)}
                  disabled={saving}
                >
                  <Icon name="restore" size={16} />
                </button>
              </div>
            )}
          </div>
        )}
      </aside>

      {diff && (
        <div className="forge-diff-mask" onClick={() => setDiff(null)}>
          <div className="forge-diff" onClick={(event) => event.stopPropagation()}>
            <div className="forge-diff-head">
              <span className="forge-diff-title">{diff.title}</span>
              <span className="forge-diff-stat">
                新增 {diff.result.added} 行 · 删除 {diff.result.removed} 行
              </span>
              <span className="grow" />
              <button
                className="btn small icon-only"
                data-tip="关闭差异视图（Esc）"
                aria-label="关闭差异视图"
                onClick={() => setDiff(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="forge-diff-body">
              {diff.result.truncated && (
                <div className="forge-diff-tip">差异过大，已按整块删除/新增展示。</div>
              )}
              {diff.result.hunks.length === 0 ? (
                <div className="forge-diff-tip">这个版本与当前文本一致。</div>
              ) : (
                diff.result.hunks.map((hunk, hunkIndex) => (
                  <div className="diff-hunk" key={hunkIndex}>
                    {hunkIndex > 0 && <div className="diff-gap">⋯</div>}
                    {hunk.rows.map((row, rowIndex) => (
                      <div className={`diff-row ${row.kind}`} key={rowIndex}>
                        <span className="diff-no">{row.aNo ?? ''}</span>
                        <span className="diff-no">{row.bNo ?? ''}</span>
                        <span className="diff-mark">
                          {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}
                        </span>
                        <span className="diff-text">{row.text || ' '}</span>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
