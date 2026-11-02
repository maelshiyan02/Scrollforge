/**
 * 从书里抽出彩页 / 插图 / 漫画页。
 * EPUB：按 manifest 里的大图筛出真正的整页图；
 * CBZ/ZIP：按文件名自然排序，一页一张图（就是漫画阅读顺序）。
 */
import { invoke } from '@tauri-apps/api/core'
import { makeBook } from '../vendor/foliate-js/view.js'
import type { BookMeta } from '../types'

export type PageImage = {
  href: string
  url: string
  width: number
  height: number
  bytes: number
}

const MIN_BYTES = 24 * 1024
const MIN_SIDE = 320
const MAX_IMAGES = 120
const IMAGE_NAME_RE = /\.(jpe?g|png|gif|bmp|webp|svg|jxl|avif)$/i

function loadImage(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error('图片无法解码'))
    image.src = url
  })
}

/** EPUB：从 manifest 里挑出体积够大、边长够长的图（彩页、跨页插图） */
async function readEpubImages(file: File): Promise<PageImage[]> {
  const parsed = (await makeBook(file)) as {
    resources?: { manifest?: { href: string; mediaType?: string }[] }
    loadBlob?: (href: string) => Promise<ArrayBuffer>
  }
  const manifest = parsed.resources?.manifest ?? []
  const loadBlob = parsed.loadBlob
  if (!loadBlob) return []

  const images = manifest.filter(
    (item) => typeof item.mediaType === 'string' && item.mediaType.startsWith('image/'),
  )

  const out: PageImage[] = []
  for (const item of images) {
    if (out.length >= MAX_IMAGES) break
    let url = ''
    try {
      const bytes = await loadBlob(item.href)
      if (!bytes || bytes.byteLength < MIN_BYTES) continue
      url = URL.createObjectURL(new Blob([bytes], { type: item.mediaType }))
      const size = await loadImage(url)
      if (size.width < MIN_SIDE && size.height < MIN_SIDE) {
        URL.revokeObjectURL(url)
        continue
      }
      out.push({ href: item.href, url, width: size.width, height: size.height, bytes: bytes.byteLength })
    } catch {
      if (url) URL.revokeObjectURL(url)
    }
  }
  // 大图（彩页、跨页插图）排前面，小图标在后
  out.sort((a, b) => b.bytes - a.bytes)
  return out
}

/** CBZ/ZIP：直接解包，按文件名自然排序取图，保留漫画阅读顺序 */
async function readComicImages(file: File): Promise<PageImage[]> {
  const zip: any = await import('../vendor/foliate-js/vendor/zip.js')
  zip.configure({ useWebWorkers: false })
  const reader = new zip.ZipReader(new zip.BlobReader(file))
  try {
    const entries = (await reader.getEntries()) as any[]
    const names = entries
      .map((entry) => String(entry.filename))
      .filter((name) => IMAGE_NAME_RE.test(name))
    // 001.jpg / 002.jpg… 必须按数字顺序，不能按字符串
    names.sort(new Intl.Collator([], { numeric: true }).compare)

    const out: PageImage[] = []
    for (const name of names.slice(0, MAX_IMAGES)) {
      const entry = entries.find((item) => String(item.filename) === name)
      if (!entry) continue
      let url = ''
      try {
        const blob = (await entry.getData(new zip.BlobWriter())) as Blob
        if (!blob || blob.size === 0) continue
        url = URL.createObjectURL(blob)
        const size = await loadImage(url)
        out.push({ href: name, url, width: size.width, height: size.height, bytes: blob.size })
      } catch {
        if (url) URL.revokeObjectURL(url)
      }
    }
    return out
  } finally {
    try {
      await reader.close()
    } catch {
      // 解包器已关闭时忽略
    }
  }
}

export async function readPageImages(book: BookMeta): Promise<PageImage[]> {
  const format = (book.format || '').toLowerCase()
  if (format !== 'epub' && format !== 'cbz' && format !== 'zip') return []
  const buffer = await invoke<ArrayBuffer>('read_book_bytes', { id: book.id })
  const fallback = `${book.title}.${format === 'zip' ? 'cbz' : format}`
  const file = new File([new Uint8Array(buffer)], book.sourceName || fallback)
  return format === 'epub' ? readEpubImages(file) : readComicImages(file)
}

export function releaseImages(items: PageImage[]): void {
  for (const item of items) URL.revokeObjectURL(item.url)
}
