/**
 * 书封缓存：导入 EPUB 时把封面抽到书库目录，书架按需读出来变成 blob URL。
 * 只在内存里缓存，删除书时一并释放。
 */
import { invoke } from '@tauri-apps/api/core'
import { makeBook } from '../vendor/foliate-js/view.js'
import type { BookMeta } from '../types'

const cache = new Map<string, string | null>()
const loading = new Map<string, Promise<string | null>>()

function mimeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'jpeg' || ext === 'jpg') return 'image/jpeg'
  return 'application/octet-stream'
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** 用魔数判断真实图片类型；后端返回的一定是图片，但旧缓存可能是 xhtml，不能再迷信扩展名。 */
function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57) {
    return 'image/webp'
  }
  return null
}

/** 书封的 blob URL；没有封面或读取失败返回 null。 */
export function coverUrl(book: BookMeta): Promise<string | null> {
  // 扁平模型下 book.cover 可能是 null，但后端 read_cover 会自动 fallback（实时从 epub zip 解封面）
  // 所以不能因为 cover 字段为空就放弃 —— 照样调！
  const cached = cache.get(book.id)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = loading.get(book.id)
  if (pending) return pending
  const task = (async () => {
    try {
      const buffer = await invoke<ArrayBuffer>('read_cover', { id: book.id })
      const bytes = new Uint8Array(buffer)
      if (!bytes.length) {
        cache.set(book.id, null)
        return null
      }
      // 没有 book.cover 时用默认 image/jpeg（后端 fallback 提取的一般是 jpg）
      const mime = sniffMime(bytes) ?? (book.cover ? mimeOf(book.cover) : 'image/jpeg')
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
      cache.set(book.id, url)
      return url
    } catch {
      cache.set(book.id, null)
      return null
    } finally {
      loading.delete(book.id)
    }
  })()
  loading.set(book.id, task)
  return task
}

/** 删除书时释放 blob，避免内存泄漏。 */
export function forgetCover(id: string): void {
  const url = cache.get(id)
  if (url) URL.revokeObjectURL(url)
  cache.delete(id)
  loading.delete(id)
}

/** 书架自检/刷新后清空内存缓存，强制重新读盘。 */
export function clearCoverCache(): void {
  for (const url of cache.values()) {
    if (url) URL.revokeObjectURL(url)
  }
  cache.clear()
  loading.clear()
}

/** 把 EPUB 的封面抽出来写进书库目录，返回是否成功。 */
export async function extractCover(book: BookMeta): Promise<boolean> {
  if (book.format !== 'epub') return false
  try {
    const buffer = await invoke<ArrayBuffer>('read_book_bytes', { id: book.id })
    const file = new File([new Uint8Array(buffer)], book.sourceName || `${book.title}.epub`)
    const parsed = (await makeBook(file)) as { getCover?: () => Promise<Blob | null> | null }
    const blob = await Promise.resolve(parsed.getCover?.() ?? null)
    if (!blob || blob.size === 0) return false
    const type = blob.type || 'image/jpeg'
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('gif') ? 'gif' : 'jpg'
    const bytes = new Uint8Array(await blob.arrayBuffer())
    await invoke('save_cover', { id: book.id, base64: bytesToBase64(bytes), ext })
    return true
  } catch (err) {
    console.warn('抽取封面失败', err)
    return false
  }
}
