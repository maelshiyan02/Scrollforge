/** 三档界面主题：日间 / 护眼 / 夜间。色板本体在 styles.css 的 `:root[data-theme]` 里，这里只负责应用。 */

import type { ThemeMode } from './prefs'

const THEME_STYLE_ID = 'scrollforge-theme'

/** 把档位挂到根元素：所有 CSS 变量与颜色方案随之切换 */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement
  root.dataset.theme = mode
  root.style.colorScheme = mode === 'night' ? 'dark' : 'light'
}

type ReadingPalette = {
  page: string
  ink: string
  link: string
  imgFilter: string
}

/** 从根元素读阅读正文色板，避免在 TS 里重复维护一套色值 */
function readingPalette(): ReadingPalette {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    page: read('--reading-page', '#ffffff'),
    ink: read('--reading-ink', '#1f1b16'),
    link: read('--reading-link', '#a35312'),
    imgFilter: read('--reading-img-filter', 'none'),
  }
}

/** 向 foliate 的章节文档注入底色与文字色；日间不注入，保持书籍原样 */
export function applyReaderTheme(doc: Document, mode: ThemeMode): void {
  if (!doc?.head) return
  // 先把档位挂到根元素，保证下面的 readingPalette 读到的是目标档位而不是上一档
  applyTheme(mode)
  let style = doc.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = doc.createElement('style')
    style.id = THEME_STYLE_ID
    doc.head.appendChild(style)
  }
  if (mode === 'day') {
    style.textContent = ''
    return
  }
  const palette = readingPalette()
  const scheme = mode === 'night' ? 'dark' : 'light'
  style.textContent = `
    :root { color-scheme: ${scheme}; }
    html, body { background-color: ${palette.page} !important; color: ${palette.ink} !important; }
    a { color: ${palette.link} !important; }
    img { filter: ${palette.imgFilter} !important; }
  `
}
