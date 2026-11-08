import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import Icon from './Icon'

/** 窗口右上角三枚控制按钮：最小化 / 最大化(还原) / 关闭。配色随主题令牌自动变化。 */
export default function WindowControls() {
  const win = getCurrentWindow()
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void win.isMaximized().then((value) => {
      if (!disposed) setMaximized(value)
    })
    void win
      .onResized(async () => {
        if (!disposed) setMaximized(await win.isMaximized())
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [win])

  return (
    <div className="win-controls">
      <button className="win-btn" aria-label="最小化" data-tip="最小化" onClick={() => void win.minimize()}>
        <Icon name="remove" size={18} />
      </button>
      <button
        className="win-btn"
        aria-label={maximized ? '还原' : '最大化'}
        data-tip={maximized ? '还原' : '最大化'}
        onClick={() => void win.toggleMaximize()}
      >
        <Icon name={maximized ? 'filter_none' : 'crop_square'} size={16} />
      </button>
      <button className="win-btn close" aria-label="关闭" data-tip="关闭" onClick={() => void win.close()}>
        <Icon name="close" size={18} />
      </button>
    </div>
  )
}
