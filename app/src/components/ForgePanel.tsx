import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  editKey,
  hasEdit,
  parseForgeState,
  serializeForgeState,
  type ForgeEdit,
  type ForgeEdits,
} from '../lib/forge'
import type { TxtAnalysis } from '../lib/txt-chapters'
import {
  buildForgeDraft,
  cacheForgeDraft,
  flushForgeDraft,
  loadForgeDraft,
  setForgeTarget,
  type ForgeDraftDoc,
} from '../lib/forge-drafts'
import {
  buildRealignPlan,
  finalizeRealign,
  type RealignPlan,
} from '../lib/realign-drafts'
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
  translateBaiduBlocks,
  translateConfigFromPrefs,
  translateOne,
  polishOne,
  type TranslateOutcome,
  type TranslationMemoryState,
} from '../lib/translate'
import type { Prefs } from '../lib/prefs'
import Icon from './Icon'
import RealignDialog from './RealignDialog'
import TranslateConfirmDialog from './TranslateConfirmDialog'

const EMPTY_INDEX_SET: Set<number> = new Set()

type Props = {
  bookId: string
  bookTitle: string
  analysis: TxtAnalysis
  prefs: Prefs
  /** 当前阅读到的章节标题，用于默认定位 */
  currentChapter: string
  /** 阅读器给出的准确章节序号（优先于标题匹配） */
  initialChapterIndex?: number
  /** 阅读器给出的段落下标（同章同段接力） */
  initialBlock?: number
  onClose: () => void
  onNotify: (message: string) => void
  /** S10：段落序号 → EPUB rel_path + block_index 映射（TXT 书为空） */
  epubFlatBlocks?: { chapterIndex: number; paragraphIndex: number; relPath: string; blockIndex: number; text: string }[]
  /** 嵌入阅读器统一壳：隐藏自带标题栏，返回/关闭由外层承担 */
  embedded?: boolean
  /** 把工具栏状态交给外层（嵌入时阅读器顶栏渲染章节抽屉按钮） */
  onToolbar?: (state: ForgeToolbarState | null) => void
}

/** 外层顶栏需要的锻造档状态：目前只有章节抽屉开关 */
export type ForgeToolbarState = {
  treeOpen: boolean
  toggleTree: () => void
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
  return (a?.translate ?? '') === (b?.translate ?? '')
    && (a?.note ?? '') === (b?.note ?? '')
}

export default function ForgePanel({
  bookId,
  bookTitle,
  analysis,
  prefs,
  currentChapter,
  initialChapterIndex,
  initialBlock,
  onClose,
  onNotify,
  epubFlatBlocks,
  embedded = false,
  onToolbar,
}: Props) {
  const [edits, setEdits] = useState<ForgeEdits>({})
  const [draft, setDraft] = useState<ForgeEdits>({})
  const [chapterIndex, setChapterIndex] = useState(0)
  const [paragraphIndex, setParagraphIndex] = useState(0)
  /** 选区：译所选 / 润色所选的作用范围；点击单选，Ctrl 加选，Shift 连选 */
  const [selection, setSelection] = useState<Set<number>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  /** 底部工具栏右侧的「本章未译」浮层 */
  const [untranslatedOpen, setUntranslatedOpen] = useState(false)
  /** 章节抽屉：与编辑层文件树同一套交互（覆盖式） */
  const [treeOpen, setTreeOpen] = useState(false)
  /** 译文草稿里的原文镜像：与当前母本段落不一致即视为漂移 */
  const [mirror, setMirror] = useState<ForgeDraftDoc | null>(null)
  /** S12：重新对齐预览弹层 */
  const [realignOpen, setRealignOpen] = useState(false)
  /** 翻译覆盖确认：目标里已有译文时先问一次，不静默覆盖 */
  const [overwriteAsk, setOverwriteAsk] = useState<{
    scope: 'selection' | 'chapter'
    chapterNo: number
    targets: number[]
    translated: number
  } | null>(null)
  /** 显式定位计数器：同一段落再点一次也要重新滚到位 */
  const [locateToken, setLocateToken] = useState(0)
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([])
  const [memory, setMemory] = useState<TranslationMemoryState>({ version: 1, entries: {} })
  const [translating, setTranslating] = useState(false)
  /** E：AI 润色进行中 */
  const [polishing, setPolishing] = useState(false)
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const [lastOutcome, setLastOutcome] = useState<TranslateOutcome | null>(null)
  const locatedRef = useRef(false)
  /** 接力定位后需要把选中段滚进视口（一次性） */
  const scrollTargetRef = useRef(false)
  const memoryRef = useRef(memory)
  const cancelRef = useRef(false)
  /** 分屏滚动容器与逐段行：定位时按 data-block-index 找到同一行 */
  const workRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  /** Shift 连选的起点 */
  const anchorRef = useRef<number | null>(null)

  const toggleTree = useCallback(() => setTreeOpen((value) => !value), [])

  // 外层顶栏据此渲染「展开文件树」按钮（与编辑层同一位置）
  useEffect(() => {
    onToolbar?.({ treeOpen, toggleTree })
    return () => onToolbar?.(null)
  }, [treeOpen, toggleTree, onToolbar])

  /** 段落选中：单击单选，Ctrl / Cmd 切换，Shift 从锚点连选 */
  const selectBlock = (index: number, additive: boolean, range: boolean) => {
    setParagraphIndex(index)
    if (range && anchorRef.current !== null) {
      const from = Math.min(anchorRef.current, index)
      const to = Math.max(anchorRef.current, index)
      const next = new Set<number>()
      for (let i = from; i <= to; i += 1) next.add(i)
      setSelection(next)
      return
    }
    if (additive) {
      setSelection((prev) => {
        const next = new Set(prev)
        if (next.has(index)) next.delete(index)
        else next.add(index)
        return next
      })
      anchorRef.current = index
      return
    }
    setSelection(new Set([index]))
    anchorRef.current = index
  }

  /** 译文框随内容自动增高：左右两栏按同一行对齐，行高取两侧较高者 */
  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }

  /** 整屏重算高度：切章、窗口变宽、批量翻译后调用 */
  const fitRows = () => {
    const root = workRef.current
    if (!root) return
    root.querySelectorAll<HTMLTextAreaElement>('textarea.forge-autogrow').forEach(autosize)
  }

  // 切章后按新内容重排行高；容器宽度变化（窗口缩放 / 抽屉收起）也重算
  useEffect(() => {
    const root = workRef.current
    if (!root) return
    const frame = requestAnimationFrame(fitRows)
    let lastWidth = root.clientWidth
    const observer = new ResizeObserver(() => {
      if (root.clientWidth === lastWidth) return
      lastWidth = root.clientWidth
      fitRows()
    })
    observer.observe(root)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterIndex])

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

  // 锻造译文草稿：首次进入时按原文结构生成镜像空占位文件，之后只在 target 上写入
  useEffect(() => {
    if (!bookId || analysis.chapters.length === 0) return
    let alive = true
    void loadForgeDraft(bookId).then((loaded) => {
      if (!alive) return
      const doc = loaded ?? buildForgeDraft(analysis.chapters)
      if (!loaded) {
        cacheForgeDraft(bookId, doc)
        void invoke('write_forge_draft', { id: bookId, json: JSON.stringify(doc) }).catch(() => null)
      }
      // 镜像里的 source 是建草稿时的原文；与当前母本不一致就是漂移
      setMirror(doc)
    })
    return () => {
      alive = false
      flushForgeDraft(bookId)
    }
  }, [bookId, analysis])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        await loadState()
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
  }, [loadState, onNotify])

  // 默认定位到当前阅读章节 / 段落（只在首次拿到数据时执行，保存后刷新不重置）
  useEffect(() => {
    if (locatedRef.current || !analysis.chapters.length) return
    locatedRef.current = true
    const target = typeof initialChapterIndex === 'number'
      && initialChapterIndex >= 0
      && initialChapterIndex < analysis.chapters.length
      ? initialChapterIndex
      : analysis.chapters.findIndex((chapter) => chapter.title?.trim() === currentChapter.trim())
    if (target >= 0) {
      const chapterData = analysis.chapters[target]
      const max = Math.max(0, (chapterData?.paragraphs.length ?? 0) - 1)
      const paragraph = typeof initialBlock === 'number'
        ? Math.max(0, Math.min(initialBlock, max))
        : 0
      setChapterIndex(target)
      setParagraphIndex(paragraph)
      setSelection(new Set([paragraph]))
      anchorRef.current = paragraph
      scrollTargetRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis])

  // 定位：切章 / 接力进入 / 点未译跳转后，把目标段滚进视口中间
  useEffect(() => {
    if (!scrollTargetRef.current) return
    scrollTargetRef.current = false
    rowRefs.current[paragraphIndex]?.scrollIntoView({ block: 'center' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterIndex, locateToken])

  /** 切章：选区和滚动位置一起归零 */
  const goChapter = (index: number, paragraph = 0) => {
    setChapterIndex(index)
    setParagraphIndex(paragraph)
    setSelection(new Set([paragraph]))
    anchorRef.current = paragraph
    setTreeOpen(false)
    setUntranslatedOpen(false)
    scrollTargetRef.current = true
    setLocateToken((token) => token + 1)
  }

  const dirtyKeys = useMemo(() => {
    const keys = new Set([...Object.keys(draft), ...Object.keys(edits)])
    return [...keys].filter((key) => !sameEdit(draft[key], edits[key]))
  }, [draft, edits])
  const dirty = dirtyKeys.length

  /** 本章未译段落序号：底部工具栏只针对当前章节统计 */
  const untranslatedParagraphs = useMemo(() => {
    const item = analysis.chapters[chapterIndex]
    return (item?.paragraphs ?? [])
      .map((text, paragraphNo) => ({ text, paragraphNo }))
      .filter(({ text, paragraphNo }) => (
        text.trim() && !draft[editKey(chapterIndex, paragraphNo)]?.translate?.trim()
      ))
      .map(({ paragraphNo }) => paragraphNo)
  }, [analysis, chapterIndex, draft])

  /** 每章进度：只给章节抽屉显示；按草稿键统计，避免每次输入都扫全书 */
  const chapterProgress = useMemo(() => {
    const counts = new Array<number>(analysis.chapters.length).fill(0)
    const totals = analysis.chapters.map(
      (item) => item.paragraphs.filter((text) => text.trim()).length,
    )
    for (const [draftKey, edit] of Object.entries(draft)) {
      if (!edit?.translate?.trim()) continue
      const [chapterNo, paragraphNo] = draftKey.split(':').map(Number)
      if (!Number.isInteger(chapterNo) || chapterNo < 0 || chapterNo >= totals.length) continue
      if (!(analysis.chapters[chapterNo]?.paragraphs[paragraphNo] ?? '').trim()) continue
      counts[chapterNo] += 1
    }
    return counts.map((done, chapterNo) => ({ done, total: totals[chapterNo] ?? 0 }))
  }, [analysis, draft])
  const chapterTotal = chapterProgress[chapterIndex]?.total ?? 0
  const chapterTranslated = chapterProgress[chapterIndex]?.done ?? 0

  /** EPUB 段落 → 母本 relPath / blockIndex；TXT 书为空 */
  const flatByParagraph = useMemo(() => {
    const map = new Map<string, { relPath: string; blockIndex: number }>()
    for (const item of epubFlatBlocks ?? []) {
      map.set(editKey(item.chapterIndex, item.paragraphIndex), {
        relPath: item.relPath,
        blockIndex: item.blockIndex,
      })
    }
    return map
  }, [epubFlatBlocks])
  const canExport = Boolean(epubFlatBlocks?.length)

  const chapter = analysis.chapters[chapterIndex]
  const paragraphs = chapter?.paragraphs ?? []
  const original = paragraphs[paragraphIndex] ?? ''

  /** 漂移：译文草稿里记录的原文和当前母本这一段对不上（母本被编辑过） */
  const driftByChapter = useMemo(() => {
    const map = new Map<number, Set<number>>()
    if (!mirror) return map
    const byChapter = new Map(mirror.chapters.map((item) => [item.chapterIndex, item]))
    analysis.chapters.forEach((item, chapterNo) => {
      const mirrorChapter = byChapter.get(chapterNo)
      if (!mirrorChapter) return
      const byIndex = new Map(mirrorChapter.blocks.map((block) => [block.index, block.source]))
      const drift = new Set<number>()
      item.paragraphs.forEach((text, index) => {
        const before = byIndex.get(index)
        if (before !== undefined && before !== text) drift.add(index)
      })
      if (drift.size) map.set(chapterNo, drift)
    })
    return map
  }, [mirror, analysis])
  const driftedBlocks = driftByChapter.get(chapterIndex) ?? EMPTY_INDEX_SET
  const driftTotal = useMemo(
    () => [...driftByChapter.values()].reduce((sum, set) => sum + set.size, 0),
    [driftByChapter],
  )

  /** 重新对齐时被改写过的段落：译文保留，但需要人工对校 */
  const staleBlocks = useMemo(() => {
    const set = new Set<number>()
    const mirrorChapter = mirror?.chapters.find((item) => item.chapterIndex === chapterIndex)
    mirrorChapter?.blocks.forEach((block) => {
      if (block.stale) set.add(block.index)
    })
    return set
  }, [mirror, chapterIndex])

  /** S12：对齐计划只读生成；打开弹层时才计算 */
  const realignPlan = useMemo<RealignPlan | null>(() => {
    if (!realignOpen || !mirror) return null
    return buildRealignPlan({ mirror, chapters: analysis.chapters, edits: draft })
  }, [realignOpen, mirror, analysis, draft])

  const setField = (field: 'note', value: string, paragraphNo = paragraphIndex) => {
    const targetKey = editKey(chapterIndex, paragraphNo)
    const next: ForgeEdit = { ...(draft[targetKey] ?? {}), [field]: value }
    setDraft((prev) => {
      const copy = { ...prev }
      if (!hasEdit(next)) delete copy[targetKey]
      else copy[targetKey] = next
      return copy
    })
  }

  /** 一键定位本章下一处未译段落（从当前段往后找，绕回开头） */
  const locateNextUntranslated = () => {
    if (!paragraphs.length) return
    const target = untranslatedParagraphs.find((index) => index > paragraphIndex)
      ?? untranslatedParagraphs[0]
    if (target === undefined) {
      onNotify('本章没有未译段落')
      return
    }
    setParagraphIndex(target)
    setSelection(new Set([target]))
    anchorRef.current = target
    setLocateToken((value) => value + 1)
  }

  const config = useMemo(() => translateConfigFromPrefs(prefs), [prefs])
  const lang = original ? detectLanguage(original) : 'unknown'

  /** E：译文框撤销栈（按段落 key 分开；连续输入 1.2s 内合并成一步） */
  const targetUndoRef = useRef<Record<string, { stack: string[]; lastAt: number }>>({})
  const recordTargetUndo = (targetKey: string, currentValue: string) => {
    const now = Date.now()
    const state = targetUndoRef.current[targetKey] ?? { stack: [], lastAt: 0 }
    if (now - state.lastAt > 1200) {
      state.stack.push(currentValue)
      if (state.stack.length > 40) state.stack.shift()
    }
    state.lastAt = now
    targetUndoRef.current[targetKey] = state
  }

  const applyTranslation = (chapterNo: number, index: number, text: string) => {
    const targetKey = editKey(chapterNo, index)
    recordTargetUndo(targetKey, draft[targetKey]?.translate ?? '')
    setForgeTarget(bookId, chapterNo, index, text)
    setDraft((prev) => ({
      ...prev,
      [targetKey]: { ...(prev[targetKey] ?? {}), translate: text },
    }))
  }

  const writeTranslateAt = (chapterNo: number, index: number, value: string) => {
    setForgeTarget(bookId, chapterNo, index, value)
    const k = editKey(chapterNo, index)
    setDraft((prev) => {
      const next: ForgeEdit = { ...(prev[k] ?? {}), translate: value }
      const copy = { ...prev }
      if (!hasEdit(next)) delete copy[k]
      else copy[k] = next
      return copy
    })
  }

  const setTranslateAt = (chapterNo: number, index: number, value: string) => {
    const targetKey = editKey(chapterNo, index)
    recordTargetUndo(targetKey, draft[targetKey]?.translate ?? '')
    writeTranslateAt(chapterNo, index, value)
  }

  /** Ctrl+Z：撤销当前译文框的上一步（不受 contenteditable / 受控 textarea 原生撤销限制） */
  const undoTarget = (chapterNo: number, index: number) => {
    const targetKey = editKey(chapterNo, index)
    const state = targetUndoRef.current[targetKey]
    const prev = state?.stack.pop()
    if (prev === undefined) {
      onNotify('这段没有可撤销的译文改动')
      return
    }
    writeTranslateAt(chapterNo, index, prev)
  }

  const engineLabel = (outcome: TranslateOutcome) =>
    outcome.engine === 'memory'
      ? '翻译记忆'
      : outcome.engine === 'online'
        ? '在线引擎'
        : outcome.engine === 'baidu'
          ? '百度翻译'
          : outcome.engine === 'baiduLlm'
            ? '百度大模型'
            : outcome.engine === 'builtin'
              ? '内置引擎'
              : '本地引擎'

  /** 逐段翻译：所选段落与整章共用一套进度 / 取消逻辑；百度两档整批送上下文 */
  const translateMany = async (chapterNo: number, targets: number[], label: string) => {
    if (translating || targets.length === 0) return
    const sourceParagraphs = analysis.chapters[chapterNo]?.paragraphs ?? []
    setTranslating(true)
    setLastOutcome(null)
    cancelRef.current = false
    setBatch({ done: 0, total: targets.length })
    let done = 0
    let failed = 0
    let fellBack = 0
    try {
      if (config.mode === 'baidu' || config.mode === 'baiduLlm') {
        const result = await translateBaiduBlocks({
          config,
          blocks: targets.map((index) => ({ index, source: sourceParagraphs[index] ?? '' })),
          glossary,
          memory: memoryRef.current,
          isCancelled: () => cancelRef.current,
          onResult: ({ index, outcome }) => {
            applyTranslation(chapterNo, index, outcome.text)
            setLastOutcome(outcome)
            done += 1
            if (outcome.fellBack) fellBack += 1
            setBatch({ done, total: targets.length })
          },
        })
        failed = result.failed
      } else {
        for (const index of targets) {
          if (cancelRef.current) break
          const source = sourceParagraphs[index] ?? ''
          try {
            const outcome = await translateOne({
              config,
              source,
              glossary,
              memory: memoryRef.current,
            })
            applyTranslation(chapterNo, index, outcome.text)
            setLastOutcome(outcome)
            done += 1
            if (outcome.fellBack) fellBack += 1
          } catch (err) {
            failed += 1
            console.warn(err)
          }
          setBatch({ done, total: targets.length })
          await new Promise((resolve) => setTimeout(resolve, 0))
        }
      }
    } finally {
      const stopped = cancelRef.current
      setTranslating(false)
      setBatch(null)
      requestAnimationFrame(fitRows)
      onNotify(
        `${label}${stopped ? '已停止' : '完成'}：成功 ${done} 段` +
        `${failed ? `，失败 ${failed} 段` : ''}` +
        `${fellBack ? `，${fellBack} 段回落到本地` : ''}；译文只进锻造草稿，校对后再保存`,
      )
    }
  }

  const translateLabel = (scope: 'selection' | 'chapter', count: number) =>
    scope === 'selection' ? `所选 ${count} 段翻译` : '本章翻译'

  /** 目标段落里已有译文的条数：草稿即当前真相 */
  const existingInTargets = (chapterNo: number, targets: number[]) =>
    targets.filter((index) => (draft[editKey(chapterNo, index)]?.translate ?? '').trim()).length

  /** 已有译文先弹一次确认；一个都没有就直接翻 */
  const requestTranslate = (scope: 'selection' | 'chapter', targets: number[]) => {
    const chapterNo = chapterIndex
    const translated = existingInTargets(chapterNo, targets)
    if (translated === 0) {
      void translateMany(chapterNo, targets, translateLabel(scope, targets.length))
      return
    }
    setOverwriteAsk({ scope, chapterNo, targets, translated })
  }

  /** 覆盖确认的三个出口：全部重译 / 只补未译 / 取消（取消不进入本函数） */
  const resolveOverwrite = (action: 'overwrite' | 'skip') => {
    const ask = overwriteAsk
    setOverwriteAsk(null)
    if (!ask) return
    let targets = ask.targets
    if (action === 'skip') {
      targets = ask.targets.filter(
        (index) => !(draft[editKey(ask.chapterNo, index)]?.translate ?? '').trim(),
      )
      if (targets.length === 0) {
        onNotify(ask.scope === 'selection' ? '所选段落都已有译文' : '本章没有未译段落')
        return
      }
    }
    void translateMany(ask.chapterNo, targets, translateLabel(ask.scope, targets.length))
  }

  /** 工具栏「译所选」：只翻选区；已有译文会先确认是否覆盖 */
  const translateSelected = () => {
    const targets = [...selection]
      .sort((a, b) => a - b)
      .filter((index) => (paragraphs[index] ?? '').trim())
    if (targets.length === 0) {
      onNotify('先在分屏里选中要翻译的段落（Ctrl 加选 / Shift 连选）')
      return
    }
    requestTranslate('selection', targets)
  }

  /** 工具栏「译本章」：翻本章所有非空原文段落；已有译文会先确认是否覆盖 */
  const translateChapter = () => {
    const targets = paragraphs
      .map((text, index) => ({ text, index }))
      .filter(({ text }) => text.trim())
      .map(({ index }) => index)
    if (targets.length === 0) {
      onNotify('本章没有待翻译段落')
      return
    }
    requestTranslate('chapter', targets)
  }

  /** E：AI 润色——所选与本章共用一套进度 / 取消 / 撤销；只动译文表达，原文与草稿结构不变 */
  const polishMany = async (chapterNo: number, targets: number[], label: string) => {
    if (polishing || translating || targets.length === 0) return
    const sourceParagraphs = analysis.chapters[chapterNo]?.paragraphs ?? []
    setPolishing(true)
    cancelRef.current = false
    setBatch({ done: 0, total: targets.length })
    let done = 0
    let failed = 0
    let firstError = ''
    try {
      for (const index of targets) {
        if (cancelRef.current) break
        const text = draft[editKey(chapterNo, index)]?.translate ?? ''
        try {
          const result = await polishOne({
            config,
            text,
            source: sourceParagraphs[index] ?? '',
          })
          applyTranslation(chapterNo, index, result.text)
          done += 1
        } catch (err) {
          failed += 1
          // 百度两档 / 内置引擎不支持润色：把中文错误原样带给用户，不吞掉
          if (!firstError) firstError = err instanceof Error ? err.message : String(err)
          console.warn(err)
        }
        setBatch({ done, total: targets.length })
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } finally {
      const stopped = cancelRef.current
      setPolishing(false)
      setBatch(null)
      requestAnimationFrame(fitRows)
      const reason = firstError.replace(/^Error:\s*/, '')
      onNotify(
        `${label}${stopped ? '已停止' : '完成'}：成功 ${done} 段` +
        `${failed ? `，失败 ${failed} 段` : ''}` +
        `${done > 0 ? '；Ctrl+Z 可撤销' : ''}` +
        `${reason ? `；原因：${reason}` : ''}`,
      )
    }
  }

  /** 工具栏「润色所选」：只处理选区里已有译文的段落 */
  const polishSelected = () => {
    const targets = [...selection]
      .sort((a, b) => a - b)
      .filter((index) => (draft[editKey(chapterIndex, index)]?.translate ?? '').trim())
    if (targets.length === 0) {
      onNotify('所选段落还没有译文；先翻译或手工录入，再润色')
      return
    }
    void polishMany(chapterIndex, targets, `所选 ${targets.length} 段润色`)
  }

  /** 工具栏「润色本章」：处理当前章所有已有译文的段落 */
  const polishChapter = () => {
    const targets = paragraphs
      .map((text, index) => ({ text, index }))
      .filter(({ index }) => (draft[editKey(chapterIndex, index)]?.translate ?? '').trim())
      .map(({ index }) => index)
    if (targets.length === 0) {
      onNotify('本章还没有译文；先翻译或手工录入，再润色')
      return
    }
    void polishMany(chapterIndex, targets, '本章润色')
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
      next = rememberTranslation(next, source, after, 'user', prefs.translateTarget)
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
    requestAnimationFrame(fitRows)
    onNotify('已放弃未保存的改动')
  }

  /** 把一份编辑表落进译文工程与覆盖层；母本不参与 */
  const saveDraft = async (source: ForgeEdits) => {
    const chapters = analysis.chapters.map((item, chapterNo) => {
      const blocks = item.paragraphs.map((text, paragraphNo) => {
        const flat = flatByParagraph.get(editKey(chapterNo, paragraphNo))
        return {
          index: paragraphNo,
          blockIndex: flat?.blockIndex ?? paragraphNo,
          source: text,
          target: source[editKey(chapterNo, paragraphNo)]?.translate ?? '',
          kind: 'paragraph',
        }
      })
      const sourceHref = flatByParagraph.get(editKey(chapterNo, 0))?.relPath
      return {
        chapterIndex: chapterNo,
        title: item.title ?? '',
        sourceHref,
        blocks,
      }
    })
    const result = await invoke<{
      translated: number
      blocks: number
      untranslated: number
      projectDir: string
    }>('translation_save', {
      id: bookId,
      language: prefs.translateTarget,
      chapters,
    })
    // 注释仍存锻造覆盖层；译文本身已写入译文工程
    await invoke('write_forge_state', { id: bookId, forge: serializeForgeState(source) })
    setEdits(source)
    return result
  }

  const commit = async () => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      const result = await saveDraft(draft)
      await persistMemory(collectMemory())
      onNotify(
        `译文已保存到译文工程：已译 ${result.translated} / 共 ${result.blocks} 段，` +
        `未译 ${result.untranslated} 段（母本未改动）`,
      )
    } catch (err) {
      console.warn(err)
      onNotify(`保存失败：${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  /** S12：母本段落结构变了，把已有译文按新结构重新落位（只写草稿层与译文工程） */
  const applyRealign = async (keepOrphans: boolean) => {
    if (!realignPlan || saving) return
    setSaving(true)
    try {
      const { doc, edits: nextEdits } = finalizeRealign(realignPlan, keepOrphans)
      await invoke('write_forge_draft', { id: bookId, json: JSON.stringify(doc) })
      cacheForgeDraft(bookId, doc)
      setMirror(doc)
      setDraft(nextEdits)
      requestAnimationFrame(fitRows)
      await saveDraft(nextEdits)
      setRealignOpen(false)
      const counts = realignPlan.counts
      onNotify(
        `已重新对齐：位移 ${realignPlan.moved} 段、改写 ${counts.modified} 段、` +
        `新增 ${counts.added} 段、删除 ${counts.removed} 段；译文已写入译文工程（母本未改动）`,
      )
    } catch (err) {
      console.warn(err)
      onNotify(`重新对齐失败：${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const exportEpub = async () => {
    if (exporting || saving) return
    if (!canExport) {
      onNotify('仅 EPUB 母本支持导出译文 EPUB')
      return
    }
    setExporting(true)
    try {
      const result = await invoke<{
        outputPath: string
        chaptersUsed: number
      }>('translation_export', { id: bookId, language: prefs.translateTarget })
      onNotify(`已导出译文 EPUB（${result.chaptersUsed} 章）：${result.outputPath}`)
    } catch (err) {
      console.warn(err)
      onNotify(`导出失败：${String(err)}`)
    } finally {
      setExporting(false)
    }
  }

  // Esc：关面板；正在输入时不抢 Esc
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      if (target?.tagName === 'TEXTAREA') return
      event.preventDefault()
      event.stopPropagation()
      if (overwriteAsk) {
        setOverwriteAsk(null)
        return
      }
      if (realignOpen) {
        if (!saving) setRealignOpen(false)
        return
      }
      if (treeOpen) {
        setTreeOpen(false)
        return
      }
      if (untranslatedOpen) {
        setUntranslatedOpen(false)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, overwriteAsk, realignOpen, saving, treeOpen, untranslatedOpen])

  return (
    <>
      <aside className="forge-panel" aria-label="锻造台">
        {!embedded && (
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
        )}

        {loading ? (
          <div className="forge-empty">正在读取锻造记录…</div>
        ) : analysis.chapters.length === 0 ? (
          <div className="forge-empty">这本书没有可锻造的段落</div>
        ) : (
          <>
            {/* 第二工具栏：左侧翻译 / 润色，右侧保存 / 导出（参照编辑层顶栏分区） */}
            <div className="forge-toolbar">
              <div className="forge-toolbar__group">
                <span className="forge-toolbar__chapter" title={chapterLabel(analysis, chapterIndex)}>
                  {chapterIndex + 1}. {chapterLabel(analysis, chapterIndex)}
                </span>
                <span className="forge-toolbar__meta">
                  {pairLabel(lang)} · {STYLE_LABEL[prefs.translateStyle]} · {MODE_LABEL[prefs.translateMode]}
                  {' · '}术语 {glossary.length} · 记忆 {memoryCount(memory)} 条
                </span>
              </div>

              <div className="forge-toolbar__group">
                <button
                  className="btn small"
                  data-tip="翻译选中段落（Ctrl 加选 / Shift 连选）；已有译文会先确认是否覆盖"
                  onClick={translateSelected}
                  disabled={translating || polishing || selection.size === 0}
                >
                  <Icon name={translating && !batch ? 'hourglass_top' : 'translate'} size={15} />
                  译所选{selection.size > 1 ? ` ${selection.size}` : ''}
                </button>
                <button
                  className="btn small"
                  data-tip="翻译本章所有非空原文段落；已有译文会先确认是否覆盖"
                  onClick={translateChapter}
                  disabled={translating || polishing || !paragraphs.length}
                >
                  <Icon name="auto_awesome" size={15} />
                  译本章
                </button>
                <button
                  className="btn small"
                  data-tip="AI 润色所选段落里已有译文的段落：只改表达不改原意（需要在线或本地 LLM）"
                  onClick={polishSelected}
                  disabled={polishing || translating}
                >
                  <Icon name={polishing ? 'hourglass_top' : 'auto_fix_high'} size={15} />
                  润色所选
                </button>
                <button
                  className="btn small"
                  data-tip="AI 润色本章所有已有译文的段落：只改表达不改原意（需要在线或本地 LLM）"
                  onClick={polishChapter}
                  disabled={polishing || translating}
                >
                  <Icon name="spellcheck" size={15} />
                  润色本章
                </button>
                <button
                  className="btn small icon-only"
                  data-tip="定位本章下一处未译段落"
                  aria-label="定位下一处未译"
                  onClick={locateNextUntranslated}
                  disabled={untranslatedParagraphs.length === 0}
                >
                  <Icon name="vertical_align_center" size={16} />
                </button>
                {batch && (
                  <>
                    <span className="forge-translate__progress">
                      {batch.done} / {batch.total}
                    </span>
                    <button
                      className="btn small icon-only"
                      data-tip="停止当前批处理"
                      aria-label="停止批处理"
                      onClick={() => { cancelRef.current = true }}
                    >
                      <Icon name="stop" size={15} />
                    </button>
                  </>
                )}
                {driftTotal > 0 && (
                  <button
                    className="btn small"
                    data-tip="母本段落结构变了：按新原文重新对齐已译段落（先预览再确认）"
                    onClick={() => setRealignOpen(true)}
                  >
                    <Icon name="sync_alt" size={14} />
                    重新对齐 {driftTotal}
                  </button>
                )}
                {(mirror?.orphans?.length ?? 0) > 0 && (
                  <span
                    className="forge-stale"
                    title={mirror!.orphans!.slice(0, 8).map((item) => item.target || item.source).join('\n')}
                  >
                    孤儿译文 {mirror!.orphans!.length}
                  </span>
                )}
              </div>

              <span className="grow" />

              <div className="forge-toolbar__group">
                <span className={`forge-toolbar__dirty${dirty ? ' on' : ''}`}>
                  {dirty ? `待保存 ${dirty} 段` : '没有未保存的改动'}
                </span>
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
                  className="btn small icon-only tip-top"
                  data-tip={canExport ? '导出译文 EPUB 到 final export' : '仅 EPUB 母本支持导出'}
                  aria-label="导出译文 EPUB"
                  onClick={() => void exportEpub()}
                  disabled={exporting || saving || !canExport}
                >
                  <Icon name="download" size={16} />
                </button>
                <button
                  className="btn primary small icon-only tip-top"
                  data-tip={saving ? '正在保存…' : '保存译文工程（不改母本）'}
                  aria-label="保存译文工程"
                  onClick={() => void commit()}
                  disabled={!dirty || saving}
                >
                  <Icon name="save" size={16} />
                </button>
              </div>
            </div>

            <div className="forge-body">
              {/* 章节抽屉：与编辑层文件树同一套覆盖式交互 */}
              {treeOpen && (
                <>
                  <button
                    className="edit-panel__veil"
                    aria-label="收起章节列表"
                    onClick={() => setTreeOpen(false)}
                  />
                  <aside className="edit-panel__tree forge-tree">
                    <div className="edit-panel__tree-head">
                      <span>章节</span>
                      <span className="grow" />
                      <button
                        className="toc-tool"
                        data-tip="收起（Esc）"
                        aria-label="收起章节列表"
                        onClick={() => setTreeOpen(false)}
                      >
                        <Icon name="close" size={15} />
                      </button>
                    </div>
                    <ul>
                      {analysis.chapters.map((item, index) => {
                        const progress = chapterProgress[index]
                        return (
                          <li
                            key={index}
                            className={`${index === chapterIndex ? 'active' : ''} is-chapter`}
                            title={item.title}
                            onClick={() => goChapter(index)}
                          >
                            <span className="en">{index + 1}. {chapterLabel(analysis, index)}</span>
                            <span className="ef">{progress?.done ?? 0} / {progress?.total ?? 0} 段已译</span>
                          </li>
                        )
                      })}
                    </ul>
                  </aside>
                </>
              )}

              {/* 分屏对照：左右同属一个滚动容器，按行对齐，行高取两侧较高者 */}
              <div className="forge-workbench">
                <div className="forge-workbench__scroll" ref={workRef}>
                  <div className="forge-workbench__head">
                    <span>原文</span>
                    <span>译文 · 注释</span>
                  </div>
                  {paragraphs.map((text, index) => {
                    const item = draft[editKey(chapterIndex, index)]
                    const translated = !!item?.translate?.trim()
                    const drift = driftedBlocks.has(index)
                    const stale = staleBlocks.has(index)
                    const selected = selection.has(index)
                    return (
                      <div
                        key={index}
                        ref={(el) => { rowRefs.current[index] = el }}
                        data-block-index={index}
                        className={
                          `forge-row${index === paragraphIndex ? ' on' : ''}` +
                          `${selected ? ' sel' : ''}${translated ? '' : ' missing'}`
                        }
                      >
                        <div
                          className="forge-row__src"
                          title="点击选中本段；Ctrl 加选，Shift 连选"
                          onClick={(event) => selectBlock(
                            index,
                            event.ctrlKey || event.metaKey,
                            event.shiftKey,
                          )}
                        >
                          <span className="forge-row__no">{index + 1}</span>
                          <p className="forge-row__text">{text.trim() ? text : '（空段）'}</p>
                        </div>

                        <div className="forge-row__dst">
                          <div
                            className="forge-row__flags"
                            onClick={(event) => selectBlock(
                              index,
                              event.ctrlKey || event.metaKey,
                              event.shiftKey,
                            )}
                          >
                            {translated
                              ? <i className="badge-translate">译</i>
                              : <i className="badge-missing">待译</i>}
                            {drift && (
                              <i className="badge-drift" title="草稿里的原文与当前母本这一段不一致">
                                漂移
                              </i>
                            )}
                            {stale && (
                              <i className="badge-stale" title="母本这段被改写过：译文保留，建议对校">
                                需校
                              </i>
                            )}
                            <span className="grow" />
                            <span className="forge-split__srclen">{text.length} 字</span>
                          </div>

                          <textarea
                            className="forge-row__target forge-autogrow"
                            rows={1}
                            value={item?.translate ?? ''}
                            placeholder="译文占位（空）"
                            title="译文可直接编辑；Ctrl+Z 撤销本段改动"
                            onFocus={() => setParagraphIndex(index)}
                            onChange={(event) => setTranslateAt(chapterIndex, index, event.target.value)}
                            onInput={(event) => autosize(event.currentTarget)}
                            onKeyDown={(event) => {
                              if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
                              event.preventDefault()
                              if (event.shiftKey) return
                              undoTarget(chapterIndex, index)
                            }}
                          />

                          {item?.note?.trim() || index === paragraphIndex ? (
                            <textarea
                              className="forge-row__note forge-autogrow"
                              rows={1}
                              value={item?.note ?? ''}
                              placeholder="本段注释（只存锻造记录，不进母本）"
                              title="为这一段写注释；只保存在锻造记录里"
                              onChange={(event) => setField('note', event.target.value, index)}
                              onInput={(event) => autosize(event.currentTarget)}
                            />
                          ) : (
                            <button
                              className="forge-row__note-add"
                              data-tip="给本段加一条注释"
                              onClick={() => setParagraphIndex(index)}
                            >
                              ＋ 注释
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {paragraphs.length === 0 && <div className="forge-empty">这一章没有正文段落</div>}
                </div>
              </div>
            </div>

            {/* 底部工具栏：左侧状态，右侧本章未译清单 */}
            <div className="forge-foot">
              <span className="forge-foot__stat">
                本章 已译 {chapterTranslated} / {chapterTotal} 段
              </span>
              {lastOutcome && (
                <span className="forge-foot__engine">
                  {engineLabel(lastOutcome)} · {Math.round(lastOutcome.elapsedMs)} ms
                </span>
              )}
              <span className="forge-foot__hint">
                只写译文层 译文/{prefs.translateTarget}/，母本字节不变
              </span>
              <span className="grow" />
              <div className="forge-foot__untranslated">
                <button
                  className={`forge-foot__untbtn${untranslatedOpen ? ' on' : ''}`}
                  data-tip={untranslatedOpen ? '收起本章未译清单' : '展开本章未译清单'}
                  onClick={() => setUntranslatedOpen((value) => !value)}
                  disabled={!paragraphs.length}
                >
                  <Icon name="checklist" size={15} />
                  本章未译 {untranslatedParagraphs.length} 段
                </button>
                {untranslatedOpen && (
                  <div className="forge-pop" role="dialog" aria-label="本章未译段落">
                    <div className="forge-pop__head">
                      <span>
                        本章未译 {untranslatedParagraphs.length} / {chapterTotal} 段
                      </span>
                      <span className="grow" />
                      <button
                        className="btn small icon-only"
                        data-tip="收起"
                        aria-label="收起未译清单"
                        onClick={() => setUntranslatedOpen(false)}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </div>
                    {untranslatedParagraphs.length === 0 ? (
                      <div className="forge-pop__empty">本章全部段落已有译文</div>
                    ) : (
                      <div className="forge-pop__paras">
                        {untranslatedParagraphs.slice(0, 200).map((paragraphNo) => (
                          <button
                            key={paragraphNo}
                            className="forge-untranslated__para"
                            onClick={() => {
                              setParagraphIndex(paragraphNo)
                              setSelection(new Set([paragraphNo]))
                              anchorRef.current = paragraphNo
                              setLocateToken((value) => value + 1)
                              setUntranslatedOpen(false)
                            }}
                          >
                            第 {paragraphNo + 1} 段
                          </button>
                        ))}
                        {untranslatedParagraphs.length > 200 && (
                          <span className="forge-untranslated__more">
                            还有 {untranslatedParagraphs.length - 200} 段未展开
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </aside>

      {overwriteAsk && (
        <TranslateConfirmDialog
          scopeLabel={overwriteAsk.scope === 'selection' ? '所选' : '本章'}
          total={overwriteAsk.targets.length}
          translated={overwriteAsk.translated}
          onCancel={() => setOverwriteAsk(null)}
          onOverwrite={() => resolveOverwrite('overwrite')}
          onSkip={() => resolveOverwrite('skip')}
        />
      )}

      {realignOpen && realignPlan && (
        <RealignDialog
          plan={realignPlan}
          bookTitle={bookTitle}
          saving={saving}
          onCancel={() => setRealignOpen(false)}
          onApply={(keepOrphans) => void applyRealign(keepOrphans)}
        />
      )}
    </>
  )
}
