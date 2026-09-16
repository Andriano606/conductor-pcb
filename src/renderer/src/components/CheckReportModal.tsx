import React, { useEffect } from 'react'
import type { ChatAttachment, Finding, Severity } from '@shared/types'
import { useStore } from '../store'
import { useChatStore } from '../chatStore'
import { SeverityBadge } from './SeverityBadge'

const SEVERITIES: Severity[] = ['error', 'warning', 'info']

/** Build the composer attachment for a report file (pure, for tests). */
export function reportAttachment(path: string): ChatAttachment {
  return { id: crypto.randomUUID(), kind: 'file', name: path.split('/').pop() || path, path }
}

/**
 * The report of the last «Перевірити плату» run. «Вставити файл у чат» stages the checker's
 * `pcb_report.md` as an attachment in the composer of `sessionId` (the visible chat tab) without
 * sending it, so the user can add a prompt first.
 */
export function CheckReportModal({ sessionId }: { sessionId: string | null }): JSX.Element | null {
  const result = useStore((s) => s.checkResult)
  const close = useStore((s) => s.closeCheckResult)
  const setAttachments = useChatStore((s) => s.setAttachments)
  useEffect(() => {
    if (!result) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [result, close])
  if (!result) return null

  const report = result.report
  const findings = report?.findings ?? []
  const summary = report?.summary ?? countBySeverity(findings)
  const file = result.reportFile
  const insertIntoChat = (): void => {
    if (!file || !sessionId) return
    const current = useChatStore.getState().attachments[sessionId] ?? []
    if (!current.some((a) => a.path === file)) setAttachments(sessionId, [...current, reportAttachment(file)])
    close()
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.chat-input')?.focus())
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal report-modal" role="dialog" aria-label="Звіт перевірки плати">
        <header>
          <h2>Звіт перевірки</h2>
          <button className="btn subtle" onClick={close} aria-label="Закрити">×</button>
        </header>
        <div className="report-meta muted small">
          {report?.board && <span>{report.board.split('/').pop()}</span>}
          {report?.generated && <span>{formatGenerated(report.generated)}</span>}
        </div>
        <div className="report-summary">
          {SEVERITIES.map((sev) => (
            <span key={sev} className={`report-count ${sev}${summary[sev] ? '' : ' zero'}`}>
              <SeverityBadge severity={sev} />
              <b>{summary[sev] ?? 0}</b>
            </span>
          ))}
        </div>
        {findings.length === 0 ? (
          <p className="report-ok">Знахідок немає. Плата проходить усі перевірки.</p>
        ) : (
          <ul className="report-findings">
            {findings.map((f, i) => (
              <li key={`${f.code}-${i}`} className={`report-finding ${f.severity}`}>
                <div className="report-finding-head">
                  <SeverityBadge severity={f.severity} />
                  <code className="report-code">{f.code}</code>
                  <span className="report-title">{f.title}</span>
                </div>
                {f.detail && <div className="report-detail">{f.detail}</div>}
                {(f.net || f.layer || f.items?.length || f.x != null) && (
                  <div className="report-where muted small">
                    {f.net && <span>Ланцюг: {f.net}</span>}
                    {f.layer && <span>Шар: {f.layer}</span>}
                    {f.x != null && f.y != null && <span>({f.x.toFixed(2)}, {f.y.toFixed(2)}) мм</span>}
                    {f.items && f.items.length > 0 && <span>{f.items.join(', ')}</span>}
                  </div>
                )}
                {f.fix && <div className="report-fix">Як виправити: {f.fix}</div>}
              </li>
            ))}
          </ul>
        )}
        {file ? (
          <div className="report-file muted small" title={file}>Файл звіту: <code>{file}</code></div>
        ) : (
          <div className="report-file muted small">Файл звіту не знайдено поруч із платою.</div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={close}>Закрити</button>
          <button className="btn primary" disabled={!file || !sessionId} title={!sessionId ? 'Немає відкритого чату' : !file ? 'Файл звіту не знайдено' : 'Прикріпити pcb_report.md до поля вводу поточного чату (без надсилання)'}
            onClick={insertIntoChat}>Вставити файл у чат</button>
        </div>
      </div>
    </div>
  )
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const s: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const f of findings) if (f.severity in s) s[f.severity]++
  return s
}

function formatGenerated(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' })
}
