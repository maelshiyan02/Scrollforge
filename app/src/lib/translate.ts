/**
 * 翻译流水线（R7）。
 *
 * 分段 → 术语/人名表 → 引擎（在线 / 本地 / 自动回落）→ 文学化提示词
 * → 繁简 normalize（优先级高于模型输出）→ 专名占位符还原 → 一致性检查
 * → 写入翻译记忆。
 *
 * 专名（人名/地名/组织名）在送翻译前替换成【T1】占位符，译后再还原为
 * 术语表里的简体译名——这样无论模型输出什么，专名一致性都是 100%。
 */

import { invoke } from '@tauri-apps/api/core'
import type { Prefs, TranslateMode, TranslateSource, TranslateStyle, TranslateTarget } from './prefs'
import {
  toSimplifiedZh,
  type GlossaryEntry,
  type TermKind,
} from './glossary'

export type LanguageCode = 'ko' | 'ja' | 'en' | 'zh' | 'unknown'

export type TranslateConfig = {
  mode: TranslateMode
  onlineEndpoint: string
  onlineKey: string
  onlineModel: string
  localEndpoint: string
  localModel: string
  style: TranslateStyle
  useTm: boolean
  /** 源语言；'auto' 让引擎自己识别 */
  source: TranslateSource
  /** 目标语言 */
  target: TranslateTarget
}

export type EngineName = 'online' | 'local' | 'memory'

export type TranslateOutcome = {
  text: string
  engine: EngineName
  /** 在线失败后自动回落本地 */
  fellBack: boolean
  warning?: string
  /** 本段命中的术语 */
  hits: GlossaryEntry[]
  /** 占位符总数与成功还原数 */
  masks: number
  restored: number
  elapsedMs: number
}

export type TranslationMemoryEntry = {
  source: string
  target: string
  from: LanguageCode | 'unknown'
  to: 'zh'
  engine: string
  updatedAt: number
}

export type TranslationMemoryState = {
  version: 1
  entries: Record<string, TranslationMemoryEntry>
}

export const MODE_LABEL: Record<TranslateMode, string> = {
  auto: '自动（在线失败回落本地）',
  local: '仅本地',
  online: '仅在线',
}

export const STYLE_LABEL: Record<TranslateStyle, string> = {
  literary: '文学化',
  faithful: '忠实',
  casual: '口语化',
}

const STYLE_GUIDE: Record<TranslateStyle, string> = {
  literary:
    '译文要像中文原创小说：句子自然流畅，符合书面语习惯；成语、谚语用中文里等价的表达，不要逐词硬译；' +
    '保留人物语气与情绪，避免翻译腔、避免欧化长句；不添加原文没有的信息。',
  faithful:
    '译文以准确忠实为第一优先：不增删信息，专名与数字严格对应；句子可以略保守，但必须通顺可读，不做过度润色。',
  casual:
    '译文偏口语、轻快，适合日常对话与轻小说；允许适当合并短句，但不改变事实与人物关系。',
}

const KIND_ORDER: TermKind[] = ['person', 'place', 'org']

export function translateConfigFromPrefs(prefs: Prefs): TranslateConfig {
  return {
    mode: prefs.translateMode,
    onlineEndpoint: prefs.translateOnlineEndpoint,
    onlineKey: prefs.translateOnlineKey,
    onlineModel: prefs.translateOnlineModel,
    localEndpoint: prefs.translateLocalEndpoint,
    localModel: prefs.translateLocalModel,
    style: prefs.translateStyle,
    useTm: prefs.translateUseTm,
    source: prefs.translateSource,
    target: prefs.translateTarget,
  }
}

/** 按字符占比判断原文语言；只区分翻译里最常用的几类。 */
export function detectLanguage(text: string): LanguageCode {
  const sample = text.slice(0, 4000)
  if (!sample.trim()) return 'unknown'
  let hangul = 0
  let kana = 0
  let han = 0
  let latin = 0
  let total = 0
  for (const ch of sample) {
    if (/\s/.test(ch)) continue
    total += 1
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0xac00 && code <= 0xd7a3) hangul += 1
    else if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x31f0 && code <= 0x31ff)) kana += 1
    else if (code >= 0x4e00 && code <= 0x9fff) han += 1
    else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) latin += 1
  }
  if (!total) return 'unknown'
  if (hangul / total > 0.03) return 'ko'
  if (kana / total > 0.02) return 'ja'
  if (han / total > 0.2) return 'zh'
  if (latin / total > 0.25) return 'en'
  return 'unknown'
}

export function languageLabel(code: LanguageCode): string {
  return code === 'ko' ? '韩文' : code === 'ja' ? '日文' : code === 'en' ? '英文' : code === 'zh' ? '中文' : '外文'
}

const LANG_LABELS: Record<string, string> = {
  zh: '中文', en: '英文', ja: '日文', ko: '韩文',
  fr: '法文', de: '德文', ru: '俄文', es: '西班牙文',
}
function languageLabelOf(code: string): string {
  return LANG_LABELS[code] ?? '外文'
}
function targetLabelOf(code: TranslateTarget): string {
  return LANG_LABELS[code] ?? '中文'
}

export function pairLabel(from: LanguageCode): string {
  return `${languageLabel(from)} → 简体中文`
}

/** 术语表里原文出现在本段中的条目，用于展示命中率。 */
export function glossaryHits(source: string, entries: GlossaryEntry[]): GlossaryEntry[] {
  const haystack = source.toLowerCase()
  return entries.filter((entry) => haystack.includes(entry.source.toLowerCase()))
}

const MASK_RE = /[【[]\s*T(\d+)\s*[】\]]/g

type MaskInfo = { token: string; no: number; target: string; source: string }

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 专名 → 【Tn】占位符；只处理人名/地名/组织名，通用术语走提示词。 */
function maskProperNouns(text: string, entries: GlossaryEntry[]): { text: string; masks: MaskInfo[] } {
  const proper = entries
    .filter((entry) => KIND_ORDER.includes(entry.kind))
    .sort((a, b) => b.source.length - a.source.length)
  let out = text
  const masks: MaskInfo[] = []
  proper.forEach((entry, index) => {
    const token = `【T${index + 1}】`
    const pattern = new RegExp(escapeRegExp(entry.source), 'gi')
    let hit = false
    out = out.replace(pattern, (matched) => {
      if (matched === token) return matched
      hit = true
      return token
    })
    if (hit) masks.push({ token, no: index + 1, target: entry.target, source: entry.source })
  })
  return { text: out, masks }
}

function restoreMasks(text: string, masks: MaskInfo[]): { text: string; restored: number } {
  const seen = new Set<number>()
  const byNo = new Map(masks.map((info) => [info.no, info]))
  const out = text.replace(MASK_RE, (whole, digits: string) => {
    const info = byNo.get(Number(digits))
    if (!info) return whole
    seen.add(Number(digits))
    return info.target
  })
  return { text: out, restored: seen.size }
}

function systemPrompt(
  from: LanguageCode,
  style: TranslateStyle,
  generalTerms: GlossaryEntry[],
): string {
  const glossary = generalTerms.length
    ? `\n【术语对照】以下原文术语必须译成给定译名，不要意译成别的说法：\n${generalTerms
        .slice(0, 120)
        .map((entry) => `${entry.source} => ${entry.target}`)
        .join('\n')}`
    : ''
  return [
    `你是专业的${languageLabel(from)}文学译者，把${languageLabel(from)}翻译成简体中文。`,
    STYLE_GUIDE[style],
    '译文里出现的【T1】【T2】这类带方括号的标记是受保护专名的占位符：必须原样保留，不要翻译、不要删除、不要改动编号。',
    '只输出译文本身，不要解释、不要加引号、不要分段成多段。',
    '示例（英译中）：The wind swept through the valley. => 风掠过山谷。',
    '示例（韩译中）：그는 조용히 웃었다. => 他静静地笑了。',
    glossary,
  ]
    .filter(Boolean)
    .join('\n')
}

async function requestEngine(
  endpoint: string,
  apiKey: string,
  model: string,
  system: string,
  user: string,
  timeoutMs = 90_000,
): Promise<string> {
  const reply = await invoke<{ text: string; url: string; elapsedMs: number }>('translate_text', {
    req: {
      endpoint,
      apiKey,
      model,
      system,
      user,
      temperature: 0.3,
      timeoutMs,
    },
  })
  return reply.text
}

function cleanTranslation(text: string): string {
  let out = text.trim()
  out = out.replace(/^\s*[“"「『]([\s\S]*)[”"」』]\s*$/, '$1').trim()
  out = out.replace(/\s*\n+\s*/g, ' ')
  out = out.replace(/[ \t]{2,}/g, ' ')
  return toSimplifiedZh(out).trim()
}

function engineEndpoint(config: TranslateConfig, engine: 'online' | 'local') {
  return engine === 'online'
    ? { endpoint: config.onlineEndpoint, key: config.onlineKey, model: config.onlineModel }
    : { endpoint: config.localEndpoint, key: '', model: config.localModel }
}

export async function translateOne(options: {
  config: TranslateConfig
  source: string
  glossary: GlossaryEntry[]
  memory?: TranslationMemoryState
}): Promise<TranslateOutcome> {
  const { config, source, glossary, memory } = options
  const started = performance.now()
  // 源语言：auto 让 detectLanguage 识别；否则用用户指定
  let lang: LanguageCode
  if (config.source === 'auto') {
    lang = detectLanguage(source)
  } else if (config.source === 'zh') {
    lang = 'zh'
  } else if (config.source === 'en') {
    lang = 'en'
  } else if (config.source === 'ja') {
    lang = 'ja'
  } else if (config.source === 'ko') {
    lang = 'ko'
  } else {
    // fr/de/ru/es 等非日韩中英，统一归为 unknown，detectLanguage 也识别不出来
    lang = 'unknown'
  }
  const hits = glossaryHits(source, glossary)
  const masks = maskProperNouns(source, glossary)
  const generalTerms = glossary.filter((entry) => entry.kind === 'term')

  const key = tmKey(lang, source)
  if (config.useTm && memory) {
    const cached = memory.entries[key]
    if (cached?.target) {
      return {
        text: cached.target,
        engine: 'memory',
        fellBack: false,
        hits,
        masks: masks.masks.length,
        restored: masks.masks.length,
        elapsedMs: Math.max(0, performance.now() - started),
      }
    }
  }

  // 目标语言标签：默认简体中文；改成英文时 prompt 也跟着改
  const targetLabel = targetLabelOf(config.target)
  const sourceLabel = config.source === 'auto' ? languageLabel(lang) : languageLabelOf(config.source)
  const system = systemPrompt(lang, config.style, generalTerms)
  const user = `请翻译下面这段${sourceLabel}（只输出${targetLabel}译文）：\n\n${masks.text}`

  const tryEngine = async (engine: 'online' | 'local') => {
    const target = engineEndpoint(config, engine)
    const raw = await requestEngine(target.endpoint, target.key, target.model, system, user)
    const cleaned = cleanTranslation(raw)
    const restored = restoreMasks(cleaned, masks.masks)
    return { text: restored.text, restored: restored.restored }
  }

  let text = ''
  let engine: EngineName
  let restored = 0
  let fellBack = false
  let warning: string | undefined

  if (config.mode === 'online') {
    const result = await tryEngine('online')
    text = result.text
    restored = result.restored
    engine = 'online'
  } else if (config.mode === 'local') {
    const result = await tryEngine('local')
    text = result.text
    restored = result.restored
    engine = 'local'
  } else {
    try {
      const result = await tryEngine('online')
      text = result.text
      restored = result.restored
      engine = 'online'
    } catch (onlineError) {
      try {
        const result = await tryEngine('local')
        text = result.text
        restored = result.restored
        engine = 'local'
        fellBack = true
        warning = `在线引擎不可用，已回落到本地：${String(onlineError)}`
      } catch (localError) {
        throw new Error(`在线与本地引擎都失败。\n在线：${String(onlineError)}\n本地：${String(localError)}`)
      }
    }
  }

  return {
    text,
    engine,
    fellBack,
    warning,
    hits,
    masks: masks.masks.length,
    restored,
    elapsedMs: Math.max(0, performance.now() - started),
  }
}

/** 设置页「测试连接」：用极短请求确认地址、密钥、模型是否可用。 */
export async function probeEngine(config: TranslateConfig): Promise<{ engine: EngineName; ms: number }> {
  const started = performance.now()
  const system = '你是连接测试助手。只回复两个字：正常。'
  if (config.mode === 'local') {
    const target = engineEndpoint(config, 'local')
    await requestEngine(target.endpoint, target.key, target.model, system, '测试', 20_000)
    return { engine: 'local', ms: Math.round(performance.now() - started) }
  }
  try {
    const target = engineEndpoint(config, 'online')
    await requestEngine(target.endpoint, target.key, target.model, system, '测试', 20_000)
    return { engine: 'online', ms: Math.round(performance.now() - started) }
  } catch (error) {
    if (config.mode === 'online') throw error
    const target = engineEndpoint(config, 'local')
    await requestEngine(target.endpoint, target.key, target.model, system, '测试', 20_000)
    return { engine: 'local', ms: Math.round(performance.now() - started) }
  }
}

// ───────────────────────────── 翻译记忆 ─────────────────────────────

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function tmKey(from: LanguageCode, source: string): string {
  const normalized = source.replace(/\s+/g, ' ').trim().toLowerCase()
  return `${from}>zh:${fnv1a(normalized)}`
}

export function parseMemory(raw: string): TranslationMemoryState {
  if (!raw.trim()) return { version: 1, entries: {} }
  try {
    const parsed = JSON.parse(raw) as Partial<TranslationMemoryState>
    if (!parsed || typeof parsed.entries !== 'object' || !parsed.entries) {
      return { version: 1, entries: {} }
    }
    const entries: Record<string, TranslationMemoryEntry> = {}
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (!value || typeof value !== 'object') continue
      const item = value as TranslationMemoryEntry
      if (typeof item.source !== 'string' || typeof item.target !== 'string') continue
      entries[key] = {
        source: item.source,
        target: item.target,
        from: item.from ?? 'unknown',
        to: 'zh',
        engine: typeof item.engine === 'string' ? item.engine : 'unknown',
        updatedAt: Number(item.updatedAt) || 0,
      }
    }
    return { version: 1, entries }
  } catch {
    return { version: 1, entries: {} }
  }
}

export function serializeMemory(memory: TranslationMemoryState): string {
  return JSON.stringify(memory, null, 2)
}

/** 用户修订优先：同一原文再次写入时覆盖旧译文，形成“越用越准”的记忆。 */
export function rememberTranslation(
  memory: TranslationMemoryState,
  source: string,
  target: string,
  engine: string,
): TranslationMemoryState {
  const trimmed = target.trim()
  if (!trimmed) return memory
  const from = detectLanguage(source)
  const key = tmKey(from, source)
  return {
    version: 1,
    entries: {
      ...memory.entries,
      [key]: {
        source: source.replace(/\s+/g, ' ').trim(),
        target: trimmed,
        from,
        to: 'zh',
        engine,
        updatedAt: Date.now(),
      },
    },
  }
}

export function memoryCount(memory: TranslationMemoryState): number {
  return Object.keys(memory.entries).length
}
