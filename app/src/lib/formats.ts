/**
 * 格式矩阵单一真相：阅读 / 导入 / 转换 / 编辑能力都从这里取，避免 UI 与实现两套说法。
 */

export type FormatInfo = {
  ext: string
  label: string
  /** 直接交给 foliate 渲染（保留原书排版与插图） */
  direct: boolean
  /** 走文本归一化 + TXT 章节识别管线 */
  text: boolean
  /** 可作为「转换为 EPUB」的来源 */
  toEpub: boolean
  /** 可从 EPUB 导出 */
  fromEpub: boolean
  /** 仅 EPUB 可直接编辑 */
  editable: boolean
}

export const FORMATS: FormatInfo[] = [
  { ext: 'epub', label: 'EPUB', direct: true, text: false, toEpub: false, fromEpub: true, editable: true },
  { ext: 'mobi', label: 'MOBI', direct: true, text: false, toEpub: false, fromEpub: false, editable: false },
  { ext: 'azw', label: 'AZW', direct: true, text: false, toEpub: false, fromEpub: false, editable: false },
  { ext: 'azw3', label: 'AZW3', direct: true, text: false, toEpub: false, fromEpub: false, editable: false },
  { ext: 'fb2', label: 'FB2', direct: true, text: false, toEpub: true, fromEpub: false, editable: false },
  { ext: 'cbz', label: 'CBZ', direct: true, text: false, toEpub: true, fromEpub: false, editable: false },
  { ext: 'zip', label: 'ZIP', direct: true, text: false, toEpub: true, fromEpub: false, editable: false },
  { ext: 'pdf', label: 'PDF', direct: true, text: false, toEpub: true, fromEpub: false, editable: false },
  { ext: 'txt', label: 'TXT', direct: false, text: true, toEpub: true, fromEpub: false, editable: false },
  { ext: 'md', label: 'Markdown', direct: false, text: true, toEpub: true, fromEpub: false, editable: false },
  { ext: 'html', label: 'HTML', direct: false, text: true, toEpub: true, fromEpub: false, editable: false },
]

export const ALL_FORMATS = FORMATS.map((item) => item.ext)

/** 旧版本默认五种格式：用于设置迁移，不覆盖用户自定义清单。 */
export const LEGACY_DEFAULT_FORMATS = ['epub', 'txt', 'md', 'html', 'fb2']

export const FORMAT_LABELS: Record<string, string> = Object.fromEntries(
  FORMATS.map((item) => [item.ext, item.label]),
)

function info(ext: string): FormatInfo | undefined {
  const key = ext === 'htm' ? 'html' : ext.toLowerCase()
  return FORMATS.find((item) => item.ext === key)
}

export function formatLabel(ext: string): string {
  return FORMAT_LABELS[ext === 'htm' ? 'html' : ext.toLowerCase()] ?? ext.toUpperCase()
}

export function isDirectFormat(ext: string): boolean {
  return Boolean(info(ext)?.direct)
}

export function isTextFormat(ext: string): boolean {
  return Boolean(info(ext)?.text)
}

export function canConvertToEpub(ext: string): boolean {
  return Boolean(info(ext)?.toEpub)
}

export function canExportFromEpub(ext: string): boolean {
  return Boolean(info(ext)?.fromEpub)
}

/** 导入对话框的文件过滤器：按能力分组，顺序与「关于」页一致。 */
export const IMPORT_FILTERS = [
  { name: '可直接阅读', extensions: ['epub', 'mobi', 'azw', 'azw3', 'fb2', 'cbz', 'zip', 'pdf'] },
  { name: '文本与网页', extensions: ['txt', 'md', 'html', 'htm'] },
  { name: '全部电子书', extensions: ALL_FORMATS },
]

export function importFormatsHint(formats: string[]): string {
  const readable = formats.filter((ext) => info(ext)?.direct).map(formatLabel)
  const text = formats.filter((ext) => info(ext)?.text).map(formatLabel)
  const parts: string[] = []
  if (readable.length) parts.push(`直接阅读：${readable.join(' · ')}`)
  if (text.length) parts.push(`文本排版：${text.join(' · ')}`)
  return parts.join('；')
}
