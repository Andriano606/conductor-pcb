// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../../src/renderer/src/components/ChatView'
import { ProjectSidebar } from '../../src/renderer/src/components/ProjectSidebar'
import { useChatStore } from '../../src/renderer/src/chatStore'
import { useStore } from '../../src/renderer/src/store'
import type { PcbProject } from '@shared/types'

const session = { id: 'p1', createdAt: 1 }
const project: PcbProject = { id: 'p1', name: 'board', dir: '/x/board', proFile: '/x/board/board.kicad_pro', boardFile: '/x/board/board.kicad_pcb', createdAt: 1, sessions: [session] }

describe('ChatView', () => {
  const api = {
    attachChat: vi.fn().mockResolvedValue({ items: [], pending: null, busy: false, seq: 0, running: true }),
    kicadStatus: vi.fn().mockResolvedValue({ running: true, apiSocket: true }),
    sendChat: vi.fn(),
    answerChat: vi.fn(),
    interruptChat: vi.fn(),
    openKicad: vi.fn(),
    createSession: vi.fn(),
    closeSession: vi.fn(),
    renameSession: vi.fn(),
    pickFiles: vi.fn().mockResolvedValue([]),
    pathForFile: () => ''
  }
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = api
    useChatStore.setState({ chats: {}, drafts: {} })
    useStore.setState({ kicad: {}, checking: {} })
  })
  it('sends the draft on Enter and renders streamed items and a permission prompt', async () => {
    render(<ChatView project={project} session={session} />)
    const ta = await screen.findByPlaceholderText(/Що змінити на платі/)
    expect(screen.queryByText('Нова розмова')).not.toBeInTheDocument()
    expect(screen.getByText('Сесія 1')).toBeInTheDocument()
    fireEvent.change(ta, { target: { value: 'перевір плату' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(api.sendChat).toHaveBeenCalledWith('p1', 'перевір плату')
    // stream: user echo, assistant text, tool row, then a permission request
    const apply = useChatStore.getState().applyEvent
    apply({ id: 'p1', seq: 1, ev: { type: 'push', item: { id: 'u', role: 'user', text: 'перевір плату', ts: 1 } } })
    apply({ id: 'p1', seq: 2, ev: { type: 'push', item: { id: 'a', role: 'assistant', text: 'Запускаю ', ts: 1 } } })
    apply({ id: 'p1', seq: 3, ev: { type: 'append', itemId: 'a', text: '**перевірку**' } })
    apply({ id: 'p1', seq: 4, ev: { type: 'push', item: { id: 't', role: 'tool', toolName: 'mcp__pcbagent__run_checks', text: 'run_checks()', ts: 1, done: true, output: '# report' } } })
    apply({ id: 'p1', seq: 5, ev: { type: 'pending', pending: { kind: 'permission', requestId: 'r', toolName: 'Bash', summary: 'rm x' } } })
    expect(await screen.findByText('перевірку')).toBeInTheDocument()
    expect(screen.getByText('run_checks()')).toBeInTheDocument()
    fireEvent.click(screen.getByText('run_checks()'))
    expect(screen.getByText('# report')).toBeInTheDocument()
    fireEvent.click(screen.getByText(/Дозволити/))
    expect(api.answerChat).toHaveBeenCalledWith('p1', { kind: 'permission', requestId: 'r', allow: true })
  })
  // Ultracode is not a toggle beside the effort levels — the CLI treats it as one of them (the
  // last), so the selector offers it as its last item and shows it instead of a level while on.
  it('offers ultracode as the last effort level and shows it as the selection with ⚡', async () => {
    const models = [{ value: 'default', displayName: 'Default', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'ultracode'] }]
    api.attachChat.mockResolvedValueOnce({ items: [], pending: null, busy: false, seq: 0, running: true, modelState: { models, model: 'default', effort: 'high', ultracode: false } })
    api.setChatEffort = vi.fn().mockResolvedValue({ ok: true })
    const { unmount } = render(<ChatView project={project} session={session} />)
    const trigger = await screen.findByTitle('Рівень зусиль (thinking)')
    expect(trigger).toHaveTextContent('high')
    expect(trigger.className).not.toContain('ultra')
    fireEvent.click(trigger)
    const items = screen.getAllByRole('menuitemradio').map((el) => el.textContent)
    expect(items[items.length - 1]).toContain('ultracode')
    fireEvent.click(screen.getByText('⚡ ultracode'))
    expect(api.setChatEffort).toHaveBeenCalledWith('p1', 'ultracode')
    unmount()
    // while on: shown as the current selection, never alongside a level
    api.attachChat.mockResolvedValueOnce({ items: [], pending: null, busy: false, seq: 0, running: true, modelState: { models, model: 'default', effort: 'ultracode', ultracode: true } })
    render(<ChatView project={project} session={session} />)
    const on = await screen.findByTitle(/Ультракод/)
    expect(on).toHaveTextContent('⚡ ultracode')
    expect(on.className).toContain('ultra on')
  })
  it('renders subagent entries with a coloured badge, collapsed narration, and the «фон» marker', async () => {
    render(<ChatView project={project} session={session} />)
    await screen.findByPlaceholderText(/Що змінити на платі/)
    const apply = useChatStore.getState().applyEvent
    apply({ id: 'p1', seq: 1, ev: { type: 'push', item: { id: 'ag', role: 'tool', toolName: 'Agent', text: 'Пошук TODO', ts: 1 } } })
    apply({ id: 'p1', seq: 2, ev: { type: 'push', item: { id: 'st', role: 'assistant', text: 'Перший рядок\n\nДругий **абзац**', ts: 1, agentId: 'ag', agentLabel: 'Пошук TODO' } } })
    apply({ id: 'p1', seq: 3, ev: { type: 'push', item: { id: 'sg', role: 'tool', toolName: 'Grep', text: 'TODO', ts: 1, agentId: 'ag', agentLabel: 'Пошук TODO', done: true, endTs: 2500 } } })
    apply({ id: 'p1', seq: 4, ev: { type: 'push', item: { id: 'bg', role: 'tool', toolName: 'Bash', text: 'npm run build', ts: 1, background: true } } })
    // the Agent row itself is main-agent work (no badge); its subagent's entries carry the badge + rail
    expect(await screen.findAllByText('⛋ Пошук TODO')).toHaveLength(2)
    const sub = document.querySelectorAll('.chat-tool.subagent')
    expect(sub).toHaveLength(2)
    expect((sub[0] as HTMLElement).style.getPropertyValue('--agent')).toMatch(/^hsl\(/)
    // the narration is collapsed to its first line, expanded on click
    expect(screen.getByText('Перший рядок')).toBeInTheDocument()
    expect(screen.queryByText('абзац')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Перший рядок'))
    expect(screen.getByText('абзац')).toBeInTheDocument()
    // the backgrounded command is marked, a still-running row ticks, a finished one is frozen
    expect(screen.getByText('фон')).toBeInTheDocument()
    expect(screen.getByText('2.5 с')).toBeInTheDocument()
  })
  it('is keyed by the session tab, not the project', async () => {
    const tab2 = { id: 'tab2', createdAt: 2, title: 'NRST' }
    render(<ChatView project={{ ...project, sessions: [session, tab2] }} session={tab2} />)
    const ta = await screen.findByPlaceholderText(/Що змінити на платі/)
    expect(api.attachChat).toHaveBeenCalledWith('tab2')
    fireEvent.change(ta, { target: { value: 'hi' } })
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(api.sendChat).toHaveBeenCalledWith('tab2', 'hi')
    expect(screen.getByText('NRST')).toBeInTheDocument()
    expect(api.kicadStatus).toHaveBeenCalledWith('p1')
  })
  it('shows the KiCad state and keeps «Перевірити плату» usable (closed boards are opened by the check itself)', async () => {
    api.kicadStatus.mockResolvedValueOnce({ running: false, apiSocket: false, runningBoards: [] })
    render(<ChatView project={project} session={session} />)
    const btn = await screen.findByText('Перевірити плату')
    expect(await screen.findByText('KiCad не запущений')).toBeInTheDocument()
    expect(btn).toBeEnabled()
    useStore.setState({ kicad: { p1: { running: true, apiSocket: true, runningBoards: ['/x/board/board.kicad_pcb'] } } })
    expect(await screen.findByText('KiCad відкритий')).toBeInTheDocument()
    useStore.setState({ checking: { p1: true } })
    expect(await screen.findByText('Перевіряю…')).toBeDisabled()
  })
  it('«Перевірити плату» re-scans the boards and opens the board picker', async () => {
    const ext = api as typeof api & { listBoards: ReturnType<typeof vi.fn>; listProjects: ReturnType<typeof vi.fn>; getRules: ReturnType<typeof vi.fn> }
    ext.getRules = vi.fn().mockResolvedValue({ rules: [{ code: 'A', effective: { enabled: true } }], errors: [], bundledDir: '', userRulesDir: '' })
    ext.listBoards = vi.fn().mockResolvedValue(['/x/board/board.kicad_pcb', '/x/board/sub/other.kicad_pcb'])
    ext.listProjects = vi.fn().mockResolvedValue([{ ...project, boards: ['/x/board/board.kicad_pcb', '/x/board/sub/other.kicad_pcb'] }])
    useStore.setState({ kicad: { p1: { running: true, apiSocket: true } }, checkModalProject: null })
    render(<ChatView project={project} session={session} />)
    fireEvent.click(await screen.findByText('Перевірити плату'))
    await vi.waitFor(() => expect(useStore.getState().checkModalProject).toBe('p1'))
    expect(ext.listBoards).toHaveBeenCalledWith('p1')
    expect(useStore.getState().projects[0].boards).toHaveLength(2)
    expect(useStore.getState().checkModalRules).toEqual({ enabled: 1, total: 1 })
  })
  it('renders the session-start notice one option per line', async () => {
    render(<ChatView project={project} session={session} />)
    await screen.findByPlaceholderText(/Що змінити на платі/)
    useChatStore.getState().applyEvent({ id: 'p1', seq: 1, ev: { type: 'push', item: { id: 'i', role: 'info', text: '🔄 Сесію запущено · модель: default · зусилля: high · режим: default · resume: так (1744f7dd…) · MCP: 1 (pcbagent) · профіль: стандартний ~/.claude · args: --dangerously-skip-permissions', ts: 1 } } })
    expect(await screen.findByText('Сесію запущено')).toBeInTheDocument()
    expect(screen.getByText('high')).toBeInTheDocument()
    expect(screen.getByText('так (1744f7dd…)')).toBeInTheDocument()
    expect(screen.getByText('--dangerously-skip-permissions')).toBeInTheDocument()
    expect(document.querySelectorAll('.chat-start-line')).toHaveLength(8)
    expect(screen.getAllByText('default').every((el) => el.classList.contains('off'))).toBe(true)
  })
  it('re-attaches on a sequence gap', () => {
    const apply = useChatStore.getState().applyEvent
    apply({ id: 'p9', seq: 5, ev: { type: 'busy', busy: true } })
    expect(api.attachChat).toHaveBeenCalledWith('p9')
  })
})

describe('ProjectSidebar', () => {
  it('lists projects with their last check and selects on click', () => {
    const selectProject = vi.fn()
    useStore.setState({
      projects: [{ ...project, lastCheck: { generated: 'g', summary: { error: 1, warning: 2, info: 3 } } }],
      config: { activeProjectId: 'p1' } as never,
      selectProject,
      addError: null
    })
    // Busy comes from any session tab of the project, not from the project id itself.
    useStore.setState({ projects: [{ ...project, sessions: [session, { id: 'tab2', createdAt: 2 }], lastCheck: { generated: 'g', summary: { error: 1, warning: 2, info: 3 } } }] })
    useChatStore.setState({ chats: { tab2: { items: [], pending: null, busy: true, seq: 0, running: true, commands: [], modelState: null } } })
    render(<ProjectSidebar />)
    expect(screen.getByText('board')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByText('board'))
    expect(selectProject).toHaveBeenCalledWith('p1')
    expect(document.querySelector('.busy-dot.on')).not.toBeNull()
  })
})
