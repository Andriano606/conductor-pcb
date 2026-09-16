import React, { useEffect, useMemo } from 'react'
import { useStore } from './store'
import { useChatStore } from './chatStore'
import { RuleSidebar } from './components/RuleSidebar'
import { RuleView } from './components/RuleView'
import { SettingsModal } from './components/SettingsModal'
import { ImportRuleModal } from './components/ImportRuleModal'
import { ConfirmModal } from './components/ConfirmModal'
import { ProjectSidebar } from './components/ProjectSidebar'
import { TopBar } from './components/TopBar'
import { ChatView } from './components/ChatView'
import { filterRules } from '@shared/rules'

export function App(): JSX.Element {
  const loaded = useStore((s) => s.loaded)
  const load = useStore((s) => s.load)
  const applySnapshot = useStore((s) => s.applySnapshot)
  const setReport = useStore((s) => s.setReport)
  const setProjects = useStore((s) => s.setProjects)
  const rules = useStore((s) => s.rules)
  const selected = useStore((s) => s.selected)
  const query = useStore((s) => s.query)
  const category = useStore((s) => s.category)
  const onlyEnabled = useStore((s) => s.onlyEnabled)
  const settingsOpen = useStore((s) => s.settingsOpen)
  const importOpen = useStore((s) => s.importOpen)
  const view = useStore((s) => s.view)
  const projects = useStore((s) => s.projects)
  const activeId = useStore((s) => s.config?.activeProjectId)
  const applyEvent = useChatStore((s) => s.applyEvent)

  useEffect(() => {
    void load()
    const offRules = window.api.onRulesChanged(applySnapshot)
    const offFind = window.api.onFindings(setReport)
    const offApi = window.api.onApiStatus((api) => useStore.setState({ api }))
    const offChat = window.api.onChatEvent(applyEvent)
    const offProj = window.api.onProjectsChanged(setProjects)
    const offCfg = window.api.onConfigChanged((config) => useStore.setState({ config, projects: config.projects }))
    const offView = window.api.onSetView((v) => (v === ('settings' as string) ? useStore.getState().setSettingsOpen(true) : useStore.getState().setView(v)))
    const offUsage = window.api.onUsage((w) => useStore.getState().setUsage(w))
    return () => {
      offView()
      offUsage()
      offRules()
      offFind()
      offApi()
      offChat()
      offProj()
      offCfg()
    }
  }, [load, applySnapshot, setReport, applyEvent, setProjects])

  const visible = useMemo(() => {
    let list = filterRules(rules, query)
    if (category !== 'all') list = list.filter((r) => r.category === category)
    if (onlyEnabled) list = list.filter((r) => r.effective.enabled)
    return list
  }, [rules, query, category, onlyEnabled])

  const rule = rules.find((r) => r.code === selected) ?? null
  const project = projects.find((p) => p.id === activeId) ?? projects[0] ?? null

  if (!loaded) return <div className="app loading">Завантаження…</div>
  return (
    <div className="app">
      <ProjectSidebar />
      <div className="main">
        <TopBar />
        {view === 'rules' ? (
          <div className="rules-area">
            <main className="content">{rule ? <RuleView rule={rule} /> : <RulesEmpty count={rules.length} />}</main>
            <RuleSidebar rules={visible} />
          </div>
        ) : (
          <main className="content chat-area">
            {project ? <ChatView project={project} /> : <ChatEmpty />}
          </main>
        )}
      </div>
      {settingsOpen && <SettingsModal />}
      {importOpen && <ImportRuleModal />}
      <ConfirmModal />
    </div>
  )
}

function ChatEmpty(): JSX.Element {
  const addProject = useStore((s) => s.addProject)
  return (
    <div className="empty">
      <h2>Conductor PCB</h2>
      <p>Додайте проект KiCad: папку з файлом .kicad_pro. Потім відкрийте плату в KiCad і скажіть Claude, що зробити.</p>
      <button className="btn primary" onClick={() => void addProject()}>Додати проект…</button>
    </div>
  )
}

function RulesEmpty({ count }: { count: number }): JSX.Element {
  const errors = useStore((s) => s.errors)
  return (
    <div className="empty">
      <h2>Бібліотека правил</h2>
      {count === 0 ? <p>Жодного правила не завантажено. Перевірте папку з правилами в налаштуваннях.</p> : <p>Оберіть правило у списку праворуч.</p>}
      {errors.length > 0 && (
        <div className="errors">
          <b>Файли з помилками:</b>
          <ul>
            {errors.map((e) => (
              <li key={e.file}>
                <code>{e.file}</code>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
