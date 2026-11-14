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
import type { Prefs, TranslateBackend, TranslateMode, TranslateSource, TranslateStyle, TranslateTarget } from './prefs'
import {
  toSimplifiedZh,
  type GlossaryEntry,
  type TermKind,
} from './glossary'

export type LanguageCode = 'ko' | 'ja' | 'en' | 'zh' | 'unknown'

export type TranslateConfig = {
  mode: TranslateMode
  backend: TranslateBackend
  /** 内置离线模型目录；空表示用应用数据目录 */
  modelDir: string
  onlineEndpoint: string
  onlineKey: string
  onlineModel: string
  /** 百度翻译开放平台：APP ID 与密钥（通用文本翻译） */
  baiduAppId: string
  baiduKey: string
  localEndpoint: string
  localModel: string
  style: TranslateStyle
  useTm: boolean
  /** 源语言；'auto' 让引擎自己识别 */
  source: TranslateSource
  /** 目标语言 */
  target: TranslateTarget
}

export type EngineName = 'online' | 'local' | 'builtin' | 'baidu' | 'baiduLlm' | 'memory'

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
  /** 译文语言：记忆按「源语言 + 目标语言」分开，改目标语言不会命中旧译文 */
  to: TranslateTarget
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
  baidu: '百度翻译',
  baiduLlm: '百度大模型',
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
    backend: prefs.translateBackend,
    modelDir: prefs.translateModelDir,
    onlineEndpoint: prefs.translateOnlineEndpoint,
    onlineKey: prefs.translateOnlineKey,
    onlineModel: prefs.translateOnlineModel,
    baiduAppId: prefs.translateBaiduAppId,
    baiduKey: prefs.translateBaiduKey,
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

/** 百度翻译语言代码；覆盖设置里可选的 8 种语言。 */
const BAIDU_LANGS: Record<string, string> = {
  zh: 'zh',
  en: 'en',
  ja: 'jp',
  ko: 'kor',
  fr: 'fra',
  de: 'de',
  ru: 'ru',
  es: 'spa',
}

function baiduLangOf(code: string): string {
  return BAIDU_LANGS[code] ?? 'auto'
}

/** 百度通用翻译单次上限约 6000 字节；留出余量按 4500 字节切句。 */
const BAIDU_MAX_BYTES = 4500
/** 免费额度下 QPS=1，两次请求之间留 1.1 秒。 */
const BAIDU_GAP_MS = 1100

function charBytes(code: number): number {
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
}

/** 超长段落按句读切成多段，避免触发 54005（长 query 请求频繁）。 */
function splitBaiduText(text: string): string[] {
  const encoder = new TextEncoder()
  if (encoder.encode(text).length <= BAIDU_MAX_BYTES) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest) {
    if (encoder.encode(rest).length <= BAIDU_MAX_BYTES) {
      chunks.push(rest)
      break
    }
    let bytes = 0
    let end = 0
    let soft = 0
    for (const ch of rest) {
      const size = charBytes(ch.codePointAt(0) ?? 0)
      if (bytes + size > BAIDU_MAX_BYTES) break
      bytes += size
      end += ch.length
      if (/[。！？!?…；;，,、\n\s]/.test(ch)) soft = end
    }
    // 软断点太靠前就不采用，避免切出很碎的句子
    const cut = soft > 0 && soft >= end * 0.5 ? soft : end
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  return chunks
}

/** 两个百度接口共用同一套 APP ID + 密钥，但 QPS 不同，各自排队。 */
function makeBaiduScheduler(gapMs: number) {
  let queue: Promise<unknown> = Promise.resolve()
  let lastAt = 0
  return function schedule<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      const wait = lastAt + gapMs - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      try {
        return await task()
      } finally {
        lastAt = Date.now()
      }
    })
    queue = run.catch(() => undefined)
    return run
  }
}

/** 通用版 QPS=1；大模型版 QPS=10，留 120ms 间隔。 */
const scheduleBaidu = makeBaiduScheduler(1100)
const scheduleBaiduLlm = makeBaiduScheduler(120)

type BaiduReply = {
  text: string
  items: string[]
  from: string
  to: string
  elapsedMs: number
}

function baiduCredentials(config: TranslateConfig) {
  const appId = config.baiduAppId.trim()
  const key = config.baiduKey.trim()
  if (!appId || !key) {
    throw new Error('还没有填写百度翻译的 APP ID 或密钥：请到 设置 → 功能 → 翻译 → 百度翻译 里补上')
  }
  return { appId, key }
}

async function requestBaidu(
  config: TranslateConfig,
  text: string,
  from: string,
  to: string,
): Promise<BaiduReply> {
  const { appId, key } = baiduCredentials(config)
  return scheduleBaidu(() =>
    invoke<BaiduReply>('baidu_translate', {
      req: { appId, key, q: text, from, to, timeoutMs: 30_000 },
    }),
  )
}

async function requestBaiduLlm(
  config: TranslateConfig,
  text: string,
  from: string,
  to: string,
  reference: string,
): Promise<BaiduReply> {
  const { appId, key } = baiduCredentials(config)
  return scheduleBaiduLlm(() =>
    invoke<BaiduReply>('baidu_llm_translate', {
      req: { appId, key, q: text, from, to, reference: reference || null, timeoutMs: 60_000 },
    }),
  )
}

/** 54003/54005/52001 属于频率或瞬时故障，退避重试两次。 */
async function retryBaidu<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task()
    } catch (error) {
      const message = String(error)
      const retryable = message.includes('54003') || message.includes('54005') || message.includes('52001')
      if (!retryable || attempt >= 2) throw error
      await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
    }
  }
}

function requestBaiduWithRetry(
  config: TranslateConfig,
  text: string,
  from: string,
  to: string,
): Promise<BaiduReply> {
  return retryBaidu(() => requestBaidu(config, text, from, to))
}

function requestBaiduLlmWithRetry(
  config: TranslateConfig,
  text: string,
  from: string,
  to: string,
  reference: string,
): Promise<BaiduReply> {
  return retryBaidu(() => requestBaiduLlm(config, text, from, to, reference))
}

/** 内置离线模型支持的语言；与 Rust 端 nmt.rs 的 nllb_lang 保持一致。 */
const BUILTIN_LANGS = ['ja', 'ko', 'en', 'zh'] as const

async function requestBuiltin(
  source: string,
  target: string,
  text: string,
  modelDir: string,
): Promise<string> {
  if (!BUILTIN_LANGS.includes(source as (typeof BUILTIN_LANGS)[number])) {
    throw new Error(`内置引擎无法识别源语言（${source}）。请到 设置 → 功能 → 翻译 → 源语言 里手动指定。`)
  }
  if (!BUILTIN_LANGS.includes(target as (typeof BUILTIN_LANGS)[number])) {
    throw new Error(`内置引擎暂不支持目标语言 ${target}，请在设置里改回中文/英文/日文/韩文。`)
  }
  const reply = await invoke<{ text: string; model: string; elapsedMs: number }>('nmt_translate', {
    text,
    source,
    target,
    dir: modelDir || null,
  })
  if (!reply.text?.trim()) throw new Error('内置引擎返回了空译文')
  return reply.text
}

function cleanTranslation(text: string): string {
  let out = text.trim()
  out = out.replace(/^\s*[“"「『]([\s\S]*)[”"」』]\s*$/, '$1').trim()
  out = out.replace(/\s*\n+\s*/g, ' ')
  out = out.replace(/[ \t]{2,}/g, ' ')
  return toSimplifiedZh(out).trim()
}

/**
 * 百度大模型版的翻译指令（reference）。
 * 通用版接口不支持提示词，只有大模型版能把风格、术语和排版约束带进去。
 */
export function baiduReference(
  from: LanguageCode,
  target: TranslateTarget,
  style: TranslateStyle,
  generalTerms: GlossaryEntry[],
): string {
  const lines = [
    `把下面的${languageLabel(from)}文字翻译成${targetLabelOf(target)}：先通读整段理解语境，再逐行输出译文。`,
    STYLE_GUIDE[style],
    '每输入一行必须对应输出一行：不要合并、不要拆行、不要加序号、不要插空行。',
    '【T1】【T2】这类带方括号的编号是受保护专名的占位符：原样保留，不翻译、不删除、不改编号。',
    '原文括号里的中文汉字是作者注释：保留括号和注释内容，只把繁体字转成简体字。',
  ]
  if (generalTerms.length) {
    lines.push(
      '【术语对照】原文 => 必须使用的译名：\n' +
        generalTerms
          .slice(0, 60)
          .map((entry) => `${entry.source} => ${entry.target}`)
          .join('\n'),
    )
  }
  return lines.join('\n')
}

/** 还原占位符后统一再过一次繁→简，术语表与模型输出里的繁体都不会漏掉。 */
function finishTranslation(text: string, masks: MaskInfo[]) {
  const restored = restoreMasks(text, masks)
  return { text: toSimplifiedZh(restored.text).trim(), restored: restored.restored }
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

  const key = tmKey(lang, source, config.target)
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
    return finishTranslation(cleanTranslation(raw), masks.masks)
  }

  // 内置离线引擎：直接吃原文，不走 HTTP；专名占位符同样生效
  const tryBuiltin = async () => {
    const source = config.source === 'auto' ? lang : config.source
    const raw = await requestBuiltin(source, config.target, masks.text, config.modelDir)
    return finishTranslation(cleanTranslation(raw), masks.masks)
  }
  // 百度通用翻译：不支持提示词，专名占位符仍然有效
  const tryBaidu = async () => {
    const from = config.source === 'auto' ? 'auto' : baiduLangOf(config.source)
    const to = baiduLangOf(config.target)
    const parts: string[] = []
    for (const piece of splitBaiduText(masks.text)) {
      const reply = await requestBaiduWithRetry(config, piece, from, to)
      parts.push(reply.text)
    }
    const joiner = ['zh', 'ja', 'ko'].includes(config.target) ? '' : ' '
    return finishTranslation(cleanTranslation(parts.join(joiner)), masks.masks)
  }
  // 百度大模型翻译：可带翻译指令（风格 + 术语表），单次上限 6000 字符
  const tryBaiduLlm = async () => {
    const from = config.source === 'auto' ? 'auto' : baiduLangOf(config.source)
    const to = baiduLangOf(config.target)
    const reference = baiduReference(lang, config.target, config.style, generalTerms)
    const reply = await requestBaiduLlmWithRetry(config, masks.text, from, to, reference)
    return finishTranslation(cleanTranslation(reply.text), masks.masks)
  }
  const useBuiltin =
    config.backend === 'builtin' && config.mode !== 'online' && config.mode !== 'baidu' && config.mode !== 'baiduLlm'

  let text = ''
  let engine: EngineName
  let restored = 0
  let fellBack = false
  let warning: string | undefined

  if (config.mode === 'baidu') {
    const result = await tryBaidu()
    text = result.text
    restored = result.restored
    engine = 'baidu'
  } else if (config.mode === 'baiduLlm') {
    const result = await tryBaiduLlm()
    text = result.text
    restored = result.restored
    engine = 'baiduLlm'
  } else if (config.mode === 'online') {
    const result = await tryEngine('online')
    text = result.text
    restored = result.restored
    engine = 'online'
  } else if (config.mode === 'local') {
    const result = useBuiltin ? await tryBuiltin() : await tryEngine('local')
    text = result.text
    restored = result.restored
    engine = useBuiltin ? 'builtin' : 'local'
  } else if (useBuiltin) {
    try {
      const result = await tryBuiltin()
      text = result.text
      restored = result.restored
      engine = 'builtin'
    } catch (builtinError) {
      try {
        const result = await tryEngine('online')
        text = result.text
        restored = result.restored
        engine = 'online'
        fellBack = true
        warning = `内置引擎不可用，已回落到在线：${String(builtinError)}`
      } catch (onlineError) {
        const result = await tryEngine('local')
        text = result.text
        restored = result.restored
        engine = 'local'
        fellBack = true
        warning = `内置引擎不可用，已回落到本地 HTTP：${String(builtinError)}`
        void onlineError
      }
    }
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

/**
 * E：AI 润色——只改译文表达，不改原意；结果由人工确认后写进锻造草稿。
 * 内置 NLLB 是翻译模型，不能润色，需要在线 / 本地 LLM。
 */
export async function polishOne(options: {
  config: TranslateConfig
  text: string
  source?: string
}): Promise<{ text: string; engine: EngineName; elapsedMs: number }> {
  const { config, text, source } = options
  const body = text.trim()
  if (!body) throw new Error('这段还没有译文，先翻译或手工录入再润色')
  const started = performance.now()
  const style = STYLE_GUIDE[config.style]
  const system = [
    '你是资深中文文学编辑。请在保持原意、人名地名与【T1】【T2】这类方括号占位符不变的前提下，',
    '润色下面这段译文：让语句更自然、节奏更顺、书面表达更地道，不要扩写、不要删改情节。',
    style,
    source ? '原文只用于核对语义，不要照搬原文措辞。' : '',
    '只输出润色后的正文，不要解释、不要加引号、不要分段成多段。',
  ]
    .filter(Boolean)
    .join('\n')
  const user = source
    ? `【译文】\n${body}\n\n【原文】\n${source}`
    : `【译文】\n${body}`

  const runLlm = async (engine: 'online' | 'local') => {
    const target = engineEndpoint(config, engine)
    const raw = await requestEngine(target.endpoint, target.key, target.model, system, user)
    return toSimplifiedZh(raw.trim())
  }

  if (config.mode === 'baidu' || config.mode === 'baiduLlm') {
    throw new Error('百度翻译只做翻译，不能润色；请到 设置 → 功能 → 翻译 里切到在线或本地 LLM')
  }
  if (config.backend === 'builtin' && config.mode !== 'online') {
    throw new Error('内置离线模型只做翻译，不能润色；请到 设置 → 功能 → 翻译 里切到在线或本地 LLM')
  }
  let polished = ''
  let engine: EngineName = 'online'
  if (config.mode === 'local') {
    polished = await runLlm('local')
    engine = 'local'
  } else if (config.mode === 'online') {
    polished = await runLlm('online')
  } else {
    try {
      polished = await runLlm('online')
    } catch (onlineError) {
      polished = await runLlm('local')
      engine = 'local'
      void onlineError
    }
  }
  const cleaned = polished.replace(/^\s*[“"「『]([\s\S]*)[”"」』]\s*$/, '$1').trim()
  return { text: cleaned, engine, elapsedMs: Math.max(0, performance.now() - started) }
}

/** 设置页「测试连接」：用极短请求确认地址、密钥、模型是否可用。 */
export async function probeEngine(config: TranslateConfig): Promise<{ engine: EngineName; ms: number }> {
  const started = performance.now()
  if (config.mode === 'baidu') {
    await requestBaiduWithRetry(config, 'This is a test.', 'en', 'zh')
    return { engine: 'baidu', ms: Math.round(performance.now() - started) }
  }
  if (config.mode === 'baiduLlm') {
    await requestBaiduLlmWithRetry(config, 'This is a test.', 'en', 'zh', '')
    return { engine: 'baiduLlm', ms: Math.round(performance.now() - started) }
  }
  if (config.backend === 'builtin' && config.mode !== 'online') {
    const models = await invoke<Array<{ id: string; installed: boolean; dir: string }>>(
      'nmt_status',
      { dir: config.modelDir || null },
    )
    if (!models.some((model) => model.installed)) {
      throw new Error('内置离线模型尚未下载：请到 设置 → 功能 → 翻译 里点「下载离线模型」。')
    }
    await requestBuiltin('en', 'zh', 'This is a test.', config.modelDir)
    return { engine: 'builtin', ms: Math.round(performance.now() - started) }
  }
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

// ───────────────────────── 整章批量翻译（百度） ─────────────────────────

export type BatchBlock = { index: number; source: string }
export type BatchResult = { index: number; outcome: TranslateOutcome }

/** 大模型版单次建议 ≤2000 字符（接口硬上限 6000）。 */
const BAIDU_LLM_BATCH_CHARS = 2000
/** 通用版按字节算，留出余量避免 54005。 */
const BAIDU_BATCH_MAX_BYTES = 4200

type BatchEntry = {
  index: number
  source: string
  lang: LanguageCode
  hits: GlossaryEntry[]
  masked: string
  masks: MaskInfo[]
}

/**
 * 整章批量翻译：把同一章的多段合并成一次请求，让引擎看到上下文，
 * 再按「一行一段」把译文拆回去。只有百度两档走这里，其他引擎仍逐段翻。
 */
export async function translateBaiduBlocks(options: {
  config: TranslateConfig
  blocks: BatchBlock[]
  glossary: GlossaryEntry[]
  memory?: TranslationMemoryState
  onResult?: (result: BatchResult) => void
  isCancelled?: () => boolean
}): Promise<{ done: number; failed: number; cancelled: boolean }> {
  const { config, blocks, glossary, memory, onResult, isCancelled } = options
  const isLlm = config.mode === 'baiduLlm'
  const limit = isLlm ? BAIDU_LLM_BATCH_CHARS : BAIDU_BATCH_MAX_BYTES
  const encoder = new TextEncoder()
  const generalTerms = glossary.filter((entry) => entry.kind === 'term')
  let done = 0
  let failed = 0

  const entries: BatchEntry[] = []
  for (const block of blocks) {
    const source = String(block.source ?? '').replace(/\s*\n+\s*/g, ' ').trim()
    if (!source) continue
    // 源语言判定与 translateOne 保持一致
    const declared = config.source
    const lang: LanguageCode =
      declared === 'auto'
        ? detectLanguage(source)
        : declared === 'zh' || declared === 'en' || declared === 'ja' || declared === 'ko'
          ? declared
          : 'unknown'
    const hits = glossaryHits(source, glossary)
    const masks = maskProperNouns(source, glossary)

    if (config.useTm && memory) {
      const cached = memory.entries[tmKey(lang, source, config.target)]
      if (cached?.target) {
        done += 1
        onResult?.({
          index: block.index,
          outcome: {
            text: cached.target,
            engine: 'memory',
            fellBack: false,
            hits,
            masks: masks.masks.length,
            restored: masks.masks.length,
            elapsedMs: 0,
          },
        })
        continue
      }
    }
    entries.push({ index: block.index, source, lang, hits, masked: masks.text, masks: masks.masks })
  }

  if (!entries.length) return { done, failed, cancelled: false }

  const refLang = entries.find((entry) => entry.lang !== 'unknown')?.lang ?? 'unknown'
  const reference = isLlm
    ? baiduReference(refLang, config.target, config.style, generalTerms)
    : ''
  const from = config.source === 'auto' ? 'auto' : baiduLangOf(config.source)
  const to = baiduLangOf(config.target)

  // 按字数/字节聚批；单段超限就让它单独成批，稍后走逐段兜底
  const chunks: BatchEntry[][] = []
  let current: BatchEntry[] = []
  let size = 0
  for (const entry of entries) {
    const cost = isLlm ? entry.masked.length : encoder.encode(entry.masked).length
    if (current.length && size + cost > limit) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(entry)
    size += cost + 1
  }
  if (current.length) chunks.push(current)

  for (const chunk of chunks) {
    if (isCancelled?.()) return { done, failed, cancelled: true }
    const cost = chunk.reduce(
      (sum, entry) => sum + (isLlm ? entry.masked.length : encoder.encode(entry.masked).length),
      0,
    )
    let outcomes: TranslateOutcome[] | null = null

    if (cost <= limit) {
      const started = performance.now()
      try {
        const q = chunk.map((entry) => entry.masked).join('\n')
        const reply = isLlm
          ? await requestBaiduLlmWithRetry(config, q, from, to, reference)
          : await requestBaiduWithRetry(config, q, from, to)
        if (reply.items.length === chunk.length) {
          const elapsedMs = Math.max(0, performance.now() - started)
          const built = chunk.map<TranslateOutcome | null>((entry, position) => {
            const item = reply.items[position] ?? ''
            if (!item.trim()) return null
            const fin = finishTranslation(cleanTranslation(item), entry.masks)
            return {
              text: fin.text,
              engine: isLlm ? 'baiduLlm' : 'baidu',
              fellBack: false,
              hits: entry.hits,
              masks: entry.masks.length,
              restored: fin.restored,
              elapsedMs,
            }
          })
          if (built.every((item): item is TranslateOutcome => Boolean(item))) {
            outcomes = built
          }
        }
      } catch {
        // 整批失败 → 下面逐段兜底，单段错误不会毁掉整章
        outcomes = null
      }
    }

    if (outcomes) {
      chunk.forEach((entry, position) => {
        done += 1
        onResult?.({ index: entry.index, outcome: outcomes![position]! })
      })
      continue
    }

    // 兜底：逐段调用，保留原有错误语义
    for (const entry of chunk) {
      if (isCancelled?.()) return { done, failed, cancelled: true }
      try {
        const outcome = await translateOne({ config, source: entry.source, glossary, memory })
        done += 1
        onResult?.({ index: entry.index, outcome })
      } catch {
        failed += 1
      }
    }
  }

  return { done, failed, cancelled: false }
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

export function tmKey(from: LanguageCode, source: string, to: TranslateTarget = 'zh'): string {
  const normalized = source.replace(/\s+/g, ' ').trim().toLowerCase()
  // 默认目标中文时键格式与旧版一致，历史记忆继续可用
  return `${from}>${to}:${fnv1a(normalized)}`
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
        to: typeof item.to === 'string' ? (item.to as TranslateTarget) : 'zh',
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
  to: TranslateTarget = 'zh',
): TranslationMemoryState {
  const trimmed = target.trim()
  if (!trimmed) return memory
  const from = detectLanguage(source)
  const key = tmKey(from, source, to)
  return {
    version: 1,
    entries: {
      ...memory.entries,
      [key]: {
        source: source.replace(/\s+/g, ' ').trim(),
        target: trimmed,
        from,
        to,
        engine,
        updatedAt: Date.now(),
      },
    },
  }
}

export function memoryCount(memory: TranslationMemoryState): number {
  return Object.keys(memory.entries).length
}
