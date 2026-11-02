/**
 * 划词标注的本地存档：按书分 key，值为 CFI，重开书时按 CFI 复原。
 * Phase 2 仍用 localStorage（用户要求暂不接 SQLite）。
 */

export type Annotation = {
  /** EPUB CFI，定位高亮范围 */
  value: string
  /** 高亮颜色；只有笔记时为空，改用下划线绘制 */
  color?: string
  note?: string
  /** 用户拖动小字后的位置偏移（相对原文句首），下次打开书沿用 */
  noteOffset?: { x: number; y: number }
  /** 章节索引，换节渲染时用于快速筛选 */
  index: number
  /** 选中的原文，列表与提示用 */
  text: string
  createdAt: number
  updatedAt?: number
}

export const HIGHLIGHT_COLORS = [
  { name: '黄色高亮', value: '#f2cf66' },
  { name: '橙色高亮', value: '#f2b366' },
  { name: '绿色高亮', value: '#a9d6a0' },
  { name: '蓝色高亮', value: '#9cc7e8' },
  { name: '紫色高亮', value: '#bfa6e8' },
  { name: '粉色高亮', value: '#f0a6c8' },
] as const

const PREFIX = 'scrollforge:annotations:'

export function loadAnnotations(key: string): Annotation[] {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Annotation[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item) =>
        item &&
        typeof item.value === 'string' &&
        item.value.length > 0 &&
        typeof item.index === 'number',
    )
  } catch {
    return []
  }
}

export function saveAnnotations(key: string, list: Annotation[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(PREFIX + key)
    else localStorage.setItem(PREFIX + key, JSON.stringify(list))
  } catch {
    // 存档失败不打断阅读
  }
}
