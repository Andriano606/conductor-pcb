import React, { useEffect } from 'react'
import type { CheckProgress } from '@shared/types'
import { selectedBoards } from '@shared/projects'
import { useStore } from '../store'
import { Toggle } from './Toggle'

const PHASE_LABEL: Record<CheckProgress['phase'], string> = {
  waiting: 'у черзі',
  opening: 'відкриваю в KiCad…',
  checking: 'перевіряю…',
  ok: 'готово',
  error: 'помилка',
  skipped: 'пропущено'
}

/**
 * «Перевірити плату»: pick which boards of the project to check (all on by default, the choice
 * is persisted on the project), see which are open in KiCad, run, and watch per-board progress.
 * KiCad serves its API from one editor only: open boards are checked in place, closed ones are
 * opened by the app one after another when no other editor is running.
 */
export function CheckBoardsModal(): JSX.Element | null {
  const projectId = useStore((s) => s.checkModalProject)
  const projects = useStore((s) => s.projects)
  const kicad = useStore((s) => (projectId ? s.kicad[projectId] : undefined))
  const checking = useStore((s) => (projectId ? !!s.checking[projectId] : false))
  const progress = useStore((s) => s.checkProgress)
  const openCheckModal = useStore((s) => s.openCheckModal)
  const setCheckBoards = useStore((s) => s.setCheckBoards)
  const runChecks = useStore((s) => s.runChecks)
  const refreshKicad = useStore((s) => s.refreshKicad)
  const rulesInfo = useStore((s) => s.checkModalRules)
  const setView = useStore((s) => s.setView)
  const selectProject = useStore((s) => s.selectProject)
  const project = projects.find((p) => p.id === projectId) ?? null

  useEffect(() => {
    if (!projectId) return
    void refreshKicad(projectId)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !checking) void openCheckModal(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [projectId, checking, openCheckModal, refreshKicad])

  if (!project) return null
  const boards = project.boards?.length ? project.boards : [project.boardFile]
  const selected = new Set(selectedBoards(project))
  const running = new Set(kicad?.runningBoards ?? [])
  const foreignEditor = (kicad?.runningBoards?.length ?? 0) > 0
  const toggle = (b: string, on: boolean): void => {
    void setCheckBoards(project.id, { ...(project.checkBoards ?? {}), [b]: on })
  }
  const close = (): void => {
    if (!checking) void openCheckModal(null)
  }
  const name = (b: string): string => b.startsWith(project.dir) ? b.slice(project.dir.length + 1) : b

  return (
    <div className="modal-backdrop stacked" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal check-boards" role="dialog" aria-label="Перевірити плати проекту">
        <header>
          <h2>Перевірити плати: {project.name}</h2>
          <button className="icon-btn" onClick={close} aria-label="Закрити" disabled={checking}>✕</button>
        </header>
        {rulesInfo && (
          <div className="check-rules-info" title="Правила зі скоупу цього проекту (глобальні + власні), увімкнені у вкладці «Правила»">
            <span>Правил буде застосовано: <b>{rulesInfo.enabled}</b> з {rulesInfo.total}</span>
            <button className="link" disabled={checking} onClick={() => { void openCheckModal(null); void selectProject(project.id).then(() => setView('rules')) }}>переглянути</button>
          </div>
        )}
        <p className="muted small">
          Вибір запам'ятовується для проекту. Плата, відкрита в KiCad, перевіряється одразу; закриті плати застосунок відкриє сам
          по черзі, якщо жоден інший редактор pcbnew не запущений (API KiCad доступний лише з одного).
        </p>
        <ul className="check-board-list">
          {boards.map((b) => {
            const pr = progress[b]
            const st = running.has(b) ? 'відкрита в KiCad' : foreignEditor ? 'закрита — потрібен вільний API' : 'закрита — відкриється автоматично'
            return (
              <li key={b} className={'check-board-row' + (selected.has(b) ? '' : ' off')}>
                <Toggle size="sm" checked={selected.has(b)} disabled={checking} onChange={(v) => toggle(b, v)} label={`Перевіряти ${name(b)}`} />
                <div className="check-board-text">
                  <div className="check-board-name" title={b}>{name(b)}</div>
                  <div className="check-board-meta muted small">
                    {checking || pr ? <span className={`check-phase ${pr?.phase ?? 'waiting'}`}>{pr ? PHASE_LABEL[pr.phase] : selected.has(b) ? PHASE_LABEL.waiting : '—'}{pr?.message && pr.phase !== 'opening' && pr.phase !== 'checking' ? `: ${pr.message}` : ''}</span> : <span className={running.has(b) ? 'ok' : ''}>{st}</span>}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
        <div className="modal-actions">
          <button className="btn" onClick={close} disabled={checking}>Скасувати</button>
          <button className="btn primary" disabled={checking || selected.size === 0} onClick={() => void runChecks(project.id, boards.filter((b) => selected.has(b)))}>
            {checking ? 'Перевіряю…' : `Перевірити (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  )
}
