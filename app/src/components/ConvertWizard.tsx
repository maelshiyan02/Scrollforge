import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { decodeText } from '../lib/encoding'
import { analyzeTxt, type TxtAnalysis } from '../lib/txt-chapters'
import { toPlainText } from '../lib/book-text'
import { canConvertToEpub, formatLabel, FORMATS } from '../lib/formats'
import { readComicPages, type ComicPage } from '../lib/comic-import'
import { extractPdfText } from '../lib/pdf-text'
import { buildEpub, bytesToBase64, type EpubImage, type EpubTreeNode } from '../lib/epub-writer'
import type { BookMeta } from '../types'
import Icon from './Icon'

type Props = {
  books: BookMeta[]
  initialBook?: BookMeta
  /** 最终成品默认目录；导出时仍可在保存对话框里另存到任意位置 */
  exportDir?: string | null
  /** 设置页「转换默认首行缩进 / 标题居中」传来的初始值 */
  initialIndent?: boolean
  initialCenterHeading?: boolean
  onClose: () => void
  onNotify: (message: string) => void
  onOpenSaved: (path: string) => void
}

const LANGUAGES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: '英文' },
  { value: 'ja', label: '日文' },
] as const

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? '未命名.txt'
}

function withoutExt(name: string): string {
  return name.replace(/\.([a-z0-9]+)$/i, '')
}

function extOf(name: string): string {
  return (name.split('.').pop() ?? 'txt').toLowerCase()
}

/** Windows 文件名里不能出现的字符 */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function readableError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err)
  if (/cancel/i.test(raw)) return '已取消'
  if (raw.includes('not allowed') || raw.includes('Forbidden')) {
    return '系统拒绝写入这个位置，请换一个目录'
  }
  return raw
}

export default function ConvertWizard({
  books,
  initialBook,
  exportDir,
  initialIndent = true,
  initialCenterHeading = true,
  onClose,
  onNotify,
  onOpenSaved,
}: Props) {
  const convertible = books.filter((book) => canConvertToEpub(book.format))
  const [step, setStep] = useState<1 | 2>(1)
  const [sourceKind, setSourceKind] = useState<'library' | 'disk'>(
    convertible.length > 0 ? 'library' : 'disk',
  )
  const [bookId, setBookId] = useState(
    (initialBook && canConvertToEpub(initialBook.format) ? initialBook.id : '') ||
      convertible[0]?.id ||
      '',
  )
  const [diskPath, setDiskPath] = useState('')
  const [diskName, setDiskName] = useState('')

  const [loading, setLoading] = useState(false)
  const [analysis, setAnalysis] = useState<TxtAnalysis | null>(null)
  const [comicPages, setComicPages] = useState<ComicPage[] | null>(null)
  const [sourceFormat, setSourceFormat] = useState('txt')
  const [encoding, setEncoding] = useState('')
  const [loadError, setLoadError] = useState('')

  const [title, setTitle] = useState(initialBook?.title ?? '')
  const [author, setAuthor] = useState('佚名')
  const [language, setLanguage] = useState('zh-CN')
  const [indent, setIndent] = useState(initialIndent)
  const [centerHeading, setCenterHeading] = useState(initialCenterHeading)

  const [generating, setGenerating] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<{ path: string; bytes: number } | null>(null)

  const tokenRef = useRef(0)

  const analyzeBuffer = useCallback(
    async (buffer: ArrayBuffer, fallbackTitle: string, fileName: string) => {
      const token = tokenRef.current + 1
      tokenRef.current = token
      setLoading(true)
      setLoadError('')
      setAnalysis(null)
      setComicPages(null)
      setEncoding('')
      setSourceFormat(extOf(fileName))
      // 让"正在识别"状态先画出来，避免大文件时界面像卡死
      await new Promise((resolve) => window.setTimeout(resolve, 30))
      try {
        const format = extOf(fileName)
        if (format === 'cbz' || format === 'zip') {
          const pages = await readComicPages(buffer, fileName)
          if (token !== tokenRef.current) return
          setComicPages(pages)
          setTitle(fallbackTitle)
          return
        }
        let text: string
        let encodingName = ''
        if (format === 'pdf') {
          text = await extractPdfText(new File([buffer], fileName))
        } else {
          const decoded = decodeText(buffer)
          encodingName = decoded.encoding
          text = toPlainText(decoded.text, format)
        }
        const result = analyzeTxt(text)
        if (token !== tokenRef.current) return
        if (!result.chapters.some((chapter) => chapter.paragraphs.length > 0)) {
          throw new Error('这本书没有可转换的正文')
        }
        setEncoding(encodingName)
        setAnalysis(result)
        setTitle(fallbackTitle)
      } catch (err) {
        if (token !== tokenRef.current) return
        setLoadError(`读取失败：${readableError(err)}`)
        setAnalysis(null)
        setComicPages(null)
      } finally {
        if (token === tokenRef.current) setLoading(false)
      }
    },
    [],
  )

  // 来源变化就重新读取与识别
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        if (sourceKind === 'library') {
          if (!bookId) return
          const buffer = await invoke<ArrayBuffer>('read_book_bytes', { id: bookId })
          if (cancelled) return
          const meta = books.find((book) => book.id === bookId)
          const name = meta?.sourceName || `${meta?.title ?? '未命名'}.${meta?.format ?? 'txt'}`
          await analyzeBuffer(buffer, meta?.title ?? '未命名', name)
        } else {
          if (!diskPath) return
          const buffer = await invoke<ArrayBuffer>('read_book', { path: diskPath })
          if (cancelled) return
          await analyzeBuffer(buffer, withoutExt(diskName), diskName)
        }
      } catch (err) {
        if (!cancelled) setLoadError(`读取失败：${readableError(err)}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sourceKind, bookId, diskPath, diskName, books, analyzeBuffer])

  const pickDiskFile = useCallback(async () => {
    try {
      const picked = await open({
        multiple: false,
        title: '选择要转换为 EPUB 的电子书',
        filters: [
          {
            name: '可转换为 EPUB',
            extensions: FORMATS.filter((item) => item.toEpub).map((item) => item.ext),
          },
        ],
      })
      if (typeof picked !== 'string') return
      setSourceKind('disk')
      setDiskPath(picked)
      setDiskName(baseName(picked))
      setBookId('')
      setSaved(null)
    } catch (err) {
      setLoadError(`选择文件失败：${readableError(err)}`)
    }
  }, [])

  const chooseLibraryBook = (book: BookMeta) => {
    setSourceKind('library')
    setBookId(book.id)
    setDiskPath('')
    setDiskName('')
    setSaved(null)
  }

  const generate = useCallback(async () => {
    if ((!analysis && !comicPages) || generating) return
    setError('')
    try {
      const dir = (exportDir || '').replace(/[\\/]$/, '')
      const fileName = `${safeFileName(title.trim() || '未命名')}.epub`
      const target = await save({
        title: '保存转换后的 EPUB',
        defaultPath: dir ? `${dir}/${fileName}` : fileName,
        filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
      })
      if (typeof target !== 'string') return
      setGenerating(true)
      setStage('正在整理章节…')
      await new Promise((resolve) => window.setTimeout(resolve, 30))
      let structure: EpubTreeNode[] | undefined
      if (comicPages) {
        structure = comicPages.map((_, index) => ({
          title: `第 ${index + 1} 页`,
          paragraphs: [],
          image: comicPages[index]!.image as EpubImage,
        }))
      }
      const bytes = buildEpub(analysis?.chapters ?? [], {
        title: title.trim() || '未命名',
        author: author.trim() || '佚名',
        language,
        indent,
        centerHeading,
        structure,
      })
      setStage(`正在写入 ${formatSize(bytes.length)}…`)
      const written = await invoke<number>('save_epub', {
        path: target,
        base64: bytesToBase64(bytes),
      })
      setStage('')
      setSaved({ path: target, bytes: written })
      onNotify('EPUB 已生成')
    } catch (err) {
      setStage('')
      setError(`生成失败：${readableError(err)}`)
    } finally {
      setGenerating(false)
    }
  }, [analysis, comicPages, generating, title, author, language, indent, centerHeading, exportDir, onNotify])

  const chapters = analysis?.chapters.filter((chapter) => chapter.paragraphs.length > 0) ?? []
  const pageCount = comicPages?.length ?? 0
  const chapterCount = comicPages ? pageCount : chapters.length
  const kindText = comicPages
    ? `漫画共 ${pageCount} 页`
    : analysis
      ? analysis.fallback
        ? '未识别到章节，按长度分块'
        : `识别到 ${analysis.headingCount} 个章节标题`
      : ''

  return (
    <div className="wizard-mask" onClick={() => (generating ? null : onClose())}>
      <div className="wizard" onClick={(e) => e.stopPropagation()}>
        <header className="wizard-head">
          <span className="wizard-title">转换为 EPUB</span>
          <span className="wizard-step">
            {saved ? '完成' : `第 ${step} 步 / 共 2 步 · ${step === 1 ? '选择来源并预览' : '确认信息与选项'}`}
          </span>
          <span className="grow" />
          <button
            className="btn small icon-only"
            data-tip="关闭转换向导（Esc）"
            aria-label="关闭转换向导"
            disabled={generating}
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        {saved ? (
          <div className="wizard-done">
            <div className="done-mark" aria-hidden="true">✓</div>
            <h3>已生成 EPUB</h3>
            <p className="done-path" title={saved.path}>{saved.path}</p>
            <p className="done-meta">
              {chapterCount} 章 · {formatSize(saved.bytes)}
            </p>
            <div className="wizard-actions">
              <button
                className="btn icon-only tip-top"
                data-tip="关闭向导"
                aria-label="关闭"
                onClick={onClose}
              >
                <Icon name="close" />
              </button>
              <button
                className="btn primary icon-only tip-top"
                data-tip="打开刚生成的 EPUB"
                aria-label="立即打开"
                onClick={() => onOpenSaved(saved.path)}
              >
                <Icon name="open_in_new" />
              </button>
            </div>
          </div>
        ) : step === 1 ? (
          <>
            <div className="wizard-body">
              <section className="wiz-sources">
                <div className="wiz-label">来源</div>
                {convertible.length > 0 && (
                  <div className="wiz-booklist">
                    {convertible.map((book) => (
                      <button
                        key={book.id}
                        className={`wiz-book ${sourceKind === 'library' && bookId === book.id ? 'on' : ''}`}
                        title={`选择《${book.title}》作为转换来源`}
                        onClick={() => chooseLibraryBook(book)}
                      >
                        <Icon name="menu_book" size={16} />
                        <span className="wiz-book-title">{book.title}</span>
                        <span className="wiz-book-meta">
                          {formatLabel(book.format)} · {formatSize(book.byteLen)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <button
                  className={`btn icon-only tip-top ${sourceKind === 'disk' ? 'on' : ''}`}
                  data-tip="从磁盘选择可转换为 EPUB 的电子书"
                  aria-label="从磁盘选择电子书"
                  onClick={() => void pickDiskFile()}
                >
                  <Icon name="folder_open" />
                </button>
                {sourceKind === 'disk' && diskName && (
                  <div className="wiz-picked" title={diskPath}>{diskName}</div>
                )}
                {convertible.length === 0 && sourceKind === 'library' && (
                  <p className="wiz-hint">书架里没有可转换为 EPUB 的书，请从磁盘选择。</p>
                )}
              </section>

              <section className="wiz-preview">
                <div className="wiz-label">预览</div>
                {loading ? (
                  <div className="wiz-empty">正在读取并识别章节…</div>
                ) : loadError ? (
                  <div className="wiz-empty error">{loadError}</div>
                ) : comicPages ? (
                  <>
                    <div className="wiz-facts">
                      <span>{formatLabel(sourceFormat)}</span>
                      <span className="dot">·</span>
                      <span>{kindText}</span>
                      <span className="dot">·</span>
                      <span>每页一张图</span>
                    </div>
                    <p className="wiz-warn">
                      漫画按图片顺序每页生成一章，目录会显示为「第 1 页 …」。
                    </p>
                    <ol className="wiz-chapters">
                      {comicPages.slice(0, 300).map((page, index) => (
                        <li key={index}>
                          <span className="wiz-ch-index">{index + 1}</span>
                          <span className="wiz-ch-title">{page.name}</span>
                          <span className="wiz-ch-count">{formatSize(page.image.bytes.length)}</span>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : analysis ? (
                  <>
                    <div className="wiz-facts">
                      <span>{formatLabel(sourceFormat)}</span>
                      <span className="dot">·</span>
                      {encoding && (
                        <>
                          <span>编码：{encoding}</span>
                          <span className="dot">·</span>
                        </>
                      )}
                      <span>{kindText}</span>
                      <span className="dot">·</span>
                      <span>共 {chapterCount} 章</span>
                    </div>
                    {analysis.fallback && (
                      <p className="wiz-warn">
                        这本书没有明显的章节标题，将按长度分块生成，阅读体验会差一些。
                      </p>
                    )}
                    <ol className="wiz-chapters">
                      {chapters.map((chapter, index) => (
                        <li key={index}>
                          <span className="wiz-ch-index">{index + 1}</span>
                          <span className="wiz-ch-title">
                            {chapter.title ?? (chapterCount === 1 ? '正文' : `片段 ${index + 1}`)}
                          </span>
                          <span className="wiz-ch-count">{chapter.paragraphs.length} 段</span>
                        </li>
                      ))}
                    </ol>
                  </>
                ) : (
                  <div className="wiz-empty">先选择一个可转换为 EPUB 的来源</div>
                )}
              </section>
            </div>

            <div className="wizard-actions">
              <button
                className="btn icon-only tip-top"
                data-tip="取消转换"
                aria-label="取消转换"
                onClick={onClose}
              >
                <Icon name="close" />
              </button>
              <button
                className="btn primary icon-only tip-top"
                data-tip="下一步：确认信息与选项"
                aria-label="下一步"
                disabled={loading || (!analysis && !comicPages)}
                onClick={() => setStep(2)}
              >
                <Icon name="arrow_forward" />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="wizard-body confirm">
              <section className="wiz-form">
                <label className="wiz-field">
                  <span>书名</span>
                  <input
                    value={title}
                    maxLength={80}
                    title="EPUB 元信息里的书名，也是默认文件名"
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <label className="wiz-field">
                  <span>作者</span>
                  <input
                    value={author}
                    maxLength={60}
                    title="EPUB 元信息里的作者"
                    onChange={(e) => setAuthor(e.target.value)}
                  />
                </label>
                <label className="wiz-field">
                  <span>语言</span>
                  <select
                    value={language}
                    title="用于阅读器判断排版与朗读语言"
                    onChange={(e) => setLanguage(e.target.value)}
                  >
                    {LANGUAGES.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </label>
                <label className="wiz-check">
                  <input
                    type="checkbox"
                    checked={indent}
                    onChange={(e) => setIndent(e.target.checked)}
                  />
                  <span>段落首行缩进两字</span>
                </label>
                <label className="wiz-check">
                  <input
                    type="checkbox"
                    checked={centerHeading}
                    onChange={(e) => setCenterHeading(e.target.checked)}
                  />
                  <span>章节标题居中</span>
                </label>
              </section>

              <section className="wiz-summary">
                <div className="wiz-label">将要生成</div>
                <dl>
                  <dt>来源</dt>
                  <dd title={sourceKind === 'disk' ? diskPath : ''}>
                    {sourceKind === 'disk' ? diskName : books.find((b) => b.id === bookId)?.title ?? '—'}
                  </dd>
                  <dt>章节</dt>
                  <dd>{comicPages ? `${pageCount} 页（每页一章）` : `${chapterCount} 章`}</dd>
                  <dt>目录</dt><dd>同时写入 EPUB3 目录与兼容目录</dd>
                  <dt>结构</dt><dd>EPUB 3.0（可被第三方阅读器打开）</dd>
                </dl>
                <p className="wiz-note">
                  生成后保留原文件不动，只新增一个 .epub 文件。
                </p>
              </section>
            </div>

            {generating && (
              <div className="wiz-progress">
                <div className="wiz-progress-bar"><i /></div>
                <span>{stage || '正在生成…'}</span>
              </div>
            )}
            {error && <div className="wiz-error">{error}</div>}

            <div className="wizard-actions">
              <button
                className="btn icon-only tip-top"
                data-tip="返回上一步"
                aria-label="上一步"
                disabled={generating}
                onClick={() => setStep(1)}
              >
                <Icon name="arrow_back" />
              </button>
              <button
                className="btn primary icon-only tip-top"
                data-tip={generating ? '正在生成…' : '生成 EPUB 文件'}
                aria-label="开始生成"
                disabled={generating || (!analysis && !comicPages)}
                onClick={() => void generate()}
              >
                <Icon name="auto_fix_high" />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
