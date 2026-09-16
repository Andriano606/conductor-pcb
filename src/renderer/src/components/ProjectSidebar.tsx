import React from 'react'
import type { PcbProject } from '@shared/types'
import { useStore } from '../store'
import { useChatStore } from '../chatStore'

export function ProjectSidebar(): JSX.Element {
  const projects = useStore((s) => s.projects)
  const active = useStore((s) => s.config?.activeProjectId)
  const selectProject = useStore((s) => s.selectProject)
  const addProject = useStore((s) => s.addProject)
  const deleteProject = useStore((s) => s.deleteProject)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const chats = useChatStore((s) => s.chats)
  const addError = useStore((s) => s.addError)

  return (
    <aside className="left" aria-label="Проекти">
      <div className="left-header">
        <div className="brand">Conductor PCB</div>
        <button className="icon-btn" title="Додати проект KiCad (папка з .kicad_pro)" onClick={() => void addProject()} aria-label="Додати проект">+</button>
      </div>
      <div className="project-list">
        {projects.length === 0 && <div className="muted pad small">Немає проектів. Натисніть «+» і виберіть папку з файлом .kicad_pro.</div>}
        {projects.map((p) => (
          <ProjectRow key={p.id} p={p} active={p.id === active} busy={!!chats[p.id]?.busy} onSelect={() => void selectProject(p.id)} onDelete={() => void deleteProject(p.id)} />
        ))}
        {addError && <div className="err-badge pad">{addError}</div>}
      </div>
      <div className="left-footer">
        <button className="icon-btn" title="Налаштування" onClick={() => setSettingsOpen(true)} aria-label="Налаштування">⚙</button>
      </div>
    </aside>
  )
}

function ProjectRow({ p, active, busy, onSelect, onDelete }: { p: PcbProject; active: boolean; busy: boolean; onSelect: () => void; onDelete: () => void }): JSX.Element {
  const s = p.lastCheck?.summary
  return (
    <div className={'project-row' + (active ? ' active' : '')} onClick={onSelect} role="button" tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}>
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
  )
}
