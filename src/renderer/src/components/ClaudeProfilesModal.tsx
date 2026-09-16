import React, { useEffect, useState } from 'react'
import type { ClaudeProfile, EnvVar, PcbProject } from '@shared/types'
import { useStore } from '../store'
import { useChatStore } from '../chatStore'
import { Toggle } from './Toggle'

/**
 * Claude config overlays (skills, commands, agents, CLAUDE.md, settings): a global list of
 * source folders, each toggled per project. Enabled ones are merged on top of ~/.claude into
 * an app-owned CLAUDE_CONFIG_DIR for that project's chat. Ported from conductor-linux.
 */
export function ClaudeProfilesModal({ project, onClose }: { project: PcbProject; onClose: () => void }): JSX.Element {
  const claudeProfiles = useStore((s) => s.claudeProfiles)
  const createClaudeProfile = useStore((s) => s.createClaudeProfile)
  const updateClaudeProfile = useStore((s) => s.updateClaudeProfile)
  const deleteClaudeProfile = useStore((s) => s.deleteClaudeProfile)
  const setProjectProfiles = useStore((s) => s.setProjectProfiles)
  const rebuildClaudeConfigs = useStore((s) => s.rebuildClaudeConfigs)
  const askConfirm = useStore((s) => s.askConfirm)
  const busy = useChatStore((s) => !!s.chats[project.id]?.busy)
  const currentIds = project.claudeConfigProfileIds ?? []
  const currentKey = [...currentIds].sort().join(',')
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set(currentIds))
  useEffect(() => setEnabledIds(new Set(currentIds)), [currentKey])
  const selectionChanged = [...enabledIds].sort().join(',') !== currentKey
  const toggleProfile = (id: string): void => setEnabledIds((ids) => { const n = new Set(ids); n.has(id) ? n.delete(id) : n.add(id); return n })

  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  const [env, setEnv] = useState<EnvVar[]>([])
  const [home, setHome] = useState('')
  useEffect(() => { void window.api.homeDir().then(setHome) }, [])
  const [pathValid, setPathValid] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    const p = path.trim()
    if (!p) { setPathValid(null); return }
    void window.api.isClaudeConfigDir(p).then((ok) => { if (!cancelled) setPathValid(ok) })
    return () => { cancelled = true }
  }, [path])

  const reset = (): void => { setEditingId(null); setName(''); setPath(''); setEnv([]) }
  const startEdit = (p: ClaudeProfile): void => { setEditingId(p.id); setName(p.name); setPath(p.path); setEnv(p.env ?? []) }
  const canSave = !!name.trim() && !!path.trim() && pathValid === true
  const save = async (): Promise<void> => {
    if (!canSave) return
    const cleanEnv = env.map((v) => ({ key: v.key.trim(), value: v.value })).filter((v) => v.key)
    if (editingId) {
      const existing = claudeProfiles.find((x) => x.id === editingId)
      if (existing) await updateClaudeProfile({ ...existing, name: name.trim(), path: path.trim(), env: cleanEnv })
    } else await createClaudeProfile(name.trim(), path.trim(), cleanEnv)
    reset()
  }
  const remove = async (p: ClaudeProfile): Promise<void> => {
    if (await askConfirm(`Видалити конфіг «${p.name}»?`)) { if (editingId === p.id) reset(); void deleteClaudeProfile(p.id) }
  }
  const rebuild = async (): Promise<void> => {
    if (await askConfirm('Перебілдити конфіги? Вихідні теки буде перечитано, обʼєднані конфіги перебудовано, активні чати перезапущено (розмови збережуться).')) void rebuildClaudeConfigs()
  }
  const applySelection = (): void => {
    if (selectionChanged) void setProjectProfiles(project.id, claudeProfiles.filter((p) => enabledIds.has(p.id)).map((p) => p.id))
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Конфігурації Claude">
        <header><h2>Конфігурації Claude</h2><button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button></header>
        <div className="field">
          <label>Конфіги для проекту «{project.name}»</label>
          <div className="hint">Увімкнені конфіги (скіли, команди, агенти, CLAUDE.md, налаштування) накладаються на глобальний ~/.claude і діють лише для чату цього проекту.</div>
          {busy && <div className="hint">Claude зараз працює — застосування перезапустить сесію. Краще зачекати завершення відповіді.</div>}
          {claudeProfiles.length === 0 ? (
            <div className="hint">Ще немає конфігів. Додайте перший нижче, наприклад папку <code>.claude</code> якогось проекту зі скілами.</div>
          ) : (
            <div className="prompt-list config-list">
              {claudeProfiles.map((p) => (
                <div key={p.id} className={`prompt-item config-row ${editingId === p.id ? 'sel' : ''}`}>
                  <Toggle size="sm" checked={enabledIds.has(p.id)} onChange={() => toggleProfile(p.id)} label="Увімкнути для цього проекту" />
                  <div className="prompt-text">
                    <div className="prompt-title">{p.name}</div>
                    <div className="prompt-preview">{p.path}</div>
                  </div>
                  <div className="prompt-actions">
                    <button className="btn" title="Редагувати" onClick={() => startEdit(p)}>✎</button>
                    <button className="btn danger" title="Видалити" onClick={() => void remove(p)}>×</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
            {claudeProfiles.length > 0 ? <button className="btn" title="Перечитати вихідні теки й перебудувати обʼєднані конфіги" onClick={() => void rebuild()}>↻ Перебілдити конфіги</button> : <span />}
            <button className="btn primary" disabled={!selectionChanged} onClick={applySelection}>Застосувати для проекту</button>
          </div>
        </div>
        <details className="merge-help">
          <summary>Як обʼєднуються конфіги</summary>
          <ul>
            <li>База — завжди глобальний <code>~/.claude</code> (логін, налаштування, MCP).</li>
            <li>Увімкнені конфіги накладаються в порядку списку; при конфлікті виграє пізніший.</li>
            <li><code>commands/ skills/ agents/ hooks/ plugins/</code> — обʼєднання файлів, однойменні замінюються пізнішим.</li>
            <li><code>settings.json settings.local.json</code> — глибоке злиття JSON.</li>
            <li><code>CLAUDE.md</code> — конкатенація: глобальний, далі кожен конфіг під заголовком.</li>
            <li>Розмови не копіюються з джерел; обʼєднаний конфіг має власну історію, що переживає перебілди.</li>
            <li>Вихідні теки читаються при кожному (пере)білді — після змін на диску натисніть «Перебілдити конфіги».</li>
          </ul>
        </details>
        <div className="field">
          <label>{editingId ? 'Редагування конфігу' : 'Новий конфіг'}</label>
          <input value={name} placeholder="Назва" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <div className="row">
            <input spellCheck={false} value={path} placeholder={home ? `${home}/…/.claude` : '/шлях/до/конфігу'} onChange={(e) => setPath(e.target.value)} />
            <button className="btn" onClick={() => void window.api.pickDir(path.trim() || home || undefined).then((d) => d && setPath(d))}>Огляд…</button>
          </div>
          <div className="hint">
            Тека з конфігом Claude; читається при (пере)білді, сама не змінюється.
            {pathValid === false && <span className="err"> — це не схоже на конфіг Claude.</span>}
            {pathValid === true && <span className="ok"> — конфіг Claude знайдено.</span>}
          </div>
        </div>
        <div className="field">
          <label>Змінні середовища</label>
          {env.length === 0 ? <div className="hint">Немає змінних. Будуть експортовані в claude-сесію проектів з цим конфігом.</div> : (
            <div className="env-list">
              {env.map((v, i) => (
                <div className="row env-row" key={i}>
                  <input className="env-key" spellCheck={false} value={v.key} placeholder="KEY" onChange={(e) => setEnv(env.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
                  <input className="env-val" spellCheck={false} value={v.value} placeholder="значення" onChange={(e) => setEnv(env.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                  <button className="btn danger" title="Прибрати змінну" onClick={() => setEnv(env.filter((_, j) => j !== i))}>×</button>
                </div>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}><button className="btn" onClick={() => setEnv([...env, { key: '', value: '' }])}>+ Додати змінну</button></div>
        </div>
        <div className="modal-actions">
          {editingId && <button className="btn" style={{ marginRight: 'auto' }} onClick={reset}>+ Новий</button>}
          <button className="btn" onClick={onClose}>Закрити</button>
          <button className="btn primary" disabled={!canSave} onClick={() => void save()}>{editingId ? 'Зберегти' : 'Додати'}</button>
        </div>
      </div>
    </div>
  )
}
