import Icon from './Icon'
import { FEATURES, SHORTCUTS, STATUS_LABEL } from '../lib/features'
import type { SettingMeta } from '../lib/features'

type Props = {
  onClose: () => void
  onOpenSettings?: () => void
}

function settingLine(setting: SettingMeta): string {
  if (setting.kind === 'select') {
    return `${setting.label}：${setting.options.map((item) => item.label).join(' / ')}`
  }
  if (setting.kind === 'number') {
    return `${setting.label}：${setting.min}–${setting.max}${setting.unit ?? ''}`
  }
  if (setting.kind === 'toggle') {
    return `${setting.label}：开关`
  }
  return setting.label
}

export default function HelpDialog({ onClose, onOpenSettings }: Props) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="help-modal" onClick={(event) => event.stopPropagation()}>
        <header className="help-head">
          <span className="help-head__icon"><Icon name="menu_book" size={20} /></span>
          <div>
            <h2>Scrollforge 说明书</h2>
            <p>快捷键、功能入口与每个设置项的一句话解释。按 F1 可随时打开或关闭。</p>
          </div>
          <button className="btn icon-only help-close" aria-label="关闭说明书" data-tip="关闭（Esc）" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>

        <div className="help-body">
          <section className="help-section">
            <h3>快捷键</h3>
            <table className="shortcut-table">
              <tbody>
                {SHORTCUTS.map((item) => (
                  <tr key={item.keys}>
                    <td><kbd>{item.keys}</kbd></td>
                    <td>{item.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="help-section">
            <h3>功能与设置</h3>
            {FEATURES.map((feature) => (
              <article className="help-feature" key={feature.id}>
                <div className="help-feature__head">
                  <span className="help-feature__icon"><Icon name={feature.icon} size={16} /></span>
                  <b>{feature.title}</b>
                  <em className={`feature-tag ${feature.status === 'online' ? 'on' : feature.status === 'beta' ? 'beta' : ''}`}>
                    {STATUS_LABEL[feature.status]}
                  </em>
                </div>
                <p className="help-feature__where">{feature.where}</p>
                <p className="help-feature__desc">{feature.desc}</p>
                {feature.settings.length > 0 && (
                  <ul className="help-feature__settings">
                    {feature.settings.map((setting) => (
                      <li key={settingLine(setting)}>
                        <span>{settingLine(setting)}</span>
                        <small>{setting.hint}</small>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </section>

          <section className="help-section">
            <h3>使用提示</h3>
            <ul className="help-tips">
              <li>导入格式在「设置 → 导入」里勾选；拖拽文件到窗口也会按这份清单过滤。</li>
              <li>阅读历史只记录原文件路径与进度；本地书库保存副本，原文件移动不影响阅读。</li>
              <li>编辑保存会先写回工作副本再重打包；「另存为」不会覆盖原书。</li>
              <li>固定版式（PDF / 漫画）用「整页缩放」，字号与行距对它无效。</li>
              <li>彩页画廊只收原生尺寸足够大的整页图，图标与装饰小图会被过滤。</li>
            </ul>
          </section>
        </div>

        <footer className="help-actions">
          {onOpenSettings && (
            <button className="btn" onClick={onOpenSettings}>
              <Icon name="settings" size={16} />打开设置
            </button>
          )}
          <button className="btn primary" onClick={onClose}>
            <Icon name="check" size={16} />知道了
          </button>
        </footer>
      </div>
    </div>
  )
}
