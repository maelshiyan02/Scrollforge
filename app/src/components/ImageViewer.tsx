/**
 * 全屏看图：缩放、拖拽平移、左右切换、Esc 关闭。
 * 阅读页内嵌图片与「彩页」画廊共用这一个查看器。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from './Icon'

export type ViewerImage = {
  url: string
  width: number
  height: number
  label?: string
}

type Props = {
  items: ViewerImage[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}

const MIN_ZOOM = 0.25
const MAX_ZOOM = 4

const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))

export default function ImageViewer({ items, index, onIndex, onClose }: Props) {
  const image = items[index]
  const hostRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean; onImage: boolean } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  // 换图时回到「适应窗口」
  useEffect(() => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }, [index])

  const applyZoom = useCallback((next: number) => {
    const previous = zoomRef.current
    const value = clampZoom(next)
    zoomRef.current = value
    setZoom(value)
    setOffset((point) => ({ x: point.x * (value / previous), y: point.y * (value / previous) }))
  }, [])

  // 滚轮缩放：必须非 passive，否则 preventDefault 无效
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = event.deltaY > 0 ? 0.87 : 1.15
      applyZoom(zoomRef.current * factor)
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [applyZoom])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    const onImage = Boolean((event.target as HTMLElement).closest('img'))
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y, moved: false, onImage }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 合成指针或已释放时忽略
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true
    setOffset({ x: drag.ox + dx, y: drag.oy + dy })
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // 指针已释放时忽略
    }
    if (!drag || drag.moved) return
    // 点图片：在当前缩放与 2 倍之间切换；点背景：关闭
    if (drag.onImage) {
      const wasZoomed = zoomRef.current > 1
      applyZoom(wasZoomed ? 1 : 2)
      if (wasZoomed) setOffset({ x: 0, y: 0 })
    } else {
      onClose()
    }
  }

  if (!image) return null
  const canPrev = index > 0
  const canNext = index < items.length - 1
  const zoomed = zoom > 1
  const percent = Math.round(zoom * 100)

  return (
    <div
      className="gallery-viewer image-viewer"
      ref={hostRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      role="dialog"
      aria-label="全屏查看图片"
    >
      <div className="image-stage" style={{ cursor: zoomed ? 'grab' : 'zoom-in' }}>
        <img
          src={image.url}
          alt={image.label || `第 ${index + 1} 张`}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            cursor: zoomed ? 'grab' : 'zoom-in',
          }}
        />
      </div>

      <button className="btn icon-only viewer-close" aria-label="关闭全屏看图" data-tip="关闭（Esc）" onClick={onClose}>
        <Icon name="close" />
      </button>

      {items.length > 1 && (
        <>
          <button
            className="gallery-nav prev"
            aria-label="上一张"
            data-tip="上一张（←）"
            disabled={!canPrev}
            onClick={() => onIndex(index - 1)}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Icon name="chevron_left" size={28} />
          </button>
          <button
            className="gallery-nav next"
            aria-label="下一张"
            data-tip="下一张（→）"
            disabled={!canNext}
            onClick={() => onIndex(index + 1)}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Icon name="chevron_right" size={28} />
          </button>
        </>
      )}

      <div className="viewer-tools" onPointerDown={(event) => event.stopPropagation()}>
        <button className="btn icon-only" aria-label="缩小" data-tip="缩小" onClick={() => applyZoom(zoom - 0.25)}>
          <Icon name="remove" size={18} />
        </button>
        <span className="viewer-zoom">{percent}%</span>
        <button className="btn icon-only" aria-label="放大" data-tip="放大" onClick={() => applyZoom(zoom + 0.25)}>
          <Icon name="add" size={18} />
        </button>
        <button
          className="btn icon-only"
          aria-label="回到适应窗口"
          data-tip="回到适应窗口"
          onClick={() => {
            setZoom(1)
            setOffset({ x: 0, y: 0 })
          }}
        >
          <Icon name="zoom_out_map" size={18} />
        </button>
      </div>

      <div className="gallery-caption">
        {index + 1} / {items.length} · {image.width}×{image.height}
      </div>
    </div>
  )
}
