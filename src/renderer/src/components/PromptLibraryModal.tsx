import React, { useMemo, useRef, useState } from 'react'
import type { CustomPrompt, PcbProject } from '@shared/types'
import { PROMPT_VARS, promptVarValues } from '@shared/promptVars'
import { useStore } from '../store'
import { VarTable } from './VarTable'

/**
 * The prompt library (ported from conductor-linux): a global list of reusable prompts.
 * «Вставити» hands the body to the chat input (substituted with the project's $PCB_* values).
 */
export function PromptLibraryModal({ project, onInsert, onClose }: { project?: PcbProject; onInsert: (content: string) => void; onClose: () => void }): JSX.Element {
  const customPrompts = useStore((s) => s.customPrompts)
  const createCustomPrompt = useStore((s) => s.createCustomPrompt)
  const updateCustomPrompt = useStore((s) => s.updateCustomPrompt)
  const deleteCustomPrompt = useStore((s) => s.deleteCustomPrompt)
  const askConfirm = useStore((s) => s.askConfirm)
  const values = promptVarValues(project)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const contentRef = useRef<HTMLTextAreaElement>(null)
  const [varQuery, setVarQuery] = useState<string | null>(null)
  const [varSel, setVarSel] = useState(0)

  const varMatches = useMemo(() => (varQuery === null ? [] : PROMPT_VARS.filter((v) => v.name.includes(varQuery.toUpperCase()))), [varQuery])
  const varMenuOpen = varMatches.length > 0
  const varCur = Math.min(varSel, Math.max(0, varMatches.length - 1))

  const refreshVarQuery = (value: string, caret: number): void => {
    const m = /\$([A-Za-z0-9_]*)$/.exec(value.slice(0, caret))
    setVarQuery(m ? m[1] : null)
    setVarSel(0)
  }
  const completeVar = (name: string): void => {
    const el = contentRef.current
    if (!el) return
    const caret = el.selectionStart
    const m = /\$([A-Za-z0-9_]*)$/.exec(content.slice(0, caret))
    if (!m) return
    const start = caret - m[0].length
    const token = `$${name}`
    setContent(content.slice(0, start) + token + content.slice(caret))
    setVarQuery(null)
    const pos = start + token.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }
  const onContentKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!varMenuOpen) return
    const n = varMatches.length
    if (e.key === 'ArrowDown') { e.preventDefault(); setVarSel((varCur + 1) % n) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setVarSel((varCur - 1 + n) % n) }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); completeVar(varMatches[varCur].name) }
    else if (e.key === 'Escape') { e.preventDefault(); setVarQuery(null) }
  }

  const reset = (): void => { setEditingId(null); setTitle(''); setContent(''); setVarQuery(null) }
  const startEdit = (p: CustomPrompt): void => { setEditingId(p.id); setTitle(p.title); setContent(p.content) }
  const canSave = !!title.trim() && !!content.trim()
  const save = async (): Promise<void> => {
    if (!canSave) return
    if (editingId) {
      const existing = customPrompts.find((p) => p.id === editingId)
      if (existing) await updateCustomPrompt({ ...existing, title: title.trim(), content: content.trim() })
    } else await createCustomPrompt(title.trim(), content.trim())
    reset()
  }
  const remove = async (p: CustomPrompt): Promise<void> => {
    if (await askConfirm(`Видалити промт «${p.title}»?`)) {
      if (editingId === p.id) reset()
      void deleteCustomPrompt(p.id)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Бібліотека промтів">
        <header><h2>Бібліотека промтів</h2><button className="icon-btn" onClick={onClose} aria-label="Закрити">✕</button></header>
        {customPrompts.length === 0 ? (
          <div className="hint">Ще немає збережених промтів. Створіть перший нижче.</div>
        ) : (
          <div className="prompt-list">
            {customPrompts.map((p) => (
              <div key={p.id} className={`prompt-item ${editingId === p.id ? 'sel' : ''}`}>
                <div className="prompt-text">
                  <div className="prompt-title">{p.title}</div>
                  <div className="prompt-preview">{p.content}</div>
                </div>
                <div className="prompt-actions">
                  <button className="btn" title="Вставити в поле вводу" onClick={() => onInsert(p.content)}>➤ Вставити</button>
                  <button className="btn" title="Редагувати" onClick={() => startEdit(p)}>✎</button>
                  <button className="btn danger" title="Видалити" onClick={() => void remove(p)}>×</button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="field">
          <label>{editingId ? 'Редагування промту' : 'Новий промт'}</label>
          <input value={title} placeholder="Назва" onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <div className="prompt-content-wrap">
            <textarea ref={contentRef} className="prompt-content-input" value={content} rows={6} placeholder="Текст промту… ($ — підказки змінних)"
              onChange={(e) => { setContent(e.target.value); refreshVarQuery(e.target.value, e.target.selectionStart) }}
              onKeyDown={onContentKeyDown} onSelect={(e) => refreshVarQuery(e.currentTarget.value, e.currentTarget.selectionStart)} />
            {varMenuOpen && (
              <div className="chat-slash-menu prompt-var-menu" role="listbox">
                {varMatches.map((v, i) => (
                  <button key={v.name} type="button" role="option" aria-selected={i === varCur} className={`slash-item ${i === varCur ? 'sel' : ''}`}
                    onMouseEnter={() => setVarSel(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => completeVar(v.name)}>
                    <span className="slash-name">${v.name}</span><span className="slash-desc">{v.description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <details className="var-help" open>
          <summary>Змінні в промті</summary>
          <p className="var-source">Введіть <code>$</code> для підказок. При вставці змінні підставляються значеннями активного проекту{project ? ` — зараз це «${project.name}»` : ''}.</p>
          <VarTable vars={PROMPT_VARS} values={values} exampleLabel={project ? `Приклад · ${project.name}` : 'Приклад'} />
        </details>
        <div className="modal-actions">
          {editingId && <button className="btn" style={{ marginRight: 'auto' }} onClick={reset}>+ Новий</button>}
          <button className="btn" onClick={onClose}>Закрити</button>
          <button className="btn primary" disabled={!canSave} onClick={() => void save()}>{editingId ? 'Зберегти' : 'Додати'}</button>
        </div>
      </div>
    </div>
  )
}
