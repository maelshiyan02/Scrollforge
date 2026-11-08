/** 书架排序图标：自绘线性矢量，与视图按钮同一线宽风格（24 栅格 / 1.6 描边）。
   三个排序方式共用「时钟 / 书本」两个母题，只交换主副关系，便于一眼区分：
   最近阅读 = 时钟（主）+ 翻开的书（右下角标）；导入时间 = 书本（主）+ 加号 + 小时钟（右下角标）。 */

type Props = { size?: number }

const base = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

/** 最近阅读：时钟 + 右下角翻开的书 */
export function SortRecentIcon({ size = 22 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <circle cx="8.3" cy="8.3" r="6.2" />
      <path d="M8.3 4.6v4.2l2.6 1.5" />
      <path d="M14.4 16.9c1.3-.7 2.8-.7 4.2 0v5.2c-1.4-.7-2.9-.7-4.2 0z" />
      <path d="M22.8 16.9c-1.3-.7-2.8-.7-4.2 0v5.2c1.4-.7 2.9-.7 4.2 0z" />
    </svg>
  )
}

/** 导入时间：翻开的书（新书入库）+ 右上角加号 */
export function SortImportedIcon({ size = 22 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <path d="M3.2 8.6c1.4-.8 2.8-.8 4.2 0v10.2c-1.4-.8-2.8-.8-4.2 0z" />
      <path d="M11.6 8.6c-1.4-.8-2.8-.8-4.2 0v10.2c1.4-.8 2.8-.8 4.2 0z" />
      <path d="M18.4 3.6v4.8M16 6h4.8" strokeWidth="1.5" />
    </svg>
  )
}

/** 书名排序：矢量字母 A / Z + 下方双向箭头（升序降序共用同一图形） */
export function SortTitleIcon({ size = 22 }: Props) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <path d="M2.4 15.2 5.6 7.4 8.8 15.2" strokeWidth="1.5" />
      <path d="M3.8 12.4h3.6" strokeWidth="1.5" />
      <path d="M15.2 7.4h5.6L15.2 15.2h5.6" strokeWidth="1.5" />
      <path d="M3.2 19.8h17.6" strokeWidth="1.4" />
      <path d="M3.2 19.8l2.3-1.7M3.2 19.8l2.3 1.7M20.8 19.8l-2.3-1.7M20.8 19.8l-2.3 1.7" strokeWidth="1.4" />
    </svg>
  )
}

/** 排序方向：左侧三条内容条（长度随方向递增/递减）+ 右侧升/降箭头 */
export function SortOrderIcon({ size = 22, asc }: Props & { asc: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...base}>
      <path d={`M2.2 6.4h${asc ? 3.8 : 7.8}`} />
      <path d="M2.2 10.8h5.8" />
      <path d={`M2.2 15.2h${asc ? 7.8 : 3.8}`} />
      {asc ? (
        <path d="M15.6 17.6V6.4M15.6 6.4l-2.2 2.2M15.6 6.4l2.2 2.2" />
      ) : (
        <path d="M15.6 6.4v11.2M15.6 17.6l-2.2-2.2M15.6 17.6l2.2-2.2" />
      )}
    </svg>
  )
}
