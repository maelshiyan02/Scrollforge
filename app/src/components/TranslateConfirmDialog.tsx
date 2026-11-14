import Icon from './Icon'

type Props = {
  /** 作用域文案：「所选」或「本章」 */
  scopeLabel: string
  /** 待翻译段落总数 */
  total: number
  /** 其中已有译文的段落数 */
  translated: number
  onCancel: () => void
  onOverwrite: () => void
  onSkip: () => void
}

/**
 * 翻译覆盖确认：目标段落里已有译文时，先问一次再动手。
 * 一个批次只弹一次，绝不逐段弹窗；样式与 RealignDialog 同一套弹层。
 */
export default function TranslateConfirmDialog({
  scopeLabel,
  total,
  translated,
  onCancel,
  onOverwrite,
  onSkip,
}: Props) {
  const remaining = total - translated
  return (
    <div className="modal-mask" onClick={onCancel}>
      <div className="modal forge-overwrite" onClick={(event) => event.stopPropagation()}>
        <header className="check-head">
          <div>
            <h3>已有译文，确认是否覆盖</h3>
            <p className="check-book">{scopeLabel}共 {total} 段待翻译 · 已有译文 {translated} 段</p>
          </div>
          <button
            className="btn small icon-only tip-top"
            data-tip="关闭（Esc）"
            aria-label="关闭"
            onClick={onCancel}
          >
            <Icon name="close" size={16} />
          </button>
        </header>

        <p className="modal-text">
          {scopeLabel}共 {total} 段待翻译，其中 {translated} 段已有译文。要覆盖重译，还是只补未译段落？
        </p>

        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn" onClick={onSkip} disabled={remaining === 0}>
            跳过已有，只译未译{remaining > 0 ? ` ${remaining} 段` : ''}
          </button>
          <button className="btn primary" onClick={onOverwrite}>
            全部重译并覆盖
          </button>
        </div>
      </div>
    </div>
  )
}
