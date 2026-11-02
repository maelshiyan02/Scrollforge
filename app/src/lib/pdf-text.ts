/**
 * PDF 文字层提取（尽力而为）：扫描版 PDF 没有文字层，不做 OCR。
 * 复用 public/pdfjs 下的 pdfjs，与阅读器里的 PDF 渲染共用同一份资源。
 */

const pdfjsPath = (name: string) => new URL(`pdfjs/${name}`, document.baseURI).toString()

let libPromise: Promise<any> | undefined

function loadPdfjs(): Promise<any> {
  if (!libPromise) {
    libPromise = import(/* @vite-ignore */ pdfjsPath('pdf.mjs')).then(() => {
      const lib = (globalThis as any).pdfjsLib
      if (!lib) throw new Error('PDF 引擎加载失败')
      lib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.mjs')
      return lib
    })
  }
  return libPromise
}

/** 按 y 坐标把文字项拼回行，再按页之间空一行输出 */
export async function extractPdfText(file: File): Promise<string> {
  const pdfjsLib = await loadPdfjs()
  const pdf = await pdfjsLib.getDocument({
    data: await file.arrayBuffer(),
    cMapUrl: pdfjsPath('cmaps/'),
    standardFontDataUrl: pdfjsPath('standard_fonts/'),
    isEvalSupported: false,
  }).promise

  try {
    const pages: string[] = []
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const page = await pdf.getPage(index)
      const content = await page.getTextContent()
      const rows = new Map<number, { x: number; text: string }[]>()
      for (const item of content.items as any[]) {
        const text = String(item.str ?? '')
        if (!text) continue
        const y = Math.round(item.transform?.[5] ?? 0)
        const key = Math.round(y / 3) * 3
        const row = rows.get(key) ?? []
        row.push({ x: item.transform?.[4] ?? 0, text })
        rows.set(key, row)
      }
      const lines = Array.from(rows.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([, parts]) =>
          parts
            .sort((a, b) => a.x - b.x)
            .map((part) => part.text)
            .join('')
            .trim(),
        )
        .filter(Boolean)
      if (lines.length) pages.push(lines.join('\n'))
      page.cleanup?.()
    }
    const text = pages.join('\n\n')
    if (!text.trim()) {
      throw new Error('这个 PDF 没有可提取的文字层（可能是扫描版），暂不支持 OCR')
    }
    return text
  } finally {
    await pdf.destroy()
  }
}
