import { useMemo, useState } from 'react'
import Icon from './Icon'
import type { RealignChapterPlan, RealignPlan, RealignRow } from '../lib/realign-drafts'

type Props = {
  plan: RealignPlan
  bookTitle: string
  saving: boolean
  onCancel: () => void
  onApply: (keepOrphans: boolean) => void
}

function excerpt(text: string, limit = 64): string {
  const value = text.replace(/\s+/g, ' ').trim()
  if (!value) return '（空段）'
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function statusText(row: RealignRow): string {
  if (row.status === 'same') return '位移'
  if (row.status === 'modified') return '改写'
  if (row.status === 'added') return '新增'
  return '删除'
}

function indexText(row: RealignRow): string {
  const oldNo = row.oldIndex === null ? null : row.oldIndex + 1
  const newNo = row.newIndex === null ? null : row.newIndex + 1
  if (oldNo !== null && newNo !== null) {
    return oldNo === newNo ? `#${newNo}` : `#${oldNo} → #${newNo}`
  }
  return newNo === null ? `原 #${oldNo}` : `新 #${newNo}`
}

function visibleRows(chapter: RealignChapterPlan): RealignRow[] {
  return chapter.rows.filter(
    (row) => row.status !== 'same' || row.oldIndex !== row.newIndex,
  )
}

export default function RealignDialog({ plan, bookTitle, saving, onCancel, onApply }: Props) {
  const [keepOrphans, setKeepOrphans] = useState(true)
  const [openChapters, setOpenChapters] = useState<Set<number>>(() => {
    // 默认展开第一个有改动的章节，方便直接核对
    const first = plan.chapters.find((chapter) => visibleRows(chapter).length > 0)
    return new Set(first ? [first.chapterIndex] : [])
  })

  const changedChapters = useMemo(
    () => plan.chapters.filter((chapter) => visibleRows(chapter).length > 0),
    [plan],
  )

  const toggle = (chapterIndex: number) => {
    setOpenChapters((prev) => {
      const next = new Set(prev)
      if (next.has(chapterIndex)) next.delete(chapterIndex)
      else next.add(chapterIndex)
      return next
    })
  }

  return (
    <div className="modal-mask" onClick={() => { if (!saving) onCancel() }}>
      <div className="realign-modal" onClick={(event) => event.stopPropagation()}>
        <header className="check-head">
          <div>
            <h3>重新对齐译本</h3>
            <p className="check-book">{bookTitle}</p>
          </div>
          <button
            className="btn icon-only tip-top"
            data-tip="关闭"
            aria-label="关闭"
            onClick={onCancel}
            disabled={saving}
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="realign-summary">
          <span className="realign-chip">不变 {plan.counts.same}</span>
          <span className="realign-chip moved">位移 {plan.moved}</span>
          <span className="realign-chip modified">改写 {plan.counts.modified}</span>
          <span className="realign-chip added">新增 {plan.counts.added}</span>
          <span className="realign-chip removed">删除 {plan.counts.removed}</span>
          {plan.orphanCount > 0 && (
            <span className="realign-chip orphan">孤儿译文 {plan.orphanCount}</span>
          )}
        </div>

        <p className="realign-hint">
          按新母本的段落顺序重排译文：原文一致的段落原样跟随（含位移），被改写的段落保留译文并标记「需校」，
          删除段落的译文按下方选择处理。应用后写入译文工程，母本不改动。
        </p>

        {plan.orphanCount > 0 && (
          <label className="realign-orphans">
            <input
              type="checkbox"
              checked={keepOrphans}
              disabled={saving}
              onChange={(event) => setKeepOrphans(event.target.checked)}
            />
            <span>
              保留被删除段落的译文（{plan.orphanCount} 条，存入草稿孤儿区备查）
            </span>
          </label>
        )}

        <div className="realign-list">
          {changedChapters.length === 0 && <div className="forge-empty">没有需要调整的段落</div>}
          {changedChapters.map((chapter) => {
            const rows = visibleRows(chapter)
            const expanded = openChapters.has(chapter.chapterIndex)
            return (
              <section key={chapter.chapterIndex} className="realign-chapter">
                <button className="realign-chapter__head" onClick={() => toggle(chapter.chapterIndex)}>
                  <Icon name={expanded ? 'expand_less' : 'expand_more'} size={16} />
                  <span className="realign-chapter__title">
                    第 {chapter.chapterIndex + 1} 章 · {chapter.title || '未命名'}
                  </span>
                  <span className="grow" />
                  <span className="realign-chapter__meta">
                    {chapter.moved > 0 && `位移 ${chapter.moved} · `}
                    改写 {chapter.counts.modified} · 新增 {chapter.counts.added} · 删除 {chapter.counts.removed}
                  </span>
                </button>
                {expanded && (
                  <ul className="realign-rows">
                    {rows.slice(0, 200).map((row, index) => (
                      <li key={`${row.status}-${row.oldIndex}-${row.newIndex}-${index}`} className="realign-row">
                        <div className="realign-row__head">
                          <i className={`realign-tag ${row.status}`}>{statusText(row)}</i>
                          <span className="realign-row__index">{indexText(row)}</span>
                          {row.status === 'modified' && (
                            <span className="realign-row__sim">{Math.round(row.similarity * 100)}%</span>
                          )}
                        </div>
                        <div className="realign-row__body">
                          {row.status === 'modified' && (
                            <p className="realign-row__line old">旧：{excerpt(row.oldSource)}</p>
                          )}
                          {row.status !== 'removed' && (
                            <p className="realign-row__line">
                              {row.status === 'modified' ? '新：' : ''}
                              {excerpt(row.newSource)}
                            </p>
                          )}
                          {row.status === 'removed' && (
                            <p className="realign-row__line">{excerpt(row.oldSource)}</p>
                          )}
                          {row.target.trim() && (
                            <p className="realign-row__line target">译：{excerpt(row.target)}</p>
                          )}
                        </div>
                      </li>
                    ))}
                    {rows.length > 200 && (
                      <li className="realign-more">还有 {rows.length - 200} 段未展开</li>
                    )}
                  </ul>
                )}
              </section>
            )
          })}
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onCancel} disabled={saving}>
            取消
          </button>
          <button
            className="btn primary"
            onClick={() => onApply(keepOrphans)}
            disabled={saving || plan.changed === 0}
          >
            <Icon name={saving ? 'hourglass_top' : 'sync_alt'} size={16} />
            {saving ? '正在写入译文工程…' : '应用对齐'}
          </button>
        </div>
      </div>
    </div>
  )
}
