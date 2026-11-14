import type { ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import Icon from './Icon'
import WindowControls from './WindowControls'

type Props = {
  /** 顶栏标题（设置 / 帮助说明书） */
  title: string
  /** 标题前的小图标 */
  icon?: string
  /** 左上角返回主页 */
  onBack: () => void
  children?: ReactNode
}

/**
 * 设置页 / 帮助页共用顶栏：复用主页 titlebar 的视觉与拖拽行为，
 * 左侧统一是「返回主页」，右侧保留窗口按钮；不再放关闭按钮。
 */
export default function PageBar({ title, icon, onBack, children }: Props) {
  return (
    <header
      className="bar titlebar page-bar"
      data-tauri-drag-region
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest('button, select, input, label, a')) return
        void getCurrentWindow().toggleMaximize()
      }}
    >
      <button className="btn icon-only" data-tip="返回主页（Esc）" aria-label="返回主页" onClick={onBack}>
        <Icon name="arrow_back" />
      </button>
      <span className="sep" />
      {icon && (
        <span className="page-bar__icon"><Icon name={icon} size={16} /></span>
      )}
      <span className="page-bar__title">{title}</span>
      {children}
      <span className="grow" data-tauri-drag-region />
      <WindowControls />
    </header>
  )
}
