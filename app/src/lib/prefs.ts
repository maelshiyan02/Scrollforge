/** 设备级偏好：不属于书库设置，只存在本机。设置页「功能」与阅读/书架/编辑器共用。 */

export type ReaderFlow = 'paginated' | 'scrolled'
export type ShelfView = 'grid' | 'list' | 'shelf3d'
export type ShelfSort = 'recent' | 'imported' | 'title'
export type ConvertPreset = 'zh-serif' | 'en-serif' | 'minimal'
export type TranslateMode = 'auto' | 'local' | 'online'
export type TranslateStyle = 'literary' | 'faithful' | 'casual'
export type TranslateSource = 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'ru' | 'es'
export type TranslateTarget = 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'ru' | 'es'

export type Prefs = {
  /** 打开图书时默认翻页方式 */
  readerFlow: ReaderFlow
  /** 打开图书时默认双页 */
  readerDoublePage: boolean
  /** 打开图书时默认竖排（右→左） */
  readerVertical: boolean
  /** 书架默认视图 */
  shelfView: ShelfView
  /** 书架默认排序 */
  shelfSort: ShelfSort
  /** 编辑器段落预览字号 */
  editorBlockFont: number
  /** 编辑器源码字号 */
  editorSrcFont: number
  /** 源码停顿 700ms 后自动重建预览 */
  editorAutoRebuild: boolean
  /** 保存并重打包时生成 revision */
  editorCreateRevision: boolean
  /** 新建书默认样式预设 */
  convertPreset: ConvertPreset
  /** 转换向导默认首行缩进 */
  convertIndent: boolean
  /** 转换向导默认章节标题居中 */
  convertCenterHeading: boolean
  /** 固定版式下 Ctrl+滚轮缩放 */
  experimentalFixedWheelZoom: boolean
  /** 翻译引擎模式：自动（在线失败回落本地）/ 仅本地 / 仅在线 */
  translateMode: TranslateMode
  /** 在线引擎：OpenAI 兼容接口地址 */
  translateOnlineEndpoint: string
  /** 在线引擎：API Key（只存本机） */
  translateOnlineKey: string
  /** 在线引擎：模型名 */
  translateOnlineModel: string
  /** 本地引擎：Ollama / LM Studio 等兼容接口地址 */
  translateLocalEndpoint: string
  /** 本地引擎：模型名 */
  translateLocalModel: string
  /** 英译中 / 韩译中的风格指南 */
  translateStyle: TranslateStyle
  /** 命中翻译记忆时直接复用，不再请求引擎 */
  translateUseTm: boolean
  /** 源语言（auto 让引擎自己识别；非 auto 强制指定） */
  translateSource: TranslateSource
  /** 目标语言（默认 zh；可改成 en 等） */
  translateTarget: TranslateTarget
}

export const DEFAULT_PREFS: Prefs = {
  readerFlow: 'paginated',
  readerDoublePage: false,
  readerVertical: false,
  shelfView: 'grid',
  shelfSort: 'recent',
  editorBlockFont: 15,
  editorSrcFont: 12,
  editorAutoRebuild: true,
  editorCreateRevision: true,
  convertPreset: 'zh-serif',
  convertIndent: true,
  convertCenterHeading: true,
  experimentalFixedWheelZoom: true,
  translateMode: 'auto',
  translateOnlineEndpoint: 'https://api.deepseek.com/v1',
  translateOnlineKey: '',
  translateOnlineModel: 'deepseek-chat',
  translateLocalEndpoint: 'http://127.0.0.1:11434/v1',
  translateLocalModel: 'qwen2.5:7b',
  translateStyle: 'literary',
  translateUseTm: true,
  translateSource: 'auto',
  translateTarget: 'zh',
}

const KEY = 'scrollforge:prefs'
const LEGACY_SHELF = 'scrollforge:shelf'

const SHELF_VIEWS: ShelfView[] = ['grid', 'list', 'shelf3d']
const SHELF_SORTS: ShelfSort[] = ['recent', 'imported', 'title']
const READER_FLOWS: ReaderFlow[] = ['paginated', 'scrolled']
const PRESETS: ConvertPreset[] = ['zh-serif', 'en-serif', 'minimal']
const TRANSLATE_MODES: TranslateMode[] = ['auto', 'local', 'online']
const TRANSLATE_STYLES: TranslateStyle[] = ['literary', 'faithful', 'casual']
const TRANSLATE_SOURCES: TranslateSource[] = ['auto', 'zh', 'en', 'ja', 'ko', 'fr', 'de', 'ru', 'es']
const TRANSLATE_TARGETS: TranslateTarget[] = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'ru', 'es']

function pickString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Prefs>
      return {
        readerFlow: pick(parsed.readerFlow, READER_FLOWS, DEFAULT_PREFS.readerFlow),
        readerDoublePage: Boolean(parsed.readerDoublePage),
        readerVertical: Boolean(parsed.readerVertical),
        shelfView: pick(parsed.shelfView, SHELF_VIEWS, DEFAULT_PREFS.shelfView),
        shelfSort: pick(parsed.shelfSort, SHELF_SORTS, DEFAULT_PREFS.shelfSort),
        editorBlockFont: clampNumber(parsed.editorBlockFont, 11, 34, DEFAULT_PREFS.editorBlockFont),
        editorSrcFont: clampNumber(parsed.editorSrcFont, 9, 28, DEFAULT_PREFS.editorSrcFont),
        editorAutoRebuild: parsed.editorAutoRebuild !== false,
        editorCreateRevision: parsed.editorCreateRevision !== false,
        convertPreset: pick(parsed.convertPreset, PRESETS, DEFAULT_PREFS.convertPreset),
        convertIndent: parsed.convertIndent !== false,
        convertCenterHeading: parsed.convertCenterHeading !== false,
        experimentalFixedWheelZoom: parsed.experimentalFixedWheelZoom !== false,
        translateMode: pick(parsed.translateMode, TRANSLATE_MODES, DEFAULT_PREFS.translateMode),
        translateOnlineEndpoint: pickString(parsed.translateOnlineEndpoint, DEFAULT_PREFS.translateOnlineEndpoint),
        translateOnlineKey: pickString(parsed.translateOnlineKey, ''),
        translateOnlineModel: pickString(parsed.translateOnlineModel, DEFAULT_PREFS.translateOnlineModel),
        translateLocalEndpoint: pickString(parsed.translateLocalEndpoint, DEFAULT_PREFS.translateLocalEndpoint),
        translateLocalModel: pickString(parsed.translateLocalModel, DEFAULT_PREFS.translateLocalModel),
        translateStyle: pick(parsed.translateStyle, TRANSLATE_STYLES, DEFAULT_PREFS.translateStyle),
        translateUseTm: parsed.translateUseTm !== false,
        translateSource: pick(parsed.translateSource, TRANSLATE_SOURCES, DEFAULT_PREFS.translateSource),
        translateTarget: pick(parsed.translateTarget, TRANSLATE_TARGETS, DEFAULT_PREFS.translateTarget),
      }
    }
  } catch {
    // 落到旧键兜底
  }
  // R6 之前书架视图/排序存在 scrollforge:shelf:*，迁移到统一偏好
  try {
    const legacyView = localStorage.getItem(`${LEGACY_SHELF}:view`)
    const legacySort = localStorage.getItem(`${LEGACY_SHELF}:sort`)
    return {
      ...DEFAULT_PREFS,
      shelfView: pick(legacyView, SHELF_VIEWS, DEFAULT_PREFS.shelfView),
      shelfSort: pick(legacySort, SHELF_SORTS, DEFAULT_PREFS.shelfSort),
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function savePrefs(value: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(value))
  } catch {
    // 忽略
  }
}
