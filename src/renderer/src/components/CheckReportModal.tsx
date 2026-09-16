import React, { useEffect, useState } from 'react'
import type { BoardCheckResult, ChatAttachment, Finding, Severity } from '@shared/types'
import { useStore } from '../store'
import { useChatStore } from '../chatStore'
import { SeverityBadge } from './SeverityBadge'

const SEVERITIES: Severity[] = ['error', 'warning', 'info']

/** Build the composer attachment for a report file (pure, for tests). */
export function reportAttachment(path: string): ChatAttachment {
  return { id: crypto.randomUUID(), kind: 'file', name: path.split('/').pop() || path, path }
}

/**
 * The report of the last «Перевірити плату» run: one tab per checked board. Each board's
 * «Вставити файл у чат» stages its `pcb_report*.md` as an attachment in the composer of
 * `sessionId` (the visible chat tab) without sending it, so the user can add a prompt first.
 */
export function CheckReportModal({ sessionId }: { sessionId: string | null }): JSX.Element | null {
  const result = useStore((s) => s.checkResult)
  const projects = useStore((s) => s.projects)
  const close = useStore((s) => s.closeCheckResult)
  const setAttachments = useChatStore((s) => s.setAttachments)
  const [tab, setTab] = useState(0)
  useEffect(() => setTab(0), [result])
  useEffect(() => {
    if (!result) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [result, close])
  if (!result) return null

  const project = projects.find((p) => p.id === result.projectId)
  const shortName = (b: string): string => (project && b.startsWith(project.dir) ? b.slice(project.dir.length + 1) : b.split('/').pop() ?? b)
  const boards = result.boards
  const current: BoardCheckResult | undefined = boards[Math.min(tab, Math.max(0, boards.length - 1))]
  const stage = (file: string): void => {
    if (!sessionId) return
    const atts = useChatStore.getState().attachments[sessionId] ?? []
    if (!atts.some((a) => a.path === file)) setAttachments(sessionId, [...atts, reportAttachment(file)])
  }
  const insertOne = (file: string): void => {
    stage(file)
    close()
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.chat-input')?.focus())
  }
  const insertAll = (): void => {
    for (const b of boards) if (b.reportFile) stage(b.reportFile)
    close()
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.chat-input')?.focus())
  }
  const withFiles = boards.filter((b) => b.reportFile).length

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal report-modal" role="dialog" aria-label="Звіт перевірки плати">
        <header>
          <h2>Звіт перевірки{project ? `: ${project.name}` : ''}</h2>
          <button className="btn subtle" onClick={close} aria-label="Закрити">×</button>
        </header>
        {boards.length > 1 && (
          <div className="report-tabs" role="tablist">
            {boards.map((b, i) => (
              <button key={b.boardFile} role="tab" aria-selected={i === tab} className={'report-tab' + (i === tab ? ' active' : '') + ` ${b.status}`} onClick={() => setTab(i)} title={b.boardFile}>
                <span className={`report-tab-dot ${b.status}`} />
                {shortName(b.boardFile)}
                {b.report?.summary && <span className="report-tab-counts">{b.report.summary.error}/{b.report.summary.warning}/{b.report.summary.info}</span>}
              </button>
            ))}
          </div>
        )}
        {boards.length === 0 && <p className="report-ok">Жодної плати не перевірено.</p>}
        {current && <BoardReport r={current} name={shortName(current.boardFile)} />}
        <div className="modal-actions">
          <button className="btn" onClick={close}>Закрити</button>
          {boards.length > 1 && (
            <button className="btn" disabled={!withFiles || !sessionId} title="Прикріпити звіти всіх перевірених плат до поля вводу поточного чату (без надсилання)" onClick={insertAll}>
              Вставити всі файли у чат ({withFiles})
            </button>
          )}
          {current && (
            <button className="btn primary" disabled={!current.reportFile || !sessionId}
              title={!sessionId ? 'Немає відкритого чату' : !current.reportFile ? 'Файл звіту не знайдено' : `Прикріпити ${current.reportFile.split('/').pop()} до поля вводу поточного чату (без надсилання)`}
              onClick={() => current.reportFile && insertOne(current.reportFile)}>Вставити файл у чат</button>
          )}
        </div>
      </div>
    </div>
  )
}

function BoardReport({ r, name }: { r: BoardCheckResult; name: string }): JSX.Element {
  const report = r.report
  const findings = report?.findings ?? []
  const summary = report?.summary ?? countBySeverity(findings)
  return (
    <div className="board-report">
      <div className="report-meta muted small">
        <span title={r.boardFile}>{name}</span>
        {report?.generated && <span>{formatGenerated(report.generated)}</span>}
        {r.status === 'skipped' && <span className="report-skipped">пропущено</span>}
      </div>
      {r.status !== 'ok' ? (
        <p className="report-error">{r.status === 'skipped' ? 'Плату не перевірено: ' : 'Перевірка не вдалася: '}{r.error ?? 'невідома помилка'}</p>
      ) : (
        <>
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
        </>
      )}
      {r.reportFile ? (
        <div className="report-file muted small" title={r.reportFile}>Файл звіту: <code>{r.reportFile}</code></div>
      ) : (
        r.status === 'ok' && <div className="report-file muted small">Файл звіту не знайдено поруч із платою.</div>
      )}
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
