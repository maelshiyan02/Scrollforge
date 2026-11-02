/** 书架上的一条书目，字段与 Rust 端 BookMeta 一致（serde camelCase）。 */
export type BookMeta = {
  id: string
  title: string
  format: string
  byteLen: number
  importedAt: number
  sourceName: string
  /** 从 EPUB 抽出的封面文件名（没有封面时为空） */
  cover?: string | null
  /** library：副本在固定书库；history：只登记原文件路径 */
  storage?: 'library' | 'history'
  /** history 模式的原文件绝对路径 */
  path?: string | null
  /** 从子文件夹导入时的分组 */
  group?: string | null
  lastOpenedAt?: number | null
}

/** 阅读页的打开来源：书架里的书，或直接从磁盘选择的文件。 */
export type ReaderSource =
  | { kind: 'library'; meta: BookMeta }
  | { kind: 'file'; file: File; name: string }

export type Typography = {
  fontSize: number
  lineHeight: number
  indent: boolean
}

export type TocEntry = {
  label: string
  href: string
  depth: number
  /** 分组标题（没有 href 的 <span> 节点），只显示不可跳转 */
  group?: boolean
}

/** 与 Rust 端 AppSettings 对应。阅读历史与本地书库并存。 */
export type AppSettings = {
  /** 兼容旧字段：不再作为模式切换，实际行为由 keepOriginal 控制 */
  storageMode: 'history' | 'library'
  /** 本地书库（复制副本）文件夹 */
  libraryDir: string
  /** 阅读历史记录文件夹 */
  readingHistoryDir: string
  /** 最终成品（转换导出）默认文件夹 */
  finalExportDir: string
  importFormats: string[]
  minBytes: number
  /** 无痕链接模式：只记录原文件路径，不复制副本 */
  keepOriginal: boolean
  folderGroup: boolean
}

export type ScanItem = {
  path: string
  title: string
  format: string
  byteLen: number
  group: string
}

/** 一次 EPUBCheck 的结果，与 Rust 端 EpubCheckResult 对应。 */
export type EpubCheckResult = {
  /** 无致命错误、无错误（警告不算失败） */
  ok: boolean
  exitCode: number
  fatals: number
  errors: number
  warnings: number
  infos: number
  /** 本次实际使用的运行环境：内置 JRE / 系统 Java */
  runtime: string
  elapsedMs: number
  lines: string[]
  raw: string
}
