import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import Icon from './Icon'
import {
  buildEpub,
  bytesToBase64,
  type EpubCover,
  type EpubStylePreset,
  type EpubTreeNode,
} from '../lib/epub-writer'
import { decodeText } from '../lib/encoding'
import { parseDraft } from '../lib/draft-import'
import type { TxtChapter } from '../lib/txt-chapters'

type Props = {
  exportDir?: string | null
  /** 设置页「新建书默认样式」传来的初始预设 */
  initialPreset?: EpubStylePreset
  onClose: () => void
  onNotify: (msg: string) => void
  onOpenSaved: (path: string) => void
}

type DraftImage = {
  bytes: Uint8Array
  mediaType: string
  ext: string
  name: string
  url: string
}

/** 章节树节点：volume=true 表示「分卷」分组（仍可带正文，成为分卷页） */
type DraftNode = {
  id: string
  volume: boolean
  title: string
  text: string
  image: DraftImage | null
  children: DraftNode[]
}

type BackDraft = { title: string; text: string }

const PRESETS: { id: EpubStylePreset; name: string; desc: string }[] = [
  { id: 'zh-serif', name: '中文衬线', desc: '宋体正文 · 首行缩进 · 标题居中' },
  { id: 'en-serif', name: '英文小说', desc: 'Georgia · 1.65 行距 · 不缩进' },
  { id: 'minimal', name: '极简无衬线', desc: '黑体 · 左对齐 · 无缩进' },
]

const LANGUAGES: [string, string][] = [
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁体中文'],
  ['en', '英语'],
  ['ja', '日语'],
]

const IMAGE_TYPES: Record<string, { mime: string; ext: string }> = {
  jpg: { mime: 'image/jpeg', ext: 'jpg' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
  gif: { mime: 'image/gif', ext: 'gif' },
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名'
}
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
function readableError(err: unknown): string {
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  return String(err)
}

let idSeq = 0
function nextId(): string {
  idSeq += 1
  return `n${Date.now().toString(36)}-${idSeq}`
}

function makeNode(volume: boolean, title: string, text = ''): DraftNode {
  return { id: nextId(), volume, title, text, image: null, children: [] }
}

/** 深度优先遍历，回调里拿到每个节点（不映射） */
function walkNodes(nodes: DraftNode[], visit: (node: DraftNode, depth: number) => void, depth = 0) {
  nodes.forEach((node) => {
    visit(node, depth)
    if (node.children.length) walkNodes(node.children, visit, depth + 1)
  })
}

function findNode(nodes: DraftNode[], id: string): DraftNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    const nested = findNode(node.children, id)
    if (nested) return nested
  }
  return null
}

type NodeLocation = { siblings: DraftNode[]; index: number; parent: DraftNode | null; depth: number }

function locateNode(
  nodes: DraftNode[],
  id: string,
  parent: DraftNode | null = null,
  depth = 0,
): NodeLocation | null {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!
    if (node.id === id) return { siblings: nodes, index, parent, depth }
    const nested = locateNode(node.children, id, node, depth + 1)
    if (nested) return nested
  }
  return null
}

/** 用回调替换指定节点（返回 null 表示删除） */
function mapNode(nodes: DraftNode[], id: string, fn: (node: DraftNode) => DraftNode | null): DraftNode[] {
  const out: DraftNode[] = []
  nodes.forEach((node) => {
    if (node.id === id) {
      const next = fn(node)
      if (next) out.push(next)
      return
    }
    if (node.children.length) out.push({ ...node, children: mapNode(node.children, id, fn) })
    else out.push(node)
  })
  return out
}

/** 删除节点，返回新树与被删节点 */
function removeNode(nodes: DraftNode[], id: string): { list: DraftNode[]; removed: DraftNode | null } {
  let removed: DraftNode | null = null
  const walk = (list: DraftNode[]): DraftNode[] => {
    const out: DraftNode[] = []
    list.forEach((node) => {
      if (node.id === id) {
        removed = node
        return
      }
      out.push(node.children.length ? { ...node, children: walk(node.children) } : node)
    })
    return out
  }
  return { list: walk(nodes), removed }
}

/** 在目标节点的同层插入（after=true 放后面） */
function insertNear(
  nodes: DraftNode[],
  targetId: string,
  node: DraftNode,
  after: boolean,
): DraftNode[] | null {
  const index = nodes.findIndex((item) => item.id === targetId)
  if (index >= 0) {
    const copy = nodes.slice()
    copy.splice(after ? index + 1 : index, 0, node)
    return copy
  }
  for (let i = 0; i < nodes.length; i += 1) {
    const current = nodes[i]!
    if (!current.children.length) continue
    const nested = insertNear(current.children, targetId, node, after)
    if (nested) {
      const copy = nodes.slice()
      copy[i] = { ...current, children: nested }
      return copy
    }
  }
  return null
}

function replaceSiblings(nodes: DraftNode[], parentId: string | null, next: DraftNode[]): DraftNode[] {
  if (!parentId) return next
  return mapNode(nodes, parentId, (node) => ({ ...node, children: next }))
}

function treeStats(nodes: DraftNode[]) {
  let chapters = 0
  let volumes = 0
  let chars = 0
  walkNodes(nodes, (node) => {
    const paragraphs = node.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    chars += paragraphs.join('').length
    if (node.volume) volumes += 1
    if (!node.volume && paragraphs.length > 0) chapters += 1
  })
  return { chapters, volumes, chars }
}

/** 草稿树 → 生成器树；空页与空分卷在这里被剔除 */
function toEpubTree(nodes: DraftNode[]): EpubTreeNode[] {
  const out: EpubTreeNode[] = []
  nodes.forEach((node, index) => {
    const paragraphs = node.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const children = toEpubTree(node.children)
    const title = node.title.trim() || (node.volume ? `第 ${index + 1} 卷` : `第 ${index + 1} 章`)
    if (paragraphs.length === 0 && !node.image && children.length === 0) return
    out.push({
      title,
      paragraphs,
      children: children.length > 0 ? children : undefined,
      image: node.image
        ? { bytes: node.image.bytes, mediaType: node.image.mediaType, ext: node.image.ext }
        : undefined,
    })
  })
  return out
}

function hasContent(nodes: EpubTreeNode[]): boolean {
  return nodes.some(
    (node) =>
      (node.paragraphs?.length ?? 0) > 0 || !!node.image || hasContent(node.children ?? []),
  )
}

export default function NewBookWizard({ exportDir, initialPreset = 'zh-serif', onClose, onNotify, onOpenSaved }: Props) {
  const [step, setStep] = useState<1 | 2>(1)

  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('佚名')
  const [language, setLanguage] = useState('zh-CN')
  const [preset, setPreset] = useState<EpubStylePreset>(initialPreset)
  const [translator, setTranslator] = useState('')
  const [description, setDescription] = useState('')
  const [rights, setRights] = useState('')

  const [cover, setCover] = useState<EpubCover | null>(null)
  const [coverName, setCoverName] = useState('')
  const [coverUrl, setCoverUrl] = useState<string | null>(null)

  const [tree, setTree] = useState<DraftNode[]>(() => [makeNode(false, '第 1 章')])
  const [backMatter, setBackMatter] = useState<BackDraft[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropHint, setDropHint] = useState<{ id: string; after: boolean } | null>(null)
  const dropHintRef = useRef<{ id: string; after: boolean } | null>(null)

  const [importing, setImporting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')

  const coverUrlRef = useRef<string | null>(null)
  const objectUrlsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    coverUrlRef.current = coverUrl
  }, [coverUrl])

  useEffect(
    () => () => {
      if (coverUrlRef.current) URL.revokeObjectURL(coverUrlRef.current)
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
      objectUrlsRef.current.clear()
    },
    [],
  )

  const notify = useCallback(
    (message: string) => {
      onNotify(message)
    },
    [onNotify],
  )

  // ─── 章节树操作 ───

  const addNode = (volume: boolean) => {
    const node = makeNode(volume, volume ? '新分卷' : '新章节')
    const selected = selectedId ? findNode(tree, selectedId) : null
    setTree((prev) => {
      if (selected && !volume && selected.volume) {
        return mapNode(prev, selected.id, (item) => ({ ...item, children: [...item.children, node] }))
      }
      if (selected) {
        const inserted = insertNear(prev, selected.id, node, true)
        if (inserted) return inserted
      }
      return [...prev, node]
    })
    setSelectedId(node.id)
  }

  const moveNode = (id: string, delta: number) => {
    const loc = locateNode(tree, id)
    if (!loc) return
    const target = loc.index + delta
    if (target < 0 || target >= loc.siblings.length) return
    const reordered = loc.siblings.slice()
    reordered[loc.index] = loc.siblings[target]!
    reordered[target] = loc.siblings[loc.index]!
    setTree((prev) => replaceSiblings(prev, loc.parent?.id ?? null, reordered))
  }

  const indentNode = (id: string) => {
    const loc = locateNode(tree, id)
    if (!loc) return
    if (loc.index === 0) {
      notify('已经是第一项，无法降级')
      return
    }
    if (loc.depth >= 2) {
      notify('最多三层：正文 → 分卷 → 章')
      return
    }
    const previous = loc.siblings[loc.index - 1]!
    const { list, removed } = removeNode(tree, id)
    if (!removed) return
    setTree(mapNode(list, previous.id, (node) => ({ ...node, children: [...node.children, removed] })))
  }

  const outdentNode = (id: string) => {
    const loc = locateNode(tree, id)
    if (!loc?.parent) {
      notify('已经在最外层')
      return
    }
    const parentId = loc.parent.id
    const { list, removed } = removeNode(tree, id)
    if (!removed) return
    const inserted = insertNear(list, parentId, removed, true)
    setTree(inserted ?? list)
  }

  const mergeNode = (id: string) => {
    const loc = locateNode(tree, id)
    if (!loc || loc.index === 0) {
      notify('没有可合并的上一章')
      return
    }
    const node = loc.siblings[loc.index]!
    const previous = loc.siblings[loc.index - 1]!
    if (node.children.length || previous.children.length || node.volume || previous.volume) {
      notify('只能合并两个正文章节；分卷请先移出子章节')
      return
    }
    const mergedText = [previous.text.trim(), node.text.trim()].filter(Boolean).join('\n')
    if (previous.image && node.image) URL.revokeObjectURL(node.image.url)
    objectUrlsRef.current.delete(node.image?.url ?? '')
    setTree((prev) => {
      const { list } = removeNode(prev, node.id)
      return mapNode(list, previous.id, (item) => ({
        ...item,
        text: mergedText,
        image: item.image ?? node.image,
      }))
    })
    setSelectedId(previous.id)
  }

  const splitNode = (id: string) => {
    const node = findNode(tree, id)
    if (!node || node.volume || node.children.length) {
      notify('只能拆分正文章节')
      return
    }
    const lines = node.text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length < 2) {
      notify('正文不足两段，无法拆分')
      return
    }
    const middle = Math.ceil(lines.length / 2)
    const created = makeNode(false, `${node.title.trim() || '章节'}（续）`, lines.slice(middle).join('\n'))
    setTree((prev) => {
      const updated = mapNode(prev, id, (item) => ({ ...item, text: lines.slice(0, middle).join('\n') }))
      return insertNear(updated, id, created, true) ?? updated
    })
    setSelectedId(created.id)
  }

  const removeTreeNode = (id: string) => {
    const node = findNode(tree, id)
    if (!node) return
    if (node.image) {
      URL.revokeObjectURL(node.image.url)
      objectUrlsRef.current.delete(node.image.url)
    }
    const { list } = removeNode(tree, id)
    setTree(list.length > 0 ? list : [makeNode(false, '第 1 章')])
    if (selectedId === id) setSelectedId(null)
  }

  const pickIllustration = useCallback(
    async (id: string) => {
      try {
        const picked = await open({
          multiple: false,
          title: '选择章节插图',
          filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
        })
        if (typeof picked !== 'string') return
        const kind = IMAGE_TYPES[(picked.split('.').pop() ?? '').toLowerCase()]
        if (!kind) {
          setError('不支持的图片格式：只接受 JPG / PNG / WebP / GIF')
          return
        }
        const buffer = await invoke<ArrayBuffer>('read_book', { path: picked })
        const url = URL.createObjectURL(new Blob([buffer], { type: kind.mime }))
        objectUrlsRef.current.add(url)
        const previousUrl = findNode(tree, id)?.image?.url
        if (previousUrl) {
          URL.revokeObjectURL(previousUrl)
          objectUrlsRef.current.delete(previousUrl)
        }
        setTree((prev) =>
          mapNode(prev, id, (node) => ({
            ...node,
            image: {
              bytes: new Uint8Array(buffer),
              mediaType: kind.mime,
              ext: kind.ext,
              name: baseName(picked),
              url,
            },
          })),
        )
        setError('')
      } catch (err) {
        setError(`读取插图失败：${readableError(err)}`)
      }
    },
    [tree],
  )

  const clearIllustration = (id: string) => {
    const node = findNode(tree, id)
    if (node?.image) {
      URL.revokeObjectURL(node.image.url)
      objectUrlsRef.current.delete(node.image.url)
    }
    setTree((prev) => mapNode(prev, id, (item) => ({ ...item, image: null })))
  }

  // ─── 同层拖拽排序 ───

  useEffect(() => {
    if (!dragId) return
    const move = (e: PointerEvent) => {
      const hit = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)
        ?.closest('[data-node-id]') as HTMLElement | null
      if (!hit) {
        dropHintRef.current = null
        setDropHint(null)
        return
      }
      const targetId = hit.dataset.nodeId ?? ''
      if (!targetId || targetId === dragId) return
      const rect = hit.getBoundingClientRect()
      const hint = { id: targetId, after: e.clientY > rect.top + rect.height / 2 }
      dropHintRef.current = hint
      setDropHint(hint)
    }
    const up = () => {
      const hint = dropHintRef.current
      if (hint && dragId) {
        const source = locateNode(tree, dragId)
        const target = locateNode(tree, hint.id)
        if (source && target) {
          if (source.siblings !== target.siblings) {
            notify('只能在同一个层级内拖动排序')
          } else {
            const { list, removed } = removeNode(tree, dragId)
            if (removed) {
              const inserted = insertNear(list, hint.id, removed, hint.after)
              setTree(inserted ?? list)
            }
          }
        }
      }
      dropHintRef.current = null
      setDropHint(null)
      setDragId(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [dragId, tree, notify])

  // ─── 封面 ───

  const pickCover = useCallback(async () => {
    try {
      const picked = await open({
        multiple: false,
        title: '选择封面图片',
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
      })
      if (typeof picked !== 'string') return
      const kind = IMAGE_TYPES[(picked.split('.').pop() ?? '').toLowerCase()]
      if (!kind) {
        setError('不支持的封面格式：只接受 JPG / PNG / WebP / GIF')
        return
      }
      const buffer = await invoke<ArrayBuffer>('read_book', { path: picked })
      const next: EpubCover = { bytes: new Uint8Array(buffer), mediaType: kind.mime, ext: kind.ext }
      setCover(next)
      setCoverName(baseName(picked))
      setCoverUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return URL.createObjectURL(new Blob([buffer], { type: kind.mime }))
      })
      setError('')
    } catch (err) {
      setError(`读取封面失败：${readableError(err)}`)
    }
  }, [])

  const clearCover = () => {
    setCover(null)
    setCoverName('')
    setCoverUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
  }

  // ─── 导入章节 ───

  const importFile = useCallback(async () => {
    if (importing) return
    setError('')
    try {
      const picked = await open({
        multiple: false,
        title: '导入章节来源（TXT / Markdown / HTML）',
        filters: [
          { name: '可导入的文本', extensions: ['txt', 'md', 'markdown', 'html', 'htm'] },
          { name: '纯文本', extensions: ['txt'] },
          { name: 'Markdown', extensions: ['md', 'markdown'] },
          { name: 'HTML', extensions: ['html', 'htm'] },
        ],
      })
      if (typeof picked !== 'string') return
      setImporting(true)
      const buffer = await invoke<ArrayBuffer>('read_book', { path: picked })
      const decoded = decodeText(buffer)
      const parsed = parseDraft(baseName(picked), decoded.text)
      if (parsed.length === 0) {
        setError('这个文件里没有可用的正文')
        return
      }
      const imported: DraftNode[] = parsed.map((chapter: TxtChapter, index) =>
        makeNode(false, chapter.title?.trim() || `第 ${index + 1} 章`, chapter.paragraphs.join('\n')),
      )
      const hasExisting = tree.some((node) => node.text.trim() || node.children.length > 0)
      setTree((prev) => (hasExisting ? [...prev, ...imported] : imported))
      onNotify(`已导入 ${imported.length} 章`)
    } catch (err) {
      setError(`导入失败：${readableError(err)}`)
    } finally {
      setImporting(false)
    }
  }, [importing, tree, onNotify])

  // ─── 后置页 ───

  const patchBack = (index: number, patch: Partial<BackDraft>) => {
    setBackMatter((list) => list.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  }
  const addBack = () => {
    setBackMatter((list) => [...list, { title: '番外', text: '' }])
  }
  const removeBack = (index: number) => {
    setBackMatter((list) => list.filter((_, i) => i !== index))
  }

  // ─── 生成 ───

  const structure = toEpubTree(tree)
  const stats = treeStats(tree)
  const backItems = backMatter
    .map((item) => ({
      title: item.title.trim() || '番外',
      paragraphs: item.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    }))
    .filter((item) => item.paragraphs.length > 0)
  const canGenerate = title.trim().length > 0 && (hasContent(structure) || backItems.length > 0)

  const generate = async () => {
    if (!canGenerate || generating) return
    setError('')
    try {
      const dir = (exportDir || '').replace(/[\\/]$/, '')
      const fileName = `${safeFileName(title.trim())}.epub`
      const target = await save({
        title: '保存新建的 EPUB',
        defaultPath: dir ? `${dir}/${fileName}` : fileName,
        filters: [{ name: 'EPUB 电子书', extensions: ['epub'] }],
      })
      if (typeof target !== 'string') return
      setGenerating(true)
      setStage('正在打包目录与章节…')
      await new Promise((resolve) => window.setTimeout(resolve, 30))
      const bytes = buildEpub([], {
        title: title.trim(),
        author: author.trim() || '佚名',
        language,
        translator: translator.trim() || undefined,
        description: description.trim() || undefined,
        rights: rights.trim() || undefined,
        structure,
        backMatter: backItems,
        stylePreset: preset,
        cover,
      })
      setStage(`正在写入 ${formatSize(bytes.length)}…`)
      await invoke<number>('save_epub', { path: target, base64: bytesToBase64(bytes) })
      setStage('')
      onNotify('新书已生成，正在打开编辑器')
      onOpenSaved(target)
    } catch (err) {
      setStage('')
      setError(`生成失败：${readableError(err)}`)
    } finally {
      setGenerating(false)
    }
  }

  // ─── 渲染 ───

  const renderTree = (nodes: DraftNode[], depth: number) =>
    nodes.map((node, index) => (
      <div className="nb-node-wrap" key={node.id}>
        <article
          data-node-id={node.id}
          className={`nb-chapter nb-node ${node.volume ? 'volume' : ''} ${
            selectedId === node.id ? 'sel' : ''
          } ${dragId === node.id ? 'drag-src' : ''} ${
            dropHint?.id === node.id ? (dropHint.after ? 'drop-after' : 'drop-before') : ''
          }`}
          style={{ marginLeft: depth * 18 }}
          onClick={() => setSelectedId(node.id)}
        >
          <div className="nb-chapter-head">
            <button
              className="nb-drag-handle"
              data-tip="按住拖动，可在同层排序"
              aria-label="拖动排序"
              onPointerDown={(e) => {
                e.preventDefault()
                setSelectedId(node.id)
                setDragId(node.id)
              }}
            >
              <Icon name="drag_indicator" size={16} />
            </button>
            <span className="nb-chapter-no">{node.volume ? '卷' : index + 1}</span>
            <input
              className="nb-chapter-title"
              value={node.title}
              placeholder={node.volume ? '分卷标题' : `第 ${index + 1} 章`}
              onChange={(e) =>
                setTree((prev) => mapNode(prev, node.id, (item) => ({ ...item, title: e.target.value })))
              }
            />
            <span className={`nb-kind ${node.volume ? 'on' : ''}`}>
              {node.volume ? '分卷' : node.children.length > 0 ? '分卷' : '正文'}
            </span>
            <span className="grow" />
            <button
              className="btn small icon-only"
              data-tip="上移"
              aria-label="上移"
              disabled={index === 0}
              onClick={() => moveNode(node.id, -1)}
            ><Icon name="arrow_upward" size={16} /></button>
            <button
              className="btn small icon-only"
              data-tip="下移"
              aria-label="下移"
              disabled={index === nodes.length - 1}
              onClick={() => moveNode(node.id, 1)}
            ><Icon name="arrow_downward" size={16} /></button>
            <button
              className="btn small icon-only"
              data-tip="降级：成为上一项的子项"
              aria-label="降级"
              disabled={index === 0}
              onClick={() => indentNode(node.id)}
            ><Icon name="format_indent_increase" size={16} /></button>
            <button
              className="btn small icon-only"
              data-tip="升级：移出当前分卷"
              aria-label="升级"
              onClick={() => outdentNode(node.id)}
            ><Icon name="format_indent_decrease" size={16} /></button>
            <button
              className="btn small icon-only"
              data-tip="与上一章合并"
              aria-label="合并"
              onClick={() => mergeNode(node.id)}
            ><Icon name="call_merge" size={16} /></button>
            <button
              className="btn small icon-only"
              data-tip="从中间拆成两章"
              aria-label="拆分"
              onClick={() => splitNode(node.id)}
            ><Icon name="call_split" size={16} /></button>
            <button
              className="btn small icon-only"
              data-tip={node.image ? '更换插图' : '插入插图'}
              aria-label="插入插图"
              onClick={() => void pickIllustration(node.id)}
            ><Icon name="image" size={16} /></button>
            <button
              className="btn small icon-only"
              data-tip="删除"
              aria-label="删除"
              onClick={() => removeTreeNode(node.id)}
            ><Icon name="delete" size={16} /></button>
          </div>
          {node.volume ? (
            <div className="nb-volume-hint">
              {node.children.length > 0
                ? `分卷分组 · ${node.children.length} 项`
                : '分卷分组（可在下方添加章节，或把下一项降级进来）'}
            </div>
          ) : (
            <textarea
              className="nb-chapter-text"
              value={node.text}
              placeholder="每行一段，空行会被忽略"
              spellCheck={false}
              onChange={(e) =>
                setTree((prev) => mapNode(prev, node.id, (item) => ({ ...item, text: e.target.value })))
              }
            />
          )}
          {node.image && (
            <div className="nb-illust">
              <img src={node.image.url} alt="章节插图预览" />
              <span className="nb-illust-name">{node.image.name}</span>
              <button className="btn small" onClick={() => clearIllustration(node.id)}>移除插图</button>
            </div>
          )}
        </article>
        {node.children.length > 0 && renderTree(node.children, depth + 1)}
      </div>
    ))

  const autoPages = [
    { key: 'cover', label: '封面', on: !!cover, hint: cover ? '已选封面' : '未选封面，不生成' },
    { key: 'title', label: '书名页', on: true, hint: '自动生成' },
    {
      key: 'intro',
      label: '简介',
      on: description.trim().length > 0 || rights.trim().length > 0,
      hint: description.trim() || rights.trim() ? '已填写' : '未填写，不生成',
    },
    { key: 'toc', label: '目录', on: true, hint: '自动生成' },
  ]

  return (
    <div className="wizard-mask" onClick={() => (generating ? null : onClose())}>
      <div className="wizard nb-wizard" onClick={(e) => e.stopPropagation()}>
        <header className="wizard-head">
          <span className="wizard-title">新建书</span>
          <span className="wizard-step">
            第 {step} 步 / 共 2 步 · {step === 1 ? '书籍信息与样式' : '目录结构与正文'}
          </span>
          <span className="grow" />
          <button
            className="btn small icon-only"
            data-tip="关闭新建向导（Esc）"
            aria-label="关闭新建向导"
            disabled={generating}
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        {step === 1 ? (
          <>
            <div className="wizard-body nb-body">
              <section className="nb-col">
                <div className="wiz-label">基本信息</div>
                <label className="nb-field">
                  <span>书名</span>
                  <input
                    value={title}
                    autoFocus
                    placeholder="例如：我的第一本书"
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <label className="nb-field">
                  <span>作者</span>
                  <input value={author} placeholder="佚名" onChange={(e) => setAuthor(e.target.value)} />
                </label>
                <label className="nb-field">
                  <span>语言</span>
                  <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                    {LANGUAGES.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
                <label className="nb-field">
                  <span>译者</span>
                  <input
                    value={translator}
                    placeholder="可选，留空则不显示译者"
                    onChange={(e) => setTranslator(e.target.value)}
                  />
                </label>
                <label className="nb-field nb-area">
                  <span>简介</span>
                  <textarea
                    value={description}
                    placeholder="可选，每行一段，生成独立的「简介」页"
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
                <label className="nb-field nb-area">
                  <span>版权</span>
                  <textarea
                    value={rights}
                    placeholder="可选，附在简介页末尾，例如 © 2026 作者"
                    onChange={(e) => setRights(e.target.value)}
                  />
                </label>
                <div className="nb-field nb-cover">
                  <span>封面</span>
                  <div className="nb-cover-row">
                    <div className="nb-cover-thumb">
                      {coverUrl ? <img src={coverUrl} alt="封面预览" /> : <span>无封面</span>}
                    </div>
                    <div className="nb-cover-ops">
                      <button className="btn small" onClick={() => void pickCover()}>
                        <Icon name="image" size={16} /> 选择图片
                      </button>
                      {cover && (
                        <button className="btn small" onClick={clearCover}>移除</button>
                      )}
                      <span className="nb-cover-name">{coverName || '可选，建议 1200×1800 竖图'}</span>
                    </div>
                  </div>
                </div>
              </section>

              <section className="nb-col">
                <div className="wiz-label">样式预设</div>
                <div className="nb-presets">
                  {PRESETS.map((item) => (
                    <button
                      key={item.id}
                      className={`nb-preset ${preset === item.id ? 'on' : ''}`}
                      onClick={() => setPreset(item.id)}
                    >
                      <span className={`nb-preset-sample ${item.id}`} aria-hidden="true">A字</span>
                      <span className="nb-preset-name">{item.name}</span>
                      <span className="nb-preset-desc">{item.desc}</span>
                    </button>
                  ))}
                </div>
                <p className="nb-hint">样式写进书里的 style.css，生成后仍可在编辑器的源码视图里改。</p>
              </section>
            </div>
            <footer className="wizard-actions nb-actions">
              <button className="btn" onClick={onClose}>取消</button>
              <span className="grow" />
              <button className="btn primary" disabled={!title.trim()} onClick={() => setStep(2)}>
                下一步：目录结构
              </button>
            </footer>
          </>
        ) : (
          <>
            <div className="wizard-body nb-body nb-chapters">
              <div className="nb-chapter-toolbar">
                <span className="wiz-label">目录结构</span>
                <span className="nb-stat">
                  {stats.chapters} 章 · {stats.volumes} 个分卷 · {stats.chars.toLocaleString()} 字
                </span>
                <span className="grow" />
                <button className="btn small" onClick={() => addNode(false)}>
                  <Icon name="add" size={16} /> 添加章节
                </button>
                <button className="btn small" onClick={() => addNode(true)}>
                  <Icon name="library_books" size={16} /> 添加分卷
                </button>
                <button className="btn small" disabled={importing} onClick={() => void importFile()}>
                  <Icon name="upload_file" size={16} /> 导入 TXT / MD / HTML
                </button>
              </div>

              <div className="nb-chapter-list">
                <section className="nb-structure">
                  <div className="nb-structure-head">
                    <span className="wiz-label">自动页</span>
                    <span className="nb-hint">前置结构由信息与样式决定，打开书时按此顺序出现</span>
                  </div>
                  <div className="nb-auto-pages">
                    {autoPages.map((item) => (
                      <span key={item.key} className={`nb-chip ${item.on ? 'on' : 'off'}`} data-tip={item.hint}>
                        {item.label}
                      </span>
                    ))}
                    <span className="nb-chip on" data-tip="按目录结构自动分组">正文</span>
                    <span className="nb-chip on" data-tip="正文之后按顺序生成">后置</span>
                  </div>
                </section>

                <div className="nb-tree-head">
                  <span className="wiz-label">正文</span>
                  <span className="nb-hint">
                    拖动左侧手柄排序；用升降级按钮做「正文 → 分卷 → 章」；合并/拆分只作用于正文章节
                  </span>
                </div>

                {renderTree(tree, 0)}

                <div className="nb-subhead">
                  <span className="wiz-label">番外 / 后记</span>
                  <span className="nb-stat">{backMatter.length} 篇</span>
                  <span className="grow" />
                  <button className="btn small" onClick={addBack}>
                    <Icon name="add" size={16} /> 添加后置页
                  </button>
                </div>

                {backMatter.map((item, index) => (
                  <article className="nb-chapter" key={`back-${index}`}>
                    <div className="nb-chapter-head">
                      <span className="nb-chapter-no">附</span>
                      <input
                        className="nb-chapter-title"
                        value={item.title}
                        placeholder="番外 / 后记标题"
                        onChange={(e) => patchBack(index, { title: e.target.value })}
                      />
                      <span className="nb-kind">后置</span>
                      <span className="grow" />
                      <button
                        className="btn small icon-only"
                        data-tip="删除后置页"
                        aria-label="删除后置页"
                        onClick={() => removeBack(index)}
                      ><Icon name="delete" size={16} /></button>
                    </div>
                    <textarea
                      className="nb-chapter-text"
                      value={item.text}
                      placeholder="每行一段；正文之后按顺序生成番外、后记等页面"
                      spellCheck={false}
                      onChange={(e) => patchBack(index, { text: e.target.value })}
                    />
                  </article>
                ))}
              </div>

              {error && <div className="nb-error">{error}</div>}
              {stage && <div className="nb-stage">{stage}</div>}
            </div>
            <footer className="wizard-actions nb-actions">
              <button className="btn" disabled={generating} onClick={() => setStep(1)}>上一步</button>
              <span className="grow" />
              <span className="nb-stat">
                {stats.chapters} 章 · {backMatter.length} 篇后置
              </span>
              <button className="btn primary" disabled={!canGenerate || generating} onClick={() => void generate()}>
                {generating ? '生成中…' : '生成 EPUB'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
