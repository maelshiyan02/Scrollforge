import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { epubToText, type ExportFormat } from '../lib/epub-export'
import { bytesToBase64 } from '../lib/epub-writer'
import type { BookMeta } from '../types'
import Icon from './Icon'

type Props = {
  book: BookMeta
  exportDir?: string | null
  onClose: () => void
  onNotify: (message: string) => void
}

const TARGETS: { format: ExportFormat; label: string; ext: string; desc: string }[] = [
  { format: 'txt', label: 'TXT', ext: 'txt', desc: '纯文本，段落之间空一行' },
  { format: 'md', label: 'Markdown', ext: 'md', desc: '章节标题写成 ## 标题' },
  { format: 'html', label: 'HTML', ext: 'html', desc: '带最简排版的网页，可直接打开' },
]

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名'
}

function readableError(err: unknown): string {
  const raw = String((err as Error)?.message ?? err)
  if (/cancel/i.test(raw)) return '已取消'
  if (raw.includes('not allowed') || raw.includes('Forbidden')) {
    return '系统拒绝写入这个位置，请换一个目录'
  }
  return raw
}

export default function ExportTextDialog({ book, exportDir, onClose, onNotify }: Props) {
  const [busy, setBusy] = useState<ExportFormat | null>(null)
  const [error, setError] = useState('')

  const doExport = async (target: (typeof TARGETS)[number]) => {
    if (busy) return
    setError('')
    setBusy(target.format)
    try {
      const buffer = await invoke<ArrayBuffer>('read_book_bytes', { id: book.id })
      const fileName = book.sourceName || `${book.title}.epub`
      const file = new File([new Uint8Array(buffer)], fileName, { type: 'application/epub+zip' })
      const text = await epubToText(file, target.format, book.title)
      const dir = (exportDir || '').replace(/[\\/]$/, '')
      const name = `${safeFileName(book.title)}.${target.ext}`
      const path = await save({
        title: `导出为 ${target.label}`,
        defaultPath: dir ? `${dir}/${name}` : name,
        filters: [{ name: `${target.label} 文件`, extensions: [target.ext] }],
      })
      if (typeof path !== 'string') return
      const bytes = new TextEncoder().encode(text)
      await invoke<number>('save_epub', { path, base64: bytesToBase64(bytes) })
      onNotify(`已导出 ${target.label}`)
      onClose()
    } catch (err) {
      setError(`导出失败：${readableError(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="modal-mask" onClick={() => (busy ? null : onClose())}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>导出文本</h3>
        <p className="path-text" title={book.sourceName}>
          《{book.title}》 · 从 EPUB 提取文字，不改动原文件
        </p>
        <div className="wiz-booklist" style={{ marginTop: 12 }}>
          {TARGETS.map((target) => (
            <button
              key={target.format}
              className="wiz-book"
              disabled={Boolean(busy)}
              title={target.desc}
              onClick={() => void doExport(target)}
            >
              <Icon name="description" size={16} />
              <span className="wiz-book-title">{target.label}</span>
              <span className="wiz-book-meta">
                {busy === target.format ? '正在导出…' : target.desc}
              </span>
            </button>
          ))}
        </div>
        {error && <p className="wiz-empty error" style={{ marginTop: 10 }}>{error}</p>}
        <div className="modal-actions">
          <button
            className="btn icon-only tip-top"
            data-tip="关闭"
            aria-label="关闭"
            disabled={Boolean(busy)}
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>
    </div>
  )
}
