import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatAttachment, ChatItem, ChatPending, ChatQuestion, PcbProject } from '@shared/types'
import { useChatStore } from '../chatStore'
import { useStore } from '../store'
import { Dropdown } from './Dropdown'
import { PromptLibraryModal } from './PromptLibraryModal'
import { ClaudeProfilesModal } from './ClaudeProfilesModal'
import { promptVarValues, substitutePromptVars } from '@shared/promptVars'

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const MAX_INPUT_HEIGHT = 320

export function ChatView({ project }: { project: PcbProject }): JSX.Element {
  const id = project.id
  const chat = useChatStore((s) => s.chats[id])
  const attach = useChatStore((s) => s.attach)
  const draft = useChatStore((s) => s.drafts[id] ?? '')
  const setDraftStore = useChatStore((s) => s.setDraft)
  const atts = useChatStore((s) => s.attachments[id] ?? EMPTY_ATTS)
  const setAttachments = useChatStore((s) => s.setAttachments)
  const history = useChatStore((s) => s.inputHistory)
  const pushInputHistory = useChatStore((s) => s.pushInputHistory)
  const kicad = useStore((s) => s.kicad[id])
  const refreshKicad = useStore((s) => s.refreshKicad)
  const runCheck = useStore((s) => s.runCheck)
  const checking = useStore((s) => s.checking[id])
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [histIndex, setHistIndex] = useState<number | null>(null)
  const savedDraftRef = useRef('')
  const [slashSel, setSlashSel] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [qIndex, setQIndex] = useState(0)
  const [qAnswers, setQAnswers] = useState<Record<string, string>>({})
  const [multiSel, setMultiSel] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [profilesOpen, setProfilesOpen] = useState(false)
  const customPrompts = useStore((s) => s.customPrompts)
  const claudeProfiles = useStore((s) => s.claudeProfiles)
  const setProjectProfiles = useStore((s) => s.setProjectProfiles)
  const [stagedProfileIds, setStagedProfileIds] = useState<string[] | null>(null)
  const currentProfileIds = project.claudeConfigProfileIds ?? []
  const shownProfileIds = stagedProfileIds ?? currentProfileIds
  const applyStagedProfiles = (): void => {
    setStagedProfileIds((staged) => {
      if (staged && [...staged].sort().join(',') !== [...currentProfileIds].sort().join(',')) void setProjectProfiles(id, staged)
      return null
    })
  }
  const stageProfileFlip = (pid: string): void => setStagedProfileIds((staged) => {
    const cur = staged ?? currentProfileIds
    return cur.includes(pid) ? cur.filter((x) => x !== pid) : [...cur, pid]
  })
  const setDraft = (t: string): void => setDraftStore(id, t)
  const insertPrompt = (text: string): void => {
    const body = substitutePromptVars(text, promptVarValues(project))
    setDraft(draft.trim() ? `${draft}\n${body}` : body)
    inputRef.current?.focus()
  }

  useEffect(() => {
    void attach(id)
    void refreshKicad(id)
    const t = setInterval(() => void refreshKicad(id), 5000)
    return () => clearInterval(t)
  }, [id, attach, refreshKicad])

  const items = chat?.items ?? []
  const busy = chat?.busy ?? false
  const pending = chat?.pending ?? null
  const commands = chat?.commands ?? []
  const modelState = chat?.modelState ?? null

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items.length, items[items.length - 1]?.text.length, busy, pending])

  // grow the textarea with its content
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`
  }, [draft])

  useEffect(() => {
    setQIndex(0)
    setQAnswers({})
    setMultiSel([])
  }, [pending?.requestId])

  // ---- slash command menu (terminal-style: while the draft is a bare /token)
  const slashQuery = histIndex === null && !pending && !slashDismissed && /^\/[\w:-]*$/.test(draft) ? draft.slice(1) : null
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : commands.filter((c) => c.name.startsWith(slashQuery)).sort((a, b) => a.name.localeCompare(b.name))),
    [slashQuery, commands]
  )
  const menuOpen = slashMatches.length > 0
  const slashCur = Math.min(slashSel, Math.max(0, slashMatches.length - 1))
  useEffect(() => setSlashSel(0), [slashQuery])
  const completeSlash = (name: string): void => {
    setDraft(`/${name} `)
    inputRef.current?.focus()
  }
  const handleSlashKeys = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSlashSel((i) => (i + 1) % slashMatches.length)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSlashSel((i) => (i - 1 + slashMatches.length) % slashMatches.length)
      return true
    }
    if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault()
      completeSlash(slashMatches[slashCur].name)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setSlashDismissed(true)
      return true
    }
    return false
  }

  // ---- history recall (Up/Down on the first/last line)
  const exitHistory = (): void => {
    setHistIndex(null)
    savedDraftRef.current = ''
  }
  const handleHistory = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const el = e.currentTarget
    if (e.key === 'ArrowUp') {
      if (!history.length) return false
      if (draft.slice(0, el.selectionStart ?? 0).includes('\n')) return false
      e.preventDefault()
      const idx = histIndex === null ? history.length - 1 : Math.max(0, histIndex - 1)
      if (histIndex === null) savedDraftRef.current = draft
      setHistIndex(idx)
      setDraft(history[idx])
      return true
    }
    if (histIndex === null) return false
    if (draft.slice(el.selectionEnd ?? draft.length).includes('\n')) return false
    e.preventDefault()
    if (histIndex < history.length - 1) {
      setHistIndex(histIndex + 1)
      setDraft(history[histIndex + 1])
    } else {
      setDraft(savedDraftRef.current)
      exitHistory()
    }
    return true
  }

  // ---- attachments
  const stageFiles = (paths: string[]): void => {
    const list: ChatAttachment[] = paths.filter(Boolean).map((path) => {
      const name = path.split('/').pop() || path
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      const mediaType = IMAGE_TYPES[ext]
      return { id: crypto.randomUUID(), kind: mediaType ? 'image' : 'file', name, path, mediaType }
    })
    if (list.length) setAttachments(id, [...atts, ...list])
  }
  const pickAttachments = async (): Promise<void> => stageFiles(await window.api.pickFiles())
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    stageFiles(Array.from(e.dataTransfer.files).map((f) => window.api.pathForFile(f)))
  }

  // ---- sending / answering
  const send = (): void => {
    const text = draft.trim()
    if (!text && !atts.length) return
    if (atts.length) window.api.sendChat(id, text, atts)
    else window.api.sendChat(id, text)
    if (text) pushInputHistory(text)
    setDraft('')
    if (atts.length) setAttachments(id, [])
    exitHistory()
  }
  const answerCurrent = (value: string): void => {
    if (pending?.kind !== 'question') return
    const q = pending.questions[qIndex]
    if (!q) return
    const next = { ...qAnswers, [q.question]: value }
    setDraft('')
    exitHistory()
    if (qIndex + 1 < pending.questions.length) {
      setQAnswers(next)
      setQIndex(qIndex + 1)
      setMultiSel([])
    } else {
      window.api.answerChat(id, { kind: 'question', requestId: pending.requestId, answers: next })
    }
  }
  const answerPermission = (allow: boolean): void => {
    if (pending?.kind !== 'permission') return
    window.api.answerChat(id, { kind: 'permission', requestId: pending.requestId, allow, message: allow ? undefined : draft.trim() || undefined })
    setDraft('')
    exitHistory()
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen && handleSlashKeys(e)) return
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && handleHistory(e)) return
    if (e.key !== 'Enter' || e.shiftKey) return
    e.preventDefault()
    if (pending?.kind === 'question') {
      if (draft.trim()) answerCurrent(draft.trim())
    } else if (pending?.kind === 'permission') answerPermission(false)
    else send()
  }

  const placeholder =
    pending?.kind === 'question'
      ? 'Свій варіант відповіді… (Enter — надіслати)'
      : pending?.kind === 'permission'
        ? 'Поясни, що зробити інакше… (Enter — відхилити з коментарем)'
        : 'Що змінити на платі? (Enter — надіслати, Shift+Enter — новий рядок)'
  const currentModel = modelState?.models.find((m) => m.value === modelState.model)
  const effortLevels = currentModel?.supportsEffort ? (currentModel.supportedEffortLevels ?? []) : []

  return (
    <div
      className="chat"
      onDragEnter={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false) }}
      onDrop={onDrop}
    >
      {dragOver && <div className="chat-dropzone">Відпустіть, щоб прикріпити файли</div>}
      <div className="chat-toolbar-top">
        <div className="chat-title">
          <b>{project.name}</b>
          <span className="muted small">{project.dir}</span>
        </div>
        <div className="chat-actions">
          <span className={'api-dot' + (kicad?.running ? ' on' : '')} title="KiCad pcbnew з цією платою" />
          <span className="muted small">{kicad?.running ? 'KiCad відкритий' : 'KiCad не запущений'}</span>
          <button className="btn subtle" onClick={() => void window.api.openKicad(id)}>Відкрити в KiCad</button>
          <button className="btn subtle" disabled={!!checking} onClick={() => void runCheck(id)}>{checking ? 'Перевіряю…' : 'Перевірити плату'}</button>
          <button className="btn subtle" title="Почати нову розмову" onClick={() => void window.api.clearChat(id)}>Нова розмова</button>
        </div>
      </div>
      <div className="chat-scroll" ref={listRef}>
        <div className="chat-rows">
          {items.length === 0 && (
            <div className="chat-empty">
              <div className="chat-empty-icon"><ChipIcon /></div>
              <div className="chat-empty-title">Сесія для {project.name} готова</div>
              <div className="chat-empty-sub">Скажіть, що зробити з платою. Вона має бути відкрита в редакторі KiCad з увімкненим API.</div>
              <div className="chat-empty-pills">
                {['Перевір плату і перелічи проблеми', 'Постав перехід на землю біля кожного конденсатора', 'Перерозведи NRST по верхньому шару без переходів'].map((s) => (
                  <button key={s} type="button" className="chat-pill" onClick={() => { setDraft(s); inputRef.current?.focus() }}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {items.map((it) => (
            <div className="chat-row" key={it.id}>
              <ItemView item={it} />
            </div>
          ))}
          {busy && (
            <div className="chat-row">
              <div className="chat-typing" aria-label="Claude працює"><span /><span /><span /></div>
            </div>
          )}
        </div>
      </div>
      <div className="chat-inputarea">
        {menuOpen && (
          <div className="chat-slash-menu" role="listbox">
            {slashMatches.map((c, i) => (
              <button key={`${c.name}|${c.description ?? ''}`} type="button" role="option" aria-selected={i === slashCur} className={`slash-item ${i === slashCur ? 'sel' : ''}`}
                onMouseEnter={() => setSlashSel(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => completeSlash(c.name)}>
                <span className="slash-name">/{c.name}{c.argumentHint ? <span className="slash-args"> {c.argumentHint}</span> : null}</span>
                {c.description && <span className="slash-desc">{c.description}</span>}
              </button>
            ))}
            <div className="slash-hint">↑↓ — вибір · Tab/Enter — підставити · Esc — закрити</div>
          </div>
        )}
        {pending?.kind === 'question' && (
          <QuestionPanel questions={pending.questions} qIndex={qIndex} multiSel={multiSel}
            onToggleMulti={(label) => setMultiSel((sel) => (sel.includes(label) ? sel.filter((l) => l !== label) : [...sel, label]))}
            onPick={(label) => answerCurrent(label)} onSubmitMulti={() => answerCurrent(multiSel.join(', '))} />
        )}
        {pending?.kind === 'permission' && (
          <div className="chat-pending">
            <div className="chat-pending-title">Claude просить дозвіл: <b>{pending.toolName}</b></div>
            {pending.summary && <code className="chat-pending-summary">{pending.summary}</code>}
            <div className="chat-options">
              <button className="opt-btn allow" onClick={() => answerPermission(true)}>✓ Дозволити</button>
              <button className="opt-btn deny" onClick={() => answerPermission(false)}>✗ Відхилити</button>
            </div>
          </div>
        )}
        <div className="chat-inputrow">
          <div className="chat-inputbox">
            <textarea ref={inputRef} className="chat-input" rows={1} value={draft} placeholder={placeholder}
              onChange={(e) => { setDraft(e.target.value); setHistIndex(null); setSlashDismissed(false) }} onKeyDown={onKeyDown} />
            {atts.length > 0 && (
              <div className="chat-attach-strip">
                {atts.map((a) => (
                  <div key={a.id} className="chat-att-chip" title={a.path}>
                    <span className="chat-att-glyph" aria-hidden="true">{a.kind === 'image' ? '🖼' : '📄'}</span>
                    <span className="chat-att-name">{a.name}</span>
                    <button type="button" className="chat-att-remove" title="Прибрати" aria-label={`Прибрати ${a.name}`} onClick={() => setAttachments(id, atts.filter((x) => x.id !== a.id))}>×</button>
                  </div>
                ))}
              </div>
            )}
            <div className="chat-toolbar">
              <div className="chat-tools-left">
                <Dropdown triggerClass="chat-iconbtn" triggerTitle="Бібліотека промтів" triggerContent={<LibraryIcon />} direction="up"
                  items={[
                    ...customPrompts.map((p) => ({ key: p.id, label: p.title, onClick: () => insertPrompt(p.content) })),
                    { key: '__manage__', label: 'Керувати промтами…', separatorBefore: customPrompts.length > 0, onClick: () => setLibraryOpen(true) }
                  ]} />
                <Dropdown triggerClass="chat-iconbtn" triggerTitle="Конфігурація Claude (скіли, команди) для цього проекту" triggerContent={<GearIcon />} direction="up" menuClass="profiles-menu" onClose={applyStagedProfiles}
                  items={[
                    { key: '__none__', label: 'Стандартний ~/.claude (вимкнути всі)', checked: shownProfileIds.length === 0, keepOpen: true, onClick: () => setStagedProfileIds([]) },
                    ...claudeProfiles.map((p) => ({ key: p.id, label: p.name, checked: shownProfileIds.includes(p.id), toggle: true, keepOpen: true, onClick: () => stageProfileFlip(p.id) })),
                    { key: '__manage__', label: 'Керувати конфігураціями…', separatorBefore: true, onClick: () => setProfilesOpen(true) }
                  ]} />
                {modelState && modelState.models.length > 0 && <span className="chat-tools-divider" />}
                {modelState && modelState.models.length > 0 && (
                  <Dropdown triggerClass="chat-modelbtn" triggerTitle={busy ? 'Зміна моделі перезапускає сесію — зачекайте завершення відповіді' : 'Модель Claude для цієї сесії'}
                    triggerContent={currentModel?.displayName ?? modelState.model ?? 'модель'} direction="up" disabled={busy}
                    items={modelState.models.map((m) => ({
                      key: m.value,
                      label: m.description ? (<span className="model-item"><span className="model-item-name">{m.displayName}</span><span className="model-item-desc">{m.description}</span></span>) : m.displayName,
                      checked: m.value === modelState.model,
                      onClick: () => void window.api.setChatModel(id, m.value)
                    }))} />
                )}
                {effortLevels.length > 0 && (
                  <Dropdown triggerClass="chat-modelbtn" triggerTitle={busy ? 'Зміна зусиль перезапускає сесію — зачекайте завершення відповіді' : 'Рівень зусиль (thinking)'}
                    triggerContent={modelState?.effort ?? 'зусилля'} direction="up" disabled={busy}
                    items={effortLevels.map((lvl) => ({ key: lvl, label: lvl, checked: lvl === modelState?.effort, onClick: () => void window.api.setChatEffort(id, lvl) }))} />
                )}
              </div>
              <div className="chat-tools-right">
                {busy && (
                  <button className="chat-iconbtn stop" title="Перервати поточну відповідь" aria-label="Перервати" onClick={() => window.api.interruptChat(id)}><StopIcon /></button>
                )}
                <button className="chat-iconbtn attach" title="Прикріпити файли" aria-label="Прикріпити файли" onClick={() => void pickAttachments()}><PlusIcon /></button>
                {pending?.kind === 'permission' ? null : (
                  <button className="chat-iconbtn send" title={pending ? 'Надіслати свій варіант' : 'Надіслати'} aria-label="Надіслати"
                    disabled={pending?.kind === 'question' ? !draft.trim() : !draft.trim() && !atts.length}
                    onClick={() => (pending?.kind === 'question' ? answerCurrent(draft.trim()) : send())}><SendIcon /></button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      {libraryOpen && <PromptLibraryModal project={project} onClose={() => setLibraryOpen(false)} onInsert={(t) => { insertPrompt(t); setLibraryOpen(false) }} />}
      {profilesOpen && <ClaudeProfilesModal project={project} onClose={() => setProfilesOpen(false)} />}
    </div>
  )
}

const EMPTY_ATTS: ChatAttachment[] = []

function QuestionPanel({ questions, qIndex, multiSel, onToggleMulti, onPick, onSubmitMulti }: {
  questions: ChatQuestion[]; qIndex: number; multiSel: string[]; onToggleMulti: (l: string) => void; onPick: (l: string) => void; onSubmitMulti: () => void
}): JSX.Element | null {
  const q = questions[qIndex]
  if (!q) return null
  return (
    <div className="chat-pending">
      <div className="chat-pending-title">
        {questions.length > 1 && <span className="muted small">{qIndex + 1}/{questions.length} · </span>}
        {q.header && <b>{q.header}: </b>}{q.question}
      </div>
      <div className="chat-options">
        {q.options.map((o) => (
          <button key={o.label} className={'opt-btn' + (q.multiSelect && multiSel.includes(o.label) ? ' selected' : '')} title={o.description}
            onClick={() => (q.multiSelect ? onToggleMulti(o.label) : onPick(o.label))}>{o.label}</button>
        ))}
        {q.multiSelect && <button className="opt-btn confirm" disabled={!multiSel.length} onClick={onSubmitMulti}>Готово</button>}
      </div>
    </div>
  )
}

function ItemView({ item }: { item: ChatItem }): JSX.Element {
  const [open, setOpen] = useState(false)
  if (item.role === 'tool') {
    const dur = item.endTs ? `${((item.endTs - item.ts) / 1000).toFixed(1)} с` : ''
    return (
      <div className={'chat-tool' + (item.done ? (item.isError ? ' err' : ' ok') : '') + (item.output ? ' expandable' : '')}>
        <div className={'chat-tool-row' + (item.output ? ' clickable' : '')} onClick={() => item.output && setOpen(!open)}>
          <span className="chat-tool-status">{item.done ? (item.isError ? '✗' : '✓') : <span className="chat-tool-spin" />}</span>
          <span className="chat-tool-name">{item.toolName?.replace(/^mcp__pcbagent__/, '')}</span>
          <span className="chat-tool-summary">{item.text}</span>
          <span className="chat-tool-dur">{dur}</span>
        </div>
        {open && item.output && <pre className={'chat-tool-output' + (item.isError ? ' err' : '')}>{item.output}</pre>}
      </div>
    )
  }
  if (item.role === 'info') return <div className="chat-info">{item.text}</div>
  if (item.role === 'user')
    return (
      <div className={'chat-msg user' + (item.answer ? ' answer' : '')}>
        {item.attachments && item.attachments.length > 0 && (
          <div className="chat-msg-atts">{item.attachments.map((a) => <span key={a.id} className="chat-att-fileref" title={a.path}>{a.kind === 'image' ? '🖼 ' : '📄 '}{a.name}</span>)}</div>
        )}
        {item.text}
      </div>
    )
  return (
    <div className="chat-msg assistant chat-md md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
    </div>
  )
}

function LibraryIcon(): JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>
}
function GearIcon(): JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
}
function PlusIcon(): JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
}
function SendIcon(): JSX.Element {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 19V5M5 12l7-7 7 7" /></svg>
}
function StopIcon(): JSX.Element {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><rect x="5" y="5" width="14" height="14" rx="2" /></svg>
}
function ChipIcon(): JSX.Element {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></svg>
}
