import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import Icon from './Icon'
import type { BookMeta, EpubCheckResult } from '../types'

type Props = {
  book: BookMeta
  onClose: () => void
}

type Severity = 'fatal' | 'error' | 'warning' | 'info' | 'plain'

function severityOf(line: string): Severity {
  const text = line.trimStart()
  if (text.startsWith('FATAL(')) return 'fatal'
  if (text.startsWith('ERROR(')) return 'error'
  if (text.startsWith('WARNING(')) return 'warning'
  if (text.startsWith('INFO(')) return 'info'
  return 'plain'
}

/** 插图、第三方扩展的提示不算错误，只做展示 */
function isReportLine(line: string): boolean {
  return severityOf(line) !== 'plain'
}

export default function CheckDialog({ book, onClose }: Props) {
  const [state, setState] = useState<'running' | 'done' | 'failed'>('running')
  const [result, setResult] = useState<EpubCheckResult | null>(null)
  const [error, setError] = useState('')
  const [seq, setSeq] = useState(0)

  useEffect(() => {
    let alive = true
    setState('running')
    setResult(null)
    setError('')
    void invoke<EpubCheckResult>('check_epub', { id: book.id })
      .then((value) => {
        if (!alive) return
        setResult(value)
        setState('done')
      })
      .catch((err) => {
        if (!alive) return
        setError(String(err))
        setState('failed')
      })
    return () => {
      alive = false
    }
  }, [book.id, seq])

  const messages = result ? result.lines.filter(isReportLine) : []
  const others = result ? result.lines.filter((line) => !isReportLine(line)) : []

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="check-modal" onClick={(event) => event.stopPropagation()}>
        <header className="check-head">
          <div>
            <h3>检查 EPUB</h3>
            <p className="check-book">{book.title}</p>
          </div>
          <button className="btn icon-only tip-top" data-tip="关闭" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        {state === 'running' && (
          <div className="check-running">
            <Icon name="hourglass_top" size={22} />
            <span>正在用内置 EPUBCheck 校验，首次运行稍慢…</span>
          </div>
        )}

        {state === 'failed' && (
          <div className="check-failed">
            <Icon name="error" size={18} />
            <span>{error}</span>
          </div>
        )}

        {state === 'done' && result && (
          <>
            <div className={`check-summary ${result.ok ? 'pass' : 'fail'}`}>
              <Icon name={result.ok ? 'check_circle' : 'cancel'} size={20} />
              <span className="check-verdict">{result.ok ? '通过，没有错误' : '未通过'}</span>
              <span className="check-counts">
                致命 {result.fatals} · 错误 {result.errors} · 警告 {result.warnings}
                {result.infos > 0 && ` · 提示 ${result.infos}`}
              </span>
            </div>

            <div className="check-meta">
              {result.runtime}
              <span className="dot">·</span>
              {(result.elapsedMs / 1000).toFixed(1)} 秒
              <span className="dot">·</span>
              退出码 {result.exitCode}
            </div>

            {messages.length > 0 ? (
              <ul className="check-lines">
                {messages.map((line, index) => (
                  <li key={index} className={`sev-${severityOf(line)}`}>
                    {line}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="check-clean">
                <Icon name="task_alt" size={18} />
                <span>没发现问题，这本书符合 EPUB 规范。</span>
              </div>
            )}

            {others.length > 0 && (
              <details className="check-raw">
                <summary>完整输出</summary>
                <pre>{others.join('\n')}</pre>
              </details>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            <Icon name="close" size={16} />
            关闭
          </button>
          <button className="btn primary" disabled={state === 'running'} onClick={() => setSeq((n) => n + 1)}>
            <Icon name="refresh" size={16} />
            重新检查
          </button>
        </div>
      </div>
    </div>
  )
}
