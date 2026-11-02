/**
 * CBZ / ZIP（漫画包）读取：把压缩包里的图片按文件名自然排序，转成 EPUB 插图页。
 *
 * 只收 EPUB 3 核心支持的图片类型（jpeg / png / gif / webp），
 * 避免把 bmp、jxl、avif 之类写进 EPUB 后触发 epubcheck 报错。
 */

import type { EpubImage } from './epub-writer'

export type ComicPage = {
  /** 展示名（不含扩展名） */
  name: string
  image: EpubImage
}

const SUPPORTED: Record<string, { mediaType: string; ext: string }> = {
  jpg: { mediaType: 'image/jpeg', ext: 'jpg' },
  jpeg: { mediaType: 'image/jpeg', ext: 'jpg' },
  png: { mediaType: 'image/png', ext: 'png' },
  gif: { mediaType: 'image/gif', ext: 'gif' },
  webp: { mediaType: 'image/webp', ext: 'webp' },
}

export async function readComicPages(buffer: ArrayBuffer, fileName: string): Promise<ComicPage[]> {
  const { configure, ZipReader, BlobReader, BlobWriter } =
    await import('../vendor/foliate-js/vendor/zip.js')
  configure({ useWebWorkers: false })
  const reader = new ZipReader(new BlobReader(new Blob([buffer], { type: 'application/zip' })))
  try {
    const entries = await reader.getEntries()
    const pages: any[] = entries
      .filter((entry: any) => !entry.directory)
      .filter((entry: any) => SUPPORTED[(entry.filename.split('.').pop() ?? '').toLowerCase()])
      .sort((a: any, b: any) =>
        new Intl.Collator([], { numeric: true }).compare(a.filename, b.filename),
      )
    if (pages.length === 0) {
      throw new Error(`${archiveLabel(fileName)}里没有可用的图片（支持 JPEG / PNG / GIF / WebP）`)
    }
    const out: ComicPage[] = []
    for (const entry of pages) {
      const key = (entry.filename.split('.').pop() ?? '').toLowerCase()
      const info = SUPPORTED[key]!
      const blob = await entry.getData(new BlobWriter(info.mediaType))
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const base = entry.filename.split(/[\\/]/).pop() ?? entry.filename
      out.push({
        name: base.replace(/\.([a-z0-9]+)$/i, ''),
        image: { bytes, mediaType: info.mediaType, ext: info.ext },
      })
    }
    return out
  } finally {
    await reader.close()
  }
}

/** 只用于提示里区分 cbz / zip */
function archiveLabel(fileName: string): string {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase()
  return ext === 'zip' ? 'ZIP 压缩包' : 'CBZ 漫画包'
}
