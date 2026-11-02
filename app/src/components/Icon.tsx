/**
 * 图标：使用 Material Icons（与 Flutter 同源的实心图标风格），
 * 通过连字（ligature）取字形，name 直接写 Material 图标名。
 * 规则：按钮只放图标，中文说明放在 data-tip 里做悬停提示。
 */
type Props = {
  name: string
  size?: number
}

export default function Icon({ name, size = 18 }: Props) {
  return (
    <span
      className="mi"
      aria-hidden="true"
      style={size === 18 ? undefined : { fontSize: `${size}px` }}
    >
      {name}
    </span>
  )
}
