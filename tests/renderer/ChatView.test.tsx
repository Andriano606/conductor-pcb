// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../../src/renderer/src/components/ChatView'
import { ProjectSidebar } from '../../src/renderer/src/components/ProjectSidebar'
import { useChatStore } from '../../src/renderer/src/chatStore'
import { useStore } from '../../src/renderer/src/store'
import type { PcbProject } from '@shared/types'

const project: PcbProject = { id: 'p1', name: 'board', dir: '/x/board', proFile: '/x/board/board.kicad_pro', boardFile: '/x/board/board.kicad_pcb', createdAt: 1 }

describe('ChatView', () => {
  const api = {
    attachChat: vi.fn().mockResolvedValue({ items: [], pending: null, busy: false, seq: 0, running: true }),
    kicadStatus: vi.fn().mockResolvedValue({ running: true, apiSocket: true }),
    sendChat: vi.fn(),
    answerChat: vi.fn(),
    interruptChat: vi.fn(),
    openKicad: vi.fn(),
    clearChat: vi.fn(),
    pickFiles: vi.fn().mockResolvedValue([]),
    pathForFile: () => ''
  }
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = api
    useChatStore.setState({ chats: {}, drafts: {} })
    useStore.setState({ kicad: {}, checking: {} })
  })
  it('sends the draft on Enter and renders streamed items and a permission prompt', async () => {
    render(<ChatView project={project} />)
    const ta = await screen.findByPlaceholderText(/Що змінити на платі/)
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
    useChatStore.setState({ chats: { p1: { items: [], pending: null, busy: true, seq: 0, running: true } } })
    render(<ProjectSidebar />)
    expect(screen.getByText('board')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    fireEvent.click(screen.getByText('board'))
    expect(selectProject).toHaveBeenCalledWith('p1')
    expect(document.querySelector('.busy-dot.on')).not.toBeNull()
  })
})
