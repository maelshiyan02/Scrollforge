import { useEffect, useRef, useState } from 'react'
import Icon from './Icon'
import type { Prefs } from '../lib/prefs'
import { themeLabel } from '../lib/prefs'

type Theme = Prefs['theme']

type Props = {
  prefs: Prefs
  onPrefs: (patch: Partial<Prefs>) => void
  onSettings: () => void
  onHelp: () => void
  onAbout: () => void
}

const THEMES: { value: Theme; label: string; icon: string }[] = [
  { value: 'day', label: '日间', icon: 'wb_sunny' },
  { value: 'eye', label: '护眼', icon: 'visibility' },
  { value: 'night', label: '夜间', icon: 'brightness_3' },
]

/** 书架左下角整体菜单（参考 Trae）：主题 / 语言 / 设置 / 帮助 / 关于 */
export default function AppMenu({ prefs, onPrefs, onSettings, onHelp, onAbout }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="app-menu" ref={rootRef}>
      {open && (
        <div className="app-menu__pop" role="menu">
          <div className="app-menu__group">主题</div>
          <div className="app-menu__themes">
            {THEMES.map((item) => (
              <button
                key={item.value}
                className={`app-menu__theme ${prefs.theme === item.value ? 'on' : ''}`}
                onClick={() => onPrefs({ theme: item.value })}
              >
                <Icon name={item.icon} size={16} />
                {item.label}
              </button>
            ))}
          </div>

          <div className="app-menu__group">语言</div>
          <button className="app-menu__item" disabled>
            <Icon name="language" size={16} />
            <span>简体中文</span>
            <em>当前</em>
          </button>

          <div className="app-menu__sep" />

          <button
            className="app-menu__item"
            onClick={() => {
              setOpen(false)
              onSettings()
            }}
          >
            <Icon name="settings" size={16} />
            <span>设置</span>
            <kbd>Ctrl+,</kbd>
          </button>
          <button
            className="app-menu__item"
            onClick={() => {
              setOpen(false)
              onHelp()
            }}
          >
            <Icon name="menu_book" size={16} />
            <span>帮助说明书</span>
            <kbd>F1</kbd>
          </button>
          <button
            className="app-menu__item"
            onClick={() => {
              setOpen(false)
              onAbout()
            }}
          >
            <Icon name="info" size={16} />
            <span>关于 Scrollforge</span>
          </button>
        </div>
      )}

      <button
        className={`app-menu__trigger ${open ? 'on' : ''}`}
        aria-label="打开菜单"
        aria-expanded={open}
        data-tip={`菜单（当前主题：${themeLabel(prefs.theme)}）`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="menu" size={18} />
      </button>
    </div>
  )
}
