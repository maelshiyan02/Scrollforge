import type { Typography } from '../types'

const STORE_KEY = 'scrollforge:typography'

export const DEFAULT_TYPOGRAPHY: Typography = {
  fontSize: 18,
  lineHeight: 1.9,
  indent: true,
}

export function loadTypography(): Typography {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return DEFAULT_TYPOGRAPHY
    const parsed = JSON.parse(raw) as Partial<Typography>
    return {
      fontSize: clampFontSize(Number(parsed.fontSize) || DEFAULT_TYPOGRAPHY.fontSize),
      lineHeight: Number(parsed.lineHeight) || DEFAULT_TYPOGRAPHY.lineHeight,
      indent: parsed.indent !== false,
    }
  } catch {
    return DEFAULT_TYPOGRAPHY
  }
}

export function saveTypography(value: Typography): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(value))
  } catch {
    // 忽略
  }
}

export function clampFontSize(size: number): number {
  return Math.min(34, Math.max(12, Math.round(size)))
}

/** 把排版设置注入 foliate 的章节文档（重置样式表里的默认值） */
export function applyTypography(doc: Document, value: Typography): void {
  if (!doc?.head) return
  let style = doc.getElementById('scrollforge-typography') as HTMLStyleElement | null
  if (!style) {
    style = doc.createElement('style')
    style.id = 'scrollforge-typography'
    doc.head.appendChild(style)
  }
  style.textContent = `
    html { font-size: ${value.fontSize}px !important; }
    body { line-height: ${value.lineHeight} !important; }
    p { text-indent: ${value.indent ? '2em' : '0'} !important; }
  `
}
