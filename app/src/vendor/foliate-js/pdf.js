// PDF 只读渲染：基于 foliate-js 的 pdf.js（MIT）实现，运行时加载 public/pdfjs 下的 pdfjs 资源。
// pdfjs 单文件较大（pdf.mjs 约 0.8MB、worker 约 2.2MB、cmaps/standard_fonts 约 1.9MB），
// 放在 public 目录而不是打进 bundle，按需拉取。

const pdfjsPath = (name) => new URL(`pdfjs/${name}`, document.baseURI).toString()

let pdfjsLib
let pdfjsPromise

const loadPdfjs = () => {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ pdfjsPath('pdf.mjs')).then(() => {
      pdfjsLib = globalThis.pdfjsLib
      if (!pdfjsLib) throw new Error('PDF 引擎加载失败')
      pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.mjs')
      return pdfjsLib
    })
  }
  return pdfjsPromise
}

const fetchText = async (url) => {
  try {
    return await (await fetch(url)).text()
  } catch {
    return ''
  }
}

let layerCSSPromise
const loadLayerCSS = () => {
  if (!layerCSSPromise) {
    layerCSSPromise = Promise.all([
      fetchText(pdfjsPath('text_layer_builder.css')),
      fetchText(pdfjsPath('annotation_layer_builder.css')),
    ]).then(([textLayer, annotationLayer]) => ({ textLayer, annotationLayer }))
  }
  return layerCSSPromise
}

const render = async (page, doc, zoom) => {
  const scale = zoom * devicePixelRatio
  doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
  doc.documentElement.style.transformOrigin = 'top left'
  doc.documentElement.style.setProperty('--scale-factor', scale)
  const viewport = page.getViewport({ scale })

  // canvas 必须放在 PDFDocument 的 ownerDocument（默认 globalThis.document）里，字体在那里加载
  const canvas = document.createElement('canvas')
  canvas.height = viewport.height
  canvas.width = viewport.width
  const canvasContext = canvas.getContext('2d')
  await page.render({ canvasContext, viewport }).promise
  doc.querySelector('#canvas').replaceChildren(doc.adoptNode(canvas))

  const container = doc.querySelector('.textLayer')
  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: await page.streamTextContent(),
    container,
    viewport,
  })
  await textLayer.render()

  // 隐藏文字层渲染时塞进 document 的离屏 canvas
  for (const hidden of document.querySelectorAll('.hiddenCanvasElement')) {
    Object.assign(hidden.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '0',
      height: '0',
      display: 'none',
    })
  }

  const endOfContent = document.createElement('div')
  endOfContent.className = 'endOfContent'
  container.append(endOfContent)
  container.onpointerdown = () => container.classList.add('selecting')
  container.onpointerup = () => container.classList.remove('selecting')

  const div = doc.querySelector('.annotationLayer')
  const linkService = {
    goToDestination: () => {},
    getDestinationHash: (dest) => JSON.stringify(dest),
    addLinkAttributes: (link, url) => (link.href = url),
  }
  await new pdfjsLib.AnnotationLayer({ page, viewport, div, linkService }).render({
    annotations: await page.getAnnotations(),
  })
}

const renderPage = async (page, getImageBlob) => {
  const viewport = page.getViewport({ scale: 1 })
  if (getImageBlob) {
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    await page.render({ canvasContext, viewport }).promise
    return new Promise((resolve) => canvas.toBlob(resolve))
  }
  const { textLayer: textLayerCSS, annotationLayer: annotationLayerCSS } = await loadLayerCSS()
  const src = URL.createObjectURL(
    new Blob(
      [
        `
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${viewport.width}, height=${viewport.height}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
        }
        :root {
          --user-unit: 1;
          --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
          --scale-round-x: 1px;
          --scale-round-y: 1px;
        }
        ${textLayerCSS}
        ${annotationLayerCSS}
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
        `,
      ],
      { type: 'text/html' },
    ),
  )
  const onZoom = ({ doc, scale }) => render(page, doc, scale)
  return { src, onZoom }
}

const makeTOCItem = (item) => ({
  label: item.title,
  href: JSON.stringify(item.dest),
  subitems: item.items.length ? item.items.map(makeTOCItem) : null,
})

export const makePDF = async (file) => {
  await loadPdfjs()
  const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
  transport.requestDataRange = (begin, end) => {
    file.slice(begin, end).arrayBuffer().then((chunk) => {
      transport.onDataRange(begin, chunk)
    })
  }
  const pdf = await pdfjsLib.getDocument({
    range: transport,
    cMapUrl: pdfjsPath('cmaps/'),
    standardFontDataUrl: pdfjsPath('standard_fonts/'),
    isEvalSupported: false,
  }).promise

  const book = { rendition: { layout: 'pre-paginated' } }

  const { metadata, info } = (await pdf.getMetadata()) ?? {}
  book.metadata = {
    title: metadata?.get('dc:title') ?? info?.Title,
    author: metadata?.get('dc:creator') ?? info?.Author,
    contributor: metadata?.get('dc:contributor'),
    description: metadata?.get('dc:description') ?? info?.Subject,
    language: metadata?.get('dc:language'),
    publisher: metadata?.get('dc:publisher'),
    subject: metadata?.get('dc:subject'),
    identifier: metadata?.get('dc:identifier'),
    source: metadata?.get('dc:source'),
    rights: metadata?.get('dc:rights'),
  }

  const outline = await pdf.getOutline()
  book.toc = outline?.map(makeTOCItem)

  const cache = new Map()
  book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
    id: i,
    load: async () => {
      const cached = cache.get(i)
      if (cached) return cached
      const url = await renderPage(await pdf.getPage(i + 1))
      cache.set(i, url)
      return url
    },
    size: 1000,
  }))
  book.isExternal = (uri) => /^\w+:/i.test(uri)
  book.resolveHref = async (href) => {
    const parsed = JSON.parse(href)
    const dest = typeof parsed === 'string' ? await pdf.getDestination(parsed) : parsed
    const index = await pdf.getPageIndex(dest[0])
    return { index }
  }
  book.splitTOCHref = async (href) => {
    const parsed = JSON.parse(href)
    const dest = typeof parsed === 'string' ? await pdf.getDestination(parsed) : parsed
    const index = await pdf.getPageIndex(dest[0])
    return [index, null]
  }
  book.getTOCFragment = (doc) => doc.documentElement
  book.getCover = async () => renderPage(await pdf.getPage(1), true)
  book.destroy = () => pdf.destroy()
  return book
}
