import React, { useEffect, useState } from 'react'
import { useStore } from '../store'
import { Toggle } from './Toggle'

function PathRow({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }): JSX.Element {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <div className="row">
      <span className="lbl">{label}</span>
      <input className="grow" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onCommit(v)} onKeyDown={(e) => e.key === 'Enter' && v !== value && onCommit(v)} />
    </div>
  )
}

type SectionId = 'rules' | 'claude' | 'api' | 'export'
const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'rules', label: 'Правила', icon: '📐' },
  { id: 'claude', label: 'Claude та інструменти', icon: '🤖' },
  { id: 'api', label: 'Локальний API', icon: '🔌' },
  { id: 'export', label: 'Конфіг перевіряча', icon: '📤' }
]

export function SettingsModal(): JSX.Element | null {
  const config = useStore((s) => s.config)
  const configPath = useStore((s) => s.configPath)
  const bundledDir = useStore((s) => s.bundledDir)
  const api = useStore((s) => s.api)
  const errors = useStore((s) => s.errors)
  const setConfig = useStore((s) => s.setConfig)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const reload = useStore((s) => s.reload)
  const [port, setPort] = useState(String(config?.api.port ?? 4817))
  const [exportPreview, setExportPreview] = useState<string>('')
  const [saved, setSaved] = useState<string | null>(null)
  const [section, setSection] = useState<SectionId>('rules')

  const ruleScope = useStore((s) => s.ruleScope)
  useEffect(() => {
    void window.api.exportChecker(ruleScope === 'global' ? undefined : ruleScope).then((e) => setExportPreview(JSON.stringify(e, null, 2)))
  }, [config, ruleScope])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setSettingsOpen])

  if (!config) return null
  const overrideCount = Object.keys(config.overrides).length

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setSettingsOpen(false)}>
      <div className="modal settings" role="dialog" aria-label="Налаштування">
        <header>
          <h2>Налаштування</h2>
          <button className="icon-btn" onClick={() => setSettingsOpen(false)} aria-label="Закрити">
            ✕
          </button>
        </header>
        <div className="settings-body">
        <nav className="settings-nav" aria-label="Розділи налаштувань">
          {SECTIONS.map((sec) => (
            <button key={sec.id} className={'settings-tab' + (section === sec.id ? ' active' : '')} onClick={() => setSection(sec.id)}>
              <span className="settings-tab-icon" aria-hidden>{sec.icon}</span>
              {sec.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">

        {section === 'rules' && <section>
          <h3>Правила</h3>
          <div className="row">
            <span className="lbl">Вбудовані</span>
            <code className="grow">{bundledDir}</code>
            <button className="btn subtle" onClick={() => void window.api.showDir(bundledDir)}>
              відкрити
            </button>
          </div>
          <div className="row">
            <span className="lbl">Користувацькі</span>
            <code className="grow">{config.userRulesDir}</code>
            <button
              className="btn subtle"
              onClick={() => void window.api.pickDir(config.userRulesDir).then((d) => { if (d) void setConfig({ userRulesDir: d }) })}
            >
              змінити
            </button>
            <button className="btn subtle" onClick={() => void window.api.showDir(config.userRulesDir)}>
              відкрити
            </button>
          </div>
          <p className="muted small">
            Кожне правило — окремий JSON-файл. Файл у користувацькій папці з тим самим <code>code</code> замінює вбудований. Зміни
            у папках підхоплюються автоматично.
          </p>
          <div className="row">
            <button className="btn subtle" onClick={() => void reload()}>
              Перечитати правила
            </button>
            {errors.length > 0 && <span className="err-badge">{errors.length} файл(ів) з помилками</span>}
          </div>
          {errors.length > 0 && (
            <ul className="errors small">
              {errors.map((e) => (
                <li key={e.file}>
                  <code>{e.file}</code>: {e.message}
                </li>
              ))}
            </ul>
          )}
        </section>}
        {section === 'claude' && <section>
          <h3>Claude і інструменти</h3>
          <PathRow label="Аргументи claude" value={config.claudeArgs} onCommit={(v) => void setConfig({ claudeArgs: v })} />
          <PathRow label="Папка pcbagent" value={config.pcbagentDir} onCommit={(v) => void setConfig({ pcbagentDir: v })} />
          <PathRow label="Python (venv)" value={config.pythonPath} onCommit={(v) => void setConfig({ pythonPath: v })} />
          <PathRow label="kicad-cli" value={config.kicadCli} onCommit={(v) => void setConfig({ kicadCli: v })} />
          <PathRow label="KiCad (AppImage)" value={config.kicadLauncher} onCommit={(v) => void setConfig({ kicadLauncher: v })} />
          <p className="muted small">Чат запускає <code>claude -p</code> у папці проекту з MCP-сервером pcbagent; зміни цих полів діють для нової сесії (вкладка «+» у чаті).</p>
        </section>}
        {section === 'api' && <section>
          <h3>Локальний API</h3>
          <div className="row">
            <label className="check">
              <Toggle checked={config.api.enabled} onChange={(v) => void setConfig({ api: { ...config.api, enabled: v } })} label="API увімкнено" />
              увімкнено
            </label>
            <span className="lbl">Порт</span>
            <input className="short" type="number" value={port} min={1} max={65535} onChange={(e) => setPort(e.target.value)} onBlur={() => { const p = Number(port); if (Number.isInteger(p) && p > 0 && p !== config.api.port) void setConfig({ api: { ...config.api, port: p } }) }} />
            <span className={'api-dot' + (api.running ? ' on' : '')} />
            <span className="muted">{api.running ? api.url : api.error ?? 'зупинено'}</span>
          </div>
          <pre className="json small">{`GET  ${api.url}/api/rules            # усі правила з ефективними порогами
GET  ${api.url}/api/rules/<CODE>
PUT  ${api.url}/api/rules/<CODE>     # створити/замінити користувацьке правило
GET  ${api.url}/api/config
PATCH ${api.url}/api/config          # напр. {"overrides":{"PLANE_CUT":{"enabled":false}}}
GET  ${api.url}/api/export/pcbagent  # пороги для pcbagent.rules.json
POST ${api.url}/api/findings         # звіт перевіряча -> лічильники в списку правил`}</pre>
        </section>}
        {section === 'export' && <section>
          <h3>Конфіг перевіряча</h3>
          <p className="muted small">
            Пороги й вимкнені правила збираються в один файл <code>pcbagent.rules.json</code>, який читає перевіряч плат. Змінених
            правил: {overrideCount}. Конфіг застосунку: <code>{configPath}</code>
          </p>
          <div className="row">
            <button
              className="btn primary"
              onClick={() => void window.api.saveExport().then((p) => setSaved(p))}
            >
              Експортувати pcbagent.rules.json…
            </button>
            {saved && <span className="muted small">збережено: {saved}</span>}
            <button className="btn subtle" onClick={() => window.api.copyText(exportPreview)}>
              копіювати
            </button>
          </div>
          <pre className="json small">{exportPreview}</pre>
        </section>}
        </div>
        </div>
      </div>
    </div>
  )
}
