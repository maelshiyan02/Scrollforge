/**
 * 中文 TXT 的结构还原：逐行识别章节标题，再把硬换行熔接成自然段。
 *
 * 关键点（见 A07 第 13、14 条）：
 * - 绝不能"先按空行切段再匹配"。《红楼梦》章间有 8 个空行，那样会把标题当正文。
 * - 标记型标题（第X回/卷/楔子…）必须要求"回/章"之后是空白或分隔符，
 *   否则 `第四回中既將…` 这种回忆正文会被误判。
 * - 纯数字标题要做递增可信度校验，避免把正文里的编号列表当章节。
 */

export type TxtParagraphRange = {
  /** 源文件中的起始行（含） */
  start: number
  /** 源文件中的结束行（含） */
  end: number
}

export type TxtChapter = {
  /** 没有标题的片段（卷首、自动分块）为 undefined */
  title?: string
  /** 已熔接、已去除缩进的自然段 */
  paragraphs: string[]
  /** 每段对应的源文件行范围，与 paragraphs 一一对应；供锻造层写回使用 */
  paragraphRanges?: TxtParagraphRange[]
}

export type TxtAnalysis = {
  chapters: TxtChapter[]
  /** 被采纳的标题数量（不含前言、自动分块） */
  headingCount: number
  /** 没找到足够标题时按长度分块 */
  fallback: boolean
}

const MIN_HEADINGS = 3
const MAX_HEADING_CHARS = 48
const MAX_NUMBERED_TITLE_CHARS = 30
const CHUNK_CHARS = 60_000

/** 全角空格、普通空白都算标题分隔 */
const NUM = '0-9０-９零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟'
const UNIT = '章節节回卷篇部集话話講讲折'
const SEP = ':：.。、,，·・\\-—–~～【\\[（('
/** 标题之后：要么结束，要么空白 + 任意标题，要么标点 + 任意标题 */
const TAIL = `(?:[\\s\\u3000]+.*|[\\s\\u3000]*[${SEP}].*)?$`

const MARKED = new RegExp(`^第[\\s\\u3000]*[${NUM}]{1,8}[\\s\\u3000]*[${UNIT}]${TAIL}`)
const UNIT_LEADING = new RegExp(
  `^[上中下]?[卷篇部][\\s\\u3000]*[${NUM}]{1,8}${TAIL}`,
)
const VOLUME_ONLY = /^[上中下][卷篇部]$/
const MATTER = new RegExp(
  `^(序|序言|序章|自序|代序|小序|前言|引子|引言|导言|導言|楔子|后记|後記|后序|跋|尾声|尾聲|结语|結語|附录|附錄|番外|外传|外傳|终章|終章|正文|全文完)(?:[\\s\\u3000]+.*|[\\s\\u3000]*[${SEP}].*)?$`,
)
const ENGLISH = /^(chapter|part|book|volume|act|section|prologue|epilogue|preface|foreword|afterword|appendix)\b.*$/i

const BARE_NUMBER = /^([0-9]{1,4})[.、]?$/
const NUMBERED_TITLE = new RegExp(
  `^([0-9]{1,4})[\\s\\u3000]*[、.。：:,，·・\\-—–~～][\\s\\u3000]*(.{1,${MAX_NUMBERED_TITLE_CHARS}})$`,
)
const CJK_BARE = new RegExp(`^([${NUM}]{1,6})$`)
const CJK_TITLE = new RegExp(
  `^([${NUM}]{1,6})[\\s\\u3000]*[、.。：:,，][\\s\\u3000]*(.{0,${MAX_NUMBERED_TITLE_CHARS}})$`,
)

type Candidate = {
  line: number
  title: string
  value?: number
  /** 正文起始行：标题常被拆成"第三回"+下一行的回目，合并后正文要后移 */
  bodyStart?: number
}

/** 全角数字转半角，并把连续空白压成一个空格 */
function normalizeLine(raw: string): string {
  return raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
}

const DIGIT_VALUE: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9,
}
const UNIT_VALUE: Record<string, number> = {
  十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000, 万: 10000,
}

/** 把「十二」「一百零五」等中文数字转成整数；无法解析返回 null */
export function cjkNumberValue(text: string): number | null {
  // 逐位写法（第一零一回 / 第一二零回）在公版书里很常见，直接按十进制拼
  if (![...text].some((ch) => ch in UNIT_VALUE)) {
    let value = 0
    for (const ch of text) {
      const d = DIGIT_VALUE[ch]
      if (d == null) return null
      value = value * 10 + d
    }
    return value > 0 ? value : null
  }

  let total = 0
  let section = 0
  let digit = -1
  for (const ch of text) {
    if (ch in DIGIT_VALUE) {
      digit = DIGIT_VALUE[ch]!
      continue
    }
    const unit = UNIT_VALUE[ch]
    if (!unit) return null
    if (unit === 10000) {
      section += Math.max(digit, 0)
      total += (section || 1) * 10000
      section = 0
      digit = -1
    } else {
      section += (digit < 0 ? 1 : digit) * unit
      digit = -1
    }
  }
  const result = total + section + Math.max(digit, 0)
  return result > 0 ? result : null
}

function classify(raw: string): Candidate | null {
  const text = normalizeLine(raw)
  if (!text || text.length > MAX_HEADING_CHARS) return null

  if (MARKED.test(text) || UNIT_LEADING.test(text) || VOLUME_ONLY.test(text) || MATTER.test(text)) {
    return { line: -1, title: text }
  }
  if (ENGLISH.test(text)) return { line: -1, title: text }

  const numbered = BARE_NUMBER.exec(text) ?? NUMBERED_TITLE.exec(text)
  if (numbered) return { line: -1, title: text, value: Number(numbered[1]) }

  const cjk = CJK_BARE.exec(text) ?? CJK_TITLE.exec(text)
  if (cjk) {
    const value = cjkNumberValue(cjk[1]!)
    if (value != null) return { line: -1, title: text, value }
  }
  return null
}

/** 数字像不像章节编号：从 1 附近开始、严格递增、间隔不稀疏 */
function numberingIsCredible(values: number[]): boolean {
  if (values.length < MIN_HEADINGS) return false
  if (values[0]! > 2) return false
  for (let i = 1; i < values.length; i += 1) {
    if (values[i]! <= values[i - 1]!) return false
  }
  return values[values.length - 1]! - values[0]! <= values.length * 3
}

function charsBetween(lines: string[], from: number, to: number): number {
  let count = 0
  for (let i = from + 1; i < to; i += 1) {
    const text = (lines[i] ?? '').trim()
    if (isDecoration(text)) continue
    count += text.length
  }
  return count
}

/**
 * 书内自带目录：连续多条标题型短行堆在一起，而且每一条都能在后面的正文里
 * 再遇到同名标题。只满足一条时不敢删（可能是连续空章）。
 */
function dropContentsListing(candidates: Candidate[], lines: string[]): Candidate[] {
  if (candidates.length < MIN_HEADINGS) return candidates

  // 先处理"同一标题紧挨着出现两次"（公版书里常见重复标题行，中间只有分隔线）
  const deduped: Candidate[] = []
  for (const candidate of candidates) {
    const prev = deduped[deduped.length - 1]
    const packed =
      prev &&
      prev.title === candidate.title &&
      charsBetween(lines, prev.line, candidate.line) <= 40
    if (packed) continue
    deduped.push(candidate)
  }
  candidates = deduped
  if (candidates.length < MIN_HEADINGS) return candidates
  const keep = candidates.map(() => true)
  let runStart = 0
  for (let i = 1; i <= candidates.length; i += 1) {
    const packed =
      i < candidates.length &&
      charsBetween(lines, candidates[i - 1]!.line, candidates[i]!.line) <= 40
    if (packed) continue
    if (i - runStart >= MIN_HEADINGS) {
      for (let j = runStart; j < i; j += 1) {
        const echoed = candidates.some(
          (c, k) => k > j && c.title === candidates[j]!.title,
        )
        if (echoed) keep[j] = false
      }
    }
    runStart = i
  }
  const kept = candidates.filter((_, i) => keep[i])
  return kept.length >= MIN_HEADINGS ? kept : candidates
}

/** 裁掉 Project Gutenberg 的授权头尾（中文公版书极常见） */
function stripGutenberg(lines: string[]): { lines: string[]; offset: number } {
  const startRe = /^\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG.*\*\*\*$/i
  const endRe = /^\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG.*\*\*\*$/i
  let from = 0
  let to = lines.length
  for (let i = 0; i < Math.min(lines.length, 400); i += 1) {
    if (startRe.test(lines[i]!.trim())) {
      from = i + 1
      break
    }
  }
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 400); i -= 1) {
    if (endRe.test(lines[i]!.trim())) {
      to = i
      break
    }
  }
  return { lines: lines.slice(from, to), offset: from }
}

const DECORATION = /^[-=*_~—–]{4,}$/
const SENTENCE_END = /[。．.!！?？…’”」』】）)]$/
const OPENING_QUOTE = /^[“「『"'‘]/
const INDENTED = /^(?:\u3000+|[ \t]{2,})/

function isDecoration(line: string): boolean {
  return DECORATION.test(line.trim())
}

/** 回目常见的对仗格式："賈雨村夤緣复舊職　林黛玉拋父進京都" */
function looksLikeSplitTitle(raw: string): boolean {
  const text = raw.trim()
  if (text.length < 2 || text.length > MAX_HEADING_CHARS) return false
  if (SENTENCE_END.test(text)) return false
  const parts = text.split(/[\s\u3000]+/).filter(Boolean)
  return parts.length >= 2 && parts.every((part) => part.length >= 2)
}

/**
 * 公版书常把回目拆成两行：
 *   第三回
 *   ---------------------------------
 *   　　　　賈雨村夤緣复舊職　林黛玉拋父進京都
 * 这里把下一行的对仗回目并回标题，并把正文起点后移。
 */
function mergeSplitTitle(
  candidate: Candidate,
  lines: string[],
): { title: string; bodyStart: number } {
  const bodyStart = candidate.line + 1
  if (!/^第[^\s]+[回章節节卷篇]$/.test(candidate.title)) {
    return { title: candidate.title, bodyStart }
  }
  for (let i = candidate.line + 1; i < Math.min(lines.length, candidate.line + 8); i += 1) {
    const raw = lines[i] ?? ''
    const text = raw.trim()
    if (!text || isDecoration(text)) continue
    if (!looksLikeSplitTitle(raw)) return { title: candidate.title, bodyStart }
    return {
      title: `${candidate.title} ${text.replace(/[\s\u3000]+/g, ' ')}`,
      bodyStart: i + 1,
    }
  }
  return { title: candidate.title, bodyStart }
}

type ReflowedParagraph = { text: string; start: number; end: number }

/**
 * 熔接正文并记录每段落在源文件中的行范围（绝对行号）。
 * 规则：
 * - 空行断段
 * - 行首有全角空格 / 两个以上半角空格 → 新段
 * - 上一行以句末标点结尾、本行以引号开头 → 新段（对话）
 * - 其余视为排版硬换行，直接接上，中文之间不加空格
 * 如果全章绝大多数行都以句末标点结尾，则判定"一行一段"，不再熔接。
 * base 是该批原始行在源文件中的起始行号。
 */
function reflowRanges(rawLines: string[], base: number): ReflowedParagraph[] {
  const kept: { text: string; line: number }[] = []
  rawLines.forEach((raw, index) => {
    const line = raw.replace(/\s+$/, '')
    if (isDecoration(line)) return
    kept.push({ text: line, line: base + index })
  })
  const nonEmpty = kept.filter((entry) => entry.text.trim())
  if (nonEmpty.length === 0) return []

  const ended = nonEmpty.filter((entry) => SENTENCE_END.test(entry.text.trim())).length
  const oneLinePerParagraph = nonEmpty.length >= 5 && ended / nonEmpty.length >= 0.7

  if (oneLinePerParagraph) {
    return nonEmpty.map((entry) => ({
      text: entry.text.trim(),
      start: entry.line,
      end: entry.line,
    }))
  }

  const paragraphs: ReflowedParagraph[] = []
  let current = ''
  let start = -1
  let end = -1
  let previousRaw = ''

  const flush = () => {
    const text = current.trim()
    if (text) paragraphs.push({ text, start, end })
    current = ''
    start = -1
    end = -1
  }

  for (const entry of kept) {
    const raw = entry.text
    const trimmed = raw.trim()
    if (!trimmed) {
      flush()
      previousRaw = ''
      continue
    }
    const startsNew =
      INDENTED.test(raw) ||
      (current !== '' && SENTENCE_END.test(previousRaw.trim()) && OPENING_QUOTE.test(trimmed))
    if (startsNew) flush()
    if (!current) {
      current = trimmed
      start = entry.line
      end = entry.line
    } else {
      const needSpace = /[A-Za-z0-9]$/.test(current) && /^[A-Za-z0-9]/.test(trimmed)
      current += needSpace ? ` ${trimmed}` : trimmed
      end = entry.line
    }
    previousRaw = raw
  }
  flush()
  return paragraphs
}

export function reflowParagraphs(rawLines: string[]): string[] {
  return reflowRanges(rawLines, 0).map((entry) => entry.text)
}

function chunkLines(lines: string[], base: number): TxtChapter[] {
  const chunks: { lines: string[]; start: number }[] = []
  let current: string[] = []
  let currentStart = base
  let consumed = 0
  let size = 0
  for (const line of lines) {
    current.push(line)
    consumed += 1
    size += line.length + 1
    if (size >= CHUNK_CHARS && !line.trim()) {
      chunks.push({ lines: current, start: currentStart })
      current = []
      currentStart = base + consumed
      size = 0
    }
  }
  if (current.some((l) => l.trim()) || chunks.length === 0) {
    chunks.push({ lines: current, start: currentStart })
  }

  return chunks.map((chunk, index) => {
    const reflowed = reflowRanges(chunk.lines, chunk.start)
    return {
      title: chunks.length > 1 ? `片段 ${index + 1}` : undefined,
      paragraphs: reflowed.map((entry) => entry.text),
      paragraphRanges: reflowed.map((entry) => ({ start: entry.start, end: entry.end })),
    }
  })
}

export function analyzeTxt(raw: string): TxtAnalysis {
  const { lines, offset } = stripGutenberg(raw.replace(/\r\n?/g, '\n').split('\n'))

  const found: Candidate[] = []
  lines.forEach((line, index) => {
    const candidate = classify(line)
    if (candidate) found.push({ ...candidate, line: index })
  })

  const candidates = dropContentsListing(found, lines)

  const numbered = candidates.filter((c) => c.value != null)
  const accepted = numberingIsCredible(numbered.map((c) => c.value!))
    ? candidates
    : candidates.filter((c) => c.value == null)

  if (accepted.length < MIN_HEADINGS) {
    return { chapters: chunkLines(lines, offset), headingCount: 0, fallback: true }
  }

  accepted.sort((a, b) => a.line - b.line)
  const chapters: TxtChapter[] = []
  const preface = lines.slice(0, accepted[0]!.line)
  if (preface.some((l) => l.trim())) {
    const reflowed = reflowRanges(preface, offset)
    if (reflowed.length) {
      chapters.push({
        title: '前言',
        paragraphs: reflowed.map((entry) => entry.text),
        paragraphRanges: reflowed.map((entry) => ({ start: entry.start, end: entry.end })),
      })
    }
  }

  for (let i = 0; i < accepted.length; i += 1) {
    const end = i + 1 < accepted.length ? accepted[i + 1]!.line : lines.length
    const merged = mergeSplitTitle(accepted[i]!, lines)
    // 重复出现的标题行（公版书常见）会落在正文开头，这里一并剥掉
    let from = merged.bodyStart
    while (from < end) {
      const text = normalizeLine(lines[from] ?? '')
      if (!text || isDecoration(text)) { from += 1; continue }
      if (text === normalizeLine(merged.title) || text === normalizeLine(accepted[i]!.title)) {
        from += 1
        continue
      }
      break
    }
    const reflowed = reflowRanges(lines.slice(from, end), offset + from)
    chapters.push({
      title: merged.title,
      paragraphs: reflowed.map((entry) => entry.text),
      paragraphRanges: reflowed.map((entry) => ({ start: entry.start, end: entry.end })),
    })
  }

  return { chapters, headingCount: accepted.length, fallback: false }
}
