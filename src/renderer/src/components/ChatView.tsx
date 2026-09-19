import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatAttachment, ChatItem, ChatPending, ChatQuestion, ChatSession, PcbProject } from '@shared/types'
import { useChatStore } from '../chatStore'
import { SessionTabs } from './SessionTabs'
import { useStore } from '../store'
import { Dropdown } from './Dropdown'
import { PromptLibraryModal } from './PromptLibraryModal'
import { ClaudeProfilesModal } from './ClaudeProfilesModal'
import { WorkflowPanel, WorkflowRow } from './WorkflowView'
import { promptVarValues, substitutePromptVars } from '@shared/promptVars'

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const MAX_INPUT_HEIGHT = 320

/**
 * Last transcript scroll position per session id, kept in module scope so it survives the ChatView
 * remount on every session-tab switch (`key={session.id}`). `atBottom` records whether the user was
 * pinned to the newest message when they left: a raw scrollTop restored after Claude appended more would
 * strand them above the new content, so a session left pinned re-pins instead (ported from conductor-linux).
 */
type SavedScroll = { scrollTop: number; atBottom: boolean }
const scrollStateById = new Map<string, SavedScroll>()

/** The chat of one session tab (`session`) of `project`; the session id is the chat key. */
export function ChatView({ project, session }: { project: PcbProject; session: ChatSession }): JSX.Element {
  const id = session.id
  const pid = project.id
  const chat = useChatStore((s) => s.chats[id])
  const attach = useChatStore((s) => s.attach)
  const draft = useChatStore((s) => s.drafts[id] ?? '')
  const setDraftStore = useChatStore((s) => s.setDraft)
  const atts = useChatStore((s) => s.attachments[id] ?? EMPTY_ATTS)
  const setAttachments = useChatStore((s) => s.setAttachments)
  const history = useChatStore((s) => s.inputHistory)
  const pushInputHistory = useChatStore((s) => s.pushInputHistory)
  const kicad = useStore((s) => s.kicad[pid])
  const refreshKicad = useStore((s) => s.refreshKicad)
  const openCheckModal = useStore((s) => s.openCheckModal)
  const checking = useStore((s) => s.checking[pid])
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
  // The open multi-agent panel, by the id of its Workflow row (owned here, not by the row, so it
  // outlives the transcript re-rendering while the run keeps appending items).
  const [workflowItemId, setWorkflowItemId] = useState<string | null>(null)
  const customPrompts = useStore((s) => s.customPrompts)
  const claudeProfiles = useStore((s) => s.claudeProfiles)
  const setSessionProfiles = useStore((s) => s.setSessionProfiles)
  const [stagedProfileIds, setStagedProfileIds] = useState<string[] | null>(null)
  const currentProfileIds = session.claudeConfigProfileIds ?? []
  const shownProfileIds = stagedProfileIds ?? currentProfileIds
  const applyStagedProfiles = (): void => {
    setStagedProfileIds((staged) => {
      if (staged && [...staged].sort().join(',') !== [...currentProfileIds].sort().join(',')) void setSessionProfiles(id, staged)
      return null
    })
  }
  const stageProfileFlip = (profileId: string): void => setStagedProfileIds((staged) => {
    const cur = staged ?? currentProfileIds
    return cur.includes(profileId) ? cur.filter((x) => x !== profileId) : [...cur, profileId]
  })
  const setDraft = (t: string): void => setDraftStore(id, t)
  const insertPrompt = (text: string): void => {
    const body = substitutePromptVars(text, promptVarValues(project))
    setDraft(draft.trim() ? `${draft}\n${body}` : body)
    inputRef.current?.focus()
  }

  useEffect(() => {
    void attach(id)
  }, [id, attach])
  useEffect(() => {
    void refreshKicad(pid)
    const t = setInterval(() => void refreshKicad(pid), 5000)
    return () => clearInterval(t)
  }, [pid, refreshKicad])

  const items = chat?.items ?? []
  const busy = chat?.busy ?? false
  const pending = chat?.pending ?? null
  const commands = chat?.commands ?? []
  const modelState = chat?.modelState ?? null

  // ---- auto-follow («примагнічування») of the transcript, ported from conductor-linux.
  // The pin state lives in atBottomRef, the single source of truth for following Claude's output:
  //  - it detaches ONLY on an upward move the user actually drove (wheel, drag, touch, scroll key —
  //    see gestureRef), so they can read back while Claude streams;
  //  - it re-attaches whenever the view lands on the true bottom.
  // Every other upward move of scrollTop is layout, not intent (a re-measured row, the browser
  // clamping on a height change) and is ignored — reading those as "the user scrolled up" is what
  // used to drop the pin, and re-snapping on every change is what used to yank the user back down.
  const restoreFrom = useRef(scrollStateById.get(id))
  const atBottomRef = useRef(!restoreFrom.current || restoreFrom.current.atBottom)
  // Set on send/answer so the next transcript growth jumps to the bottom even if the user had scrolled up.
  const stickRef = useRef(false)
  const lastTopRef = useRef(0)
  const gestureRef = useRef(false)
  const gestureTimer = useRef<ReturnType<typeof setTimeout>>()
  const bottomRaf = useRef<number>()
  const bottomTimers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const contentRo = useRef<ResizeObserver | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const markGesture = (): void => {
    gestureRef.current = true
    if (gestureTimer.current) clearTimeout(gestureTimer.current)
    gestureTimer.current = setTimeout(() => {
      gestureRef.current = false
    }, 400)
  }
  const saveScroll = (): void => {
    if (saveTimer.current) return
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined
      const el = listRef.current
      if (el) scrollStateById.set(id, { scrollTop: el.scrollTop, atBottom: atBottomRef.current })
    }, 200)
  }
  /** Snap to the true bottom, if still pinned; chained rAF/timer top-ups cover growth that lands a frame late. */
  const pinBottom = useCallback((): void => {
    if (!atBottomRef.current) return
    const topUp = (): void => {
      if (!atBottomRef.current) return
      const el = listRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
      lastTopRef.current = el.scrollTop
    }
    topUp()
    if (bottomRaf.current) cancelAnimationFrame(bottomRaf.current)
    bottomRaf.current = requestAnimationFrame(() => {
      topUp()
      bottomRaf.current = requestAnimationFrame(topUp)
    })
    for (const t of bottomTimers.current) clearTimeout(t)
    bottomTimers.current = [setTimeout(topUp, 40), setTimeout(topUp, 120)]
  }, [])
  /** Re-arm the pin: submitting anything must reveal what Claude says next, even after a scroll-up. */
  const followNewOutput = (): void => {
    stickRef.current = true
    atBottomRef.current = true
    pinBottom()
  }
  // Snap whenever the transcript changes or the typing footer / pending prompt toggles, while pinned.
  useEffect(() => {
    if (stickRef.current) {
      stickRef.current = false
      atBottomRef.current = true
    }
    pinBottom()
  }, [items, busy, pending, pinBottom])
  // Scroller listeners + a ResizeObserver holding the pin against growth no render announces
  // (late markdown/image layout, an expanding tool row, the composer resizing the viewport).
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const saved = restoreFrom.current
    if (saved && !saved.atBottom) el.scrollTop = saved.scrollTop
    else pinBottom()
    lastTopRef.current = el.scrollTop
    const onWheel = (e: WheelEvent): void => {
      markGesture()
      if (e.deltaY < 0) {
        stickRef.current = false
        atBottomRef.current = false
      }
    }
    const onScroll = (): void => {
      const top = el.scrollTop
      const dist = el.scrollHeight - top - el.clientHeight
      if (dist <= 2) {
        atBottomRef.current = true
      } else if (gestureRef.current && top < lastTopRef.current - 1) {
        stickRef.current = false
        atBottomRef.current = false
      } else if (atBottomRef.current && !gestureRef.current) {
        // Pinned, but layout — not the user — drifted us above the true bottom: re-snap now.
        el.scrollTop = el.scrollHeight
        lastTopRef.current = el.scrollTop
        saveScroll()
        return
      }
      lastTopRef.current = top
      saveScroll()
    }
    const onGesture = (): void => markGesture()
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('mousedown', onGesture, { passive: true })
    el.addEventListener('touchstart', onGesture, { passive: true })
    el.addEventListener('touchmove', onGesture, { passive: true })
    el.addEventListener('keydown', onGesture, { passive: true })
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => pinBottom())
      ro.observe(el)
      if (el.firstElementChild) ro.observe(el.firstElementChild)
      contentRo.current = ro
    }
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('mousedown', onGesture)
      el.removeEventListener('touchstart', onGesture)
      el.removeEventListener('touchmove', onGesture)
      el.removeEventListener('keydown', onGesture)
      contentRo.current?.disconnect()
      contentRo.current = null
      if (gestureTimer.current) clearTimeout(gestureTimer.current)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      if (bottomRaf.current) cancelAnimationFrame(bottomRaf.current)
      for (const t of bottomTimers.current) clearTimeout(t)
      scrollStateById.set(id, { scrollTop: el.scrollTop, atBottom: atBottomRef.current })
    }
  }, [id, pinBottom])

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
    followNewOutput()
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
      followNewOutput()
    }
  }
  const answerPermission = (allow: boolean): void => {
    if (pending?.kind !== 'permission') return
    window.api.answerChat(id, { kind: 'permission', requestId: pending.requestId, allow, message: allow ? undefined : draft.trim() || undefined })
    followNewOutput()
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
          <span className="muted small">{kicad?.running ? `KiCad відкритий${(kicad.runningBoards?.length ?? 0) > 1 ? ` (${kicad.runningBoards!.length} плати)` : ''}` : 'KiCad не запущений'}</span>
          <button className="btn subtle" onClick={() => void window.api.openKicad(pid)}>Відкрити в KiCad</button>
          <button className="btn subtle" disabled={!!checking} title="Вибрати плати проекту й запустити перевіряч (закриті плати відкриються в KiCad автоматично, якщо API вільний)"
            onClick={() => void openCheckModal(pid)}>{checking ? 'Перевіряю…' : 'Перевірити плату'}</button>
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
              <ItemView item={it} onOpenWorkflow={setWorkflowItemId} />
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
                <SessionTabs project={project} activeSessionId={id} />
                <span className="chat-tools-divider" />
                <Dropdown triggerClass="chat-iconbtn" triggerTitle="Бібліотека промтів" triggerContent={<LibraryIcon />} direction="up"
                  items={[
                    ...customPrompts.map((p) => ({ key: p.id, label: p.title, onClick: () => insertPrompt(p.content) })),
                    { key: '__manage__', label: 'Керувати промтами…', separatorBefore: customPrompts.length > 0, onClick: () => setLibraryOpen(true) }
                  ]} />
                <Dropdown triggerClass="chat-iconbtn" triggerTitle={busy ? 'Конфігурація Claude для цієї сесії (зміна перезапустить лише її)' : 'Конфігурація Claude (скіли, команди) для цієї сесії'} triggerContent={<GearIcon />} direction="up" menuClass="profiles-menu" onClose={applyStagedProfiles}
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
                  // Ultracode is the last level in this list, not a toggle of its own — the CLI
                  // treats it as an effort level, and every other level turns it off.
                  <Dropdown triggerClass={`chat-modelbtn${modelState?.ultracode ? ' ultra on' : ''}`}
                    triggerTitle={busy ? 'Зміна зусиль перезапускає сесію — зачекайте завершення відповіді' : modelState?.ultracode ? 'Ультракод: xhigh + Claude сам запускає мультиагентні воркфлови' : 'Рівень зусиль (thinking)'}
                    triggerContent={modelState?.ultracode ? '⚡ ultracode' : (modelState?.effort ?? 'зусилля')} direction="up" disabled={busy}
                    items={effortLevels.map((lvl) => ({
                      key: lvl,
                      label: lvl === 'ultracode'
                        ? (<span className="model-item"><span className="model-item-name">⚡ ultracode</span><span className="model-item-desc">xhigh (не max) + мультиагентні воркфлови</span></span>)
                        : lvl,
                      checked: lvl === modelState?.effort,
                      onClick: () => void window.api.setChatEffort(id, lvl)
                    }))} />
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
      {profilesOpen && <ClaudeProfilesModal project={project} session={session} onClose={() => setProfilesOpen(false)} />}
      {workflowItemId && <WorkflowPanel sessionId={id} itemId={workflowItemId} onClose={() => setWorkflowItemId(null)} />}
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

/**
 * Session-start notices (`describeStart` in main) are persisted as one `·`-separated line.
 * Parse it back into labeled fields for a one-option-per-line rendering; any other info text
 * returns null. A segment without a known `key:` prefix is glued onto the previous value
 * (values themselves may contain " · ").
 */
const START_NOTICE_PREFIX = '🔄 Сесію запущено · '
const START_NOTICE_KEYS = new Set(['модель', 'зусилля', 'режим', 'resume', 'MCP', 'профіль', 'args'])
export function parseStartNotice(text: string): { key: string; value: string }[] | null {
  if (!text.startsWith(START_NOTICE_PREFIX)) return null
  const fields: { key: string; value: string }[] = []
  for (const seg of text.slice(START_NOTICE_PREFIX.length).split(' · ')) {
    const colon = seg.indexOf(': ')
    const key = colon > 0 ? seg.slice(0, colon) : ''
    if (START_NOTICE_KEYS.has(key)) fields.push({ key, value: seg.slice(colon + 2) })
    else if (fields.length) fields[fields.length - 1].value += ` · ${seg}`
    else return null
  }
  return fields.length ? fields : null
}

/** Values meaning "off / nothing set" — dimmed so the eye lands on real settings. */
const START_OFF_VALUES = new Set(['немає', 'default', 'ні — нова розмова', 'стандартний ~/.claude'])

function StartNoticeView({ fields }: { fields: { key: string; value: string }[] }): JSX.Element {
  return (
    <div className="chat-info chat-start">
      <div className="chat-start-line"><span aria-hidden="true">🔄 </span><span>Сесію запущено</span></div>
      {fields.map((f) => (
        <div key={f.key} className={`chat-start-line${f.key === 'args' ? ' args' : ''}`}>
          <span className="chat-start-key">{f.key}: </span>
          <span className={`chat-start-val${START_OFF_VALUES.has(f.value) ? ' off' : ''}`}>{f.value}</span>
        </div>
      ))}
    </div>
  )
}

/** Stable hue per subagent id, so each parallel subagent reads as its own colour. */
export function agentColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return `hsl(${h} 60% 52%)`
}

/** className suffix + the `--agent` CSS var for an entry that belongs to a subagent. */
function agentProps(item: ChatItem): { className: string; style?: React.CSSProperties } {
  if (!item.agentId) return { className: '' }
  return { className: ' subagent', style: { ['--agent' as string]: agentColor(item.agentId) } }
}

/** A coloured badge marking an entry as produced by a subagent. */
function AgentBadge({ item }: { item: ChatItem }): JSX.Element | null {
  if (!item.agentId) return null
  return <span className="chat-agent-badge" title="Субагент, що працює паралельно">⛋ {item.agentLabel || 'субагент'}</span>
}

/** "12.3 с" / "1хв 04с" rendering of a tool call's elapsed time. */
function formatDuration(ms: number): string {
  const s = Math.max(0, ms) / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} с`
  const m = Math.floor(s / 60)
  return `${m}хв ${String(Math.round(s % 60)).padStart(2, '0')}с`
}

/**
 * A tool-call row: status, name, the compact command, a live elapsed-time counter (ticks while
 * running, frozen at endTs once done), the «фон» marker for a backgrounded command, the subagent
 * badge, and click-to-expand output.
 */
const ToolItemView = memo(function ToolItemView({ item }: { item: ChatItem }): JSX.Element {
  const [open, setOpen] = useState(false)
  const running = !item.done
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [running])
  const elapsed = (item.done ? (item.endTs ?? item.ts) : now) - item.ts
  const a = agentProps(item)
  return (
    <div className={'chat-tool ' + (item.done ? (item.isError ? 'err' : 'ok') : 'run') + (item.output ? ' expandable' : '') + a.className} style={a.style}>
      <div className={'chat-tool-row' + (item.output ? ' clickable' : '')} onClick={() => item.output && setOpen(!open)}>
        <span className="chat-tool-status">{item.done ? (item.isError ? '✗' : '✓') : <span className="chat-tool-spin" />}</span>
        <span className="chat-tool-name">{item.toolName?.replace(/^mcp__pcbagent__/, '')}</span>
        {item.background && <span className="chat-tool-bg" title="Команда запущена у фоні">фон</span>}
        <AgentBadge item={item} />
        <span className="chat-tool-summary">{item.text}</span>
        <span className="chat-tool-dur" title="Тривалість виконання">{formatDuration(elapsed)}</span>
      </div>
      {open && item.output && <pre className={'chat-tool-output' + (item.isError ? ' err' : '')}>{item.output}</pre>}
    </div>
  )
})

/**
 * A subagent's narration is collapsed to a one-line, click-to-expand row (like a tool call) so
 * parallel subagents don't flood the main thread.
 */
const SubagentTextView = memo(function SubagentTextView({ item }: { item: ChatItem }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const a = agentProps(item)
  const preview = item.text.split('\n').find((l) => l.trim()) ?? item.text.trim()
  return (
    <div className={'chat-tool subagent-msg expandable' + (expanded ? ' expanded' : '') + a.className} style={a.style}>
      <div className="chat-tool-row clickable" title={expanded ? 'Згорнути' : 'Показати повністю'} onClick={() => setExpanded((v) => !v)}>
        <AgentBadge item={item} />
        {!expanded && <span className="chat-tool-summary subagent-preview">{preview}</span>}
      </div>
      {expanded && (
        <div className="chat-md md subagent-md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
        </div>
      )}
    </div>
  )
})

function ItemView({ item, onOpenWorkflow }: { item: ChatItem; onOpenWorkflow?: (itemId: string) => void }): JSX.Element {
  // The Workflow tool's own row is the multi-agent status line: name, progress and a click that
  // opens the plan/agents panel.
  if (item.role === 'tool' && item.workflow) return <WorkflowRow item={item} onOpen={() => onOpenWorkflow?.(item.id)} />
  if (item.role === 'tool') return <ToolItemView item={item} />
  if (item.role === 'info') {
    const fields = parseStartNotice(item.text)
    return fields ? <StartNoticeView fields={fields} /> : <div className="chat-info">{item.text}</div>
  }
  if (item.role === 'user')
    return (
      <div className={'chat-msg user' + (item.answer ? ' answer' : '')}>
        {item.attachments && item.attachments.length > 0 && (
          <div className="chat-msg-atts">{item.attachments.map((a) => <span key={a.id} className="chat-att-fileref" title={a.path}>{a.kind === 'image' ? '🖼 ' : '📄 '}{a.name}</span>)}</div>
        )}
        {item.text}
      </div>
    )
  if (item.agentId) return <SubagentTextView item={item} />
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
