import React from 'react'
import type { PcbProject } from '@shared/types'
import { useStore } from '../store'
import { projectBusy, useChatStore } from '../chatStore'
import { UsageMeters } from './UsageMeters'

export function ProjectSidebar(): JSX.Element {
  const projects = useStore((s) => s.projects)
  const active = useStore((s) => s.config?.activeProjectId)
  const selectProject = useStore((s) => s.selectProject)
  const addProject = useStore((s) => s.addProject)
  const deleteProject = useStore((s) => s.deleteProject)
  const chats = useChatStore((s) => s.chats)
  const addError = useStore((s) => s.addError)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const expanded = useStore((s) => s.expandedProjects)
  const toggleExpanded = useStore((s) => s.toggleExpanded)
  const refreshBoards = useStore((s) => s.refreshBoards)
  const kicad = useStore((s) => s.kicad)

  return (
    <aside className="left" aria-label="Проекти">
      <div className="left-header">
        <div className="brand">Conductor PCB</div>
        <div className="row-tight">
          <button className="icon-btn" title="Додати проект KiCad (папка з .kicad_pro)" onClick={() => void addProject()} aria-label="Додати проект">+</button>
          <button className="icon-btn" title="Налаштування" onClick={() => setSettingsOpen(true)} aria-label="Налаштування">⚙</button>
        </div>
      </div>
      <div className="project-list">
        {projects.length === 0 && <div className="muted pad small">Немає проектів. Натисніть «+» і виберіть папку з файлом .kicad_pro.</div>}
        {projects.map((p) => (
          <ProjectRow key={p.id} p={p} active={p.id === active} busy={projectBusy(chats, p)} expanded={!!expanded[p.id]} runningBoards={kicad[p.id]?.runningBoards ?? []}
            onSelect={() => void selectProject(p.id)} onDelete={() => void deleteProject(p.id)}
            onToggle={() => { if (!expanded[p.id]) void refreshBoards(p.id); toggleExpanded(p.id) }} />
        ))}
        {addError && <div className="err-badge pad">{addError}</div>}
      </div>
      <UsageMeters />
    </aside>
  )
}

function ProjectRow({ p, active, busy, expanded, runningBoards, onSelect, onDelete, onToggle }: { p: PcbProject; active: boolean; busy: boolean; expanded: boolean; runningBoards: string[]; onSelect: () => void; onDelete: () => void; onToggle: () => void }): JSX.Element {
  const s = p.lastCheck?.summary
  const boards = p.boards?.length ? p.boards : [p.boardFile]
  const short = (b: string): string => (b.startsWith(p.dir) ? b.slice(p.dir.length + 1) : b.split('/').pop() ?? b)
  return (
    <div className={'project-item' + (expanded ? ' expanded' : '') + (active ? ' active' : '')}>
    <div className={'project-row' + (active ? ' active' : '')} onClick={onSelect} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}>
      <button className={'icon-btn small chevron' + (expanded ? ' open' : '')} title={expanded ? 'Сховати плати' : `Показати плати (${boards.length})`} aria-label={expanded ? 'Сховати плати' : 'Показати плати'} aria-expanded={expanded}
        onClick={(e) => { e.stopPropagation(); onToggle() }}>▸</button>
      <span className={'busy-dot' + (busy ? ' on' : '')} />
      <div className="project-row-text">
        <div className="project-row-name" title={p.dir}>{p.name}</div>
        <div className="project-row-meta">
          {s ? (
            <>
              <span className="sev-badge error">{s.error}</span> <span className="sev-badge warning">{s.warning}</span> <span className="sev-badge info">{s.info}</span>
            </>
          ) : (
            <span className="muted">ще не перевірялась</span>
          )}
        </div>
      </div>
      <button className="icon-btn small" title="Прибрати зі списку (файли не чіпаються)" onClick={(e) => { e.stopPropagation(); onDelete() }} aria-label="Прибрати проект">×</button>
    </div>
    {expanded && (
      <ul className="board-list" aria-label={`Плати проекту ${p.name}`}>
        {boards.map((b) => {
          const lc = p.lastChecks?.[b]?.summary
          const open = runningBoards.includes(b)
          return (
            <li key={b} className="board-row" title={b}>
              <span className={'api-dot' + (open ? ' on' : '')} title={open ? 'відкрита в KiCad' : 'не відкрита'} />
              <span className="board-row-name">{short(b)}</span>
              {lc && <span className="board-row-counts" title="помилки / попередження / інфо в останній перевірці">{lc.error}/{lc.warning}/{lc.info}</span>}
              <button className="icon-btn small board-open" title="Відкрити в KiCad" aria-label={`Відкрити ${short(b)} в KiCad`} onClick={(e) => { e.stopPropagation(); void window.api.openBoard(p.id, b) }}>⧉</button>
            </li>
          )
        })}
        {boards.length === 0 && <li className="muted small pad">Файлів .kicad_pcb не знайдено.</li>}
      </ul>
    )}
    </div>
  )
}
