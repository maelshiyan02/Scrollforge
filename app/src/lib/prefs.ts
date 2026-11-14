/** 设备级偏好：不属于书库设置，只存在本机。设置页「功能」与阅读/书架/编辑器共用。 */

export type ReaderFlow = 'paginated' | 'scrolled'
export type ShelfView = 'grid' | 'list' | 'shelf3d'
export type ShelfSort = 'recent' | 'imported' | 'title'
/** 书架排序方向：asc 升序 / desc 降序 */
export type ShelfSortOrder = 'asc' | 'desc'
export type ConvertPreset = 'zh-serif' | 'en-serif' | 'minimal'
export type TranslateMode = 'auto' | 'local' | 'online' | 'baidu' | 'baiduLlm'
/** 本地引擎实现：builtin 内置 ONNX 模型；http 走 Ollama / LM Studio 等兼容接口 */
export type TranslateBackend = 'builtin' | 'http'
export type TranslateStyle = 'literary' | 'faithful' | 'casual'
export type TranslateSource = 'auto' | 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'ru' | 'es'
export type TranslateTarget = 'zh' | 'en' | 'ja' | 'ko' | 'fr' | 'de' | 'ru' | 'es'
/** 界面三档视觉：日间纸白 / 护眼绿纸面 / 夜间深灰 */
export type ThemeMode = 'day' | 'eye' | 'night'

export type Prefs = {
  /** 界面主题：day 日间 / eye 护眼 / night 夜间 */
  theme: ThemeMode
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
  /** 书架排序方向 */
  shelfSortOrder: ShelfSortOrder
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
  /** 翻译引擎模式：自动（在线失败回落本地）/ 仅本地 / 仅在线 / 百度翻译 / 百度大模型 */
  translateMode: TranslateMode
  /** 本地引擎实现：内置离线模型 / 本机 HTTP 服务 */
  translateBackend: TranslateBackend
  /** 内置离线模型存放目录；空则落到应用数据目录 */
  translateModelDir: string
  /** 在线引擎：OpenAI 兼容接口地址 */
  translateOnlineEndpoint: string
  /** 在线引擎：API Key（只存本机） */
  translateOnlineKey: string
  /** 在线引擎：模型名 */
  translateOnlineModel: string
  /** 百度翻译开放平台 APP ID */
  translateBaiduAppId: string
  /** 百度翻译开放平台密钥（只存本机） */
  translateBaiduKey: string
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
  theme: 'day',
  readerFlow: 'paginated',
  readerDoublePage: false,
  readerVertical: false,
  shelfView: 'grid',
  shelfSort: 'recent',
  shelfSortOrder: 'desc',
  editorBlockFont: 15,
  editorSrcFont: 12,
  editorAutoRebuild: true,
  editorCreateRevision: true,
  convertPreset: 'zh-serif',
  convertIndent: true,
  convertCenterHeading: true,
  experimentalFixedWheelZoom: true,
  translateMode: 'local',
  translateBackend: 'builtin',
  translateModelDir: 'D:\\AI Coding Project Management\\Scrollforge\\models',
  translateOnlineEndpoint: 'https://api.deepseek.com/v1',
  translateOnlineKey: '',
  translateOnlineModel: 'deepseek-chat',
  translateBaiduAppId: '',
  translateBaiduKey: '',
  translateLocalEndpoint: 'http://127.0.0.1:11434/v1',
  translateLocalModel: 'qwen2.5:7b',
  translateStyle: 'literary',
  translateUseTm: true,
  translateSource: 'auto',
  translateTarget: 'zh',
}

const KEY = 'scrollforge:prefs'
const LEGACY_SHELF = 'scrollforge:shelf'

const THEMES: ThemeMode[] = ['day', 'eye', 'night']
const THEME_LABEL: Record<ThemeMode, string> = { day: '日间', eye: '护眼', night: '夜间' }
const SHELF_VIEWS: ShelfView[] = ['grid', 'list', 'shelf3d']
const SHELF_SORTS: ShelfSort[] = ['recent', 'imported', 'title']
const SHELF_SORT_ORDERS: ShelfSortOrder[] = ['asc', 'desc']
const READER_FLOWS: ReaderFlow[] = ['paginated', 'scrolled']
const PRESETS: ConvertPreset[] = ['zh-serif', 'en-serif', 'minimal']
const TRANSLATE_MODES: TranslateMode[] = ['auto', 'local', 'online', 'baidu', 'baiduLlm']
const TRANSLATE_BACKENDS: TranslateBackend[] = ['builtin', 'http']
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
      const localEndpoint = pickString(parsed.translateLocalEndpoint, DEFAULT_PREFS.translateLocalEndpoint)
      const localModel = pickString(parsed.translateLocalModel, DEFAULT_PREFS.translateLocalModel)
      // 清掉历史调试残留：18081/18082 是临时测试端口，mock 是假模型，正常用户不会用到
      const staleLocal = /127\.0\.0\.1:1808[12]/.test(localEndpoint) || localModel.trim() === 'mock'
      return {
        theme: pick(parsed.theme, THEMES, DEFAULT_PREFS.theme),
        readerFlow: pick(parsed.readerFlow, READER_FLOWS, DEFAULT_PREFS.readerFlow),
        readerDoublePage: Boolean(parsed.readerDoublePage),
        readerVertical: Boolean(parsed.readerVertical),
        shelfView: pick(parsed.shelfView, SHELF_VIEWS, DEFAULT_PREFS.shelfView),
        shelfSort: pick(parsed.shelfSort, SHELF_SORTS, DEFAULT_PREFS.shelfSort),
        shelfSortOrder: pick(parsed.shelfSortOrder, SHELF_SORT_ORDERS, DEFAULT_PREFS.shelfSortOrder),
        editorBlockFont: clampNumber(parsed.editorBlockFont, 11, 34, DEFAULT_PREFS.editorBlockFont),
        editorSrcFont: clampNumber(parsed.editorSrcFont, 9, 28, DEFAULT_PREFS.editorSrcFont),
        editorAutoRebuild: parsed.editorAutoRebuild !== false,
        editorCreateRevision: parsed.editorCreateRevision !== false,
        convertPreset: pick(parsed.convertPreset, PRESETS, DEFAULT_PREFS.convertPreset),
        convertIndent: parsed.convertIndent !== false,
        convertCenterHeading: parsed.convertCenterHeading !== false,
        experimentalFixedWheelZoom: parsed.experimentalFixedWheelZoom !== false,
        translateMode: pick(parsed.translateMode, TRANSLATE_MODES, DEFAULT_PREFS.translateMode),
        translateBackend: pick(parsed.translateBackend, TRANSLATE_BACKENDS, DEFAULT_PREFS.translateBackend),
        translateModelDir: pickString(parsed.translateModelDir, DEFAULT_PREFS.translateModelDir),
        translateOnlineEndpoint: pickString(parsed.translateOnlineEndpoint, DEFAULT_PREFS.translateOnlineEndpoint),
        translateOnlineKey: pickString(parsed.translateOnlineKey, ''),
        translateOnlineModel: pickString(parsed.translateOnlineModel, DEFAULT_PREFS.translateOnlineModel),
        translateBaiduAppId: pickString(parsed.translateBaiduAppId, ''),
        translateBaiduKey: pickString(parsed.translateBaiduKey, ''),
        translateLocalEndpoint: staleLocal ? DEFAULT_PREFS.translateLocalEndpoint : localEndpoint,
        translateLocalModel: staleLocal ? DEFAULT_PREFS.translateLocalModel : localModel,
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

/** 顶栏按钮用：日间 → 护眼 → 夜间 → 日间 */
export function nextTheme(mode: ThemeMode): ThemeMode {
  const index = THEMES.indexOf(mode)
  return THEMES[(index + 1) % THEMES.length]
}

export function themeLabel(mode: ThemeMode): string {
  return THEME_LABEL[mode]
}
