// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionTabs } from '../../src/renderer/src/components/SessionTabs'
import { useStore } from '../../src/renderer/src/store'
import { useChatStore } from '../../src/renderer/src/chatStore'
import type { ChatSession, PcbProject } from '@shared/types'

function mkProject(sessions: ChatSession[]): PcbProject {
  return { id: 'w', name: 'board', dir: '/x/board', proFile: '', boardFile: '/x/board/board.kicad_pcb', createdAt: 0, sessions }
}
const two = [{ id: 's1', createdAt: 0 }, { id: 's2', createdAt: 0 }]

describe('SessionTabs', () => {
  const api = { createSession: vi.fn(), closeSession: vi.fn().mockResolvedValue(true), renameSession: vi.fn() }
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = api
    api.createSession.mockReset()
    api.closeSession.mockReset().mockResolvedValue(true)
    api.renameSession.mockReset()
    useStore.setState({ activeSessionByProject: {} })
    useChatStore.setState({ chats: {}, drafts: {}, attachments: {} })
  })

  it('renders one auto-numbered tab per session plus an add button', () => {
    render(<SessionTabs project={mkProject(two)} activeSessionId="s1" />)
    expect(screen.getByText('Сесія 1')).toBeInTheDocument()
    expect(screen.getByText('Сесія 2')).toBeInTheDocument()
    expect(screen.getByTitle('Нова сесія Claude')).toBeInTheDocument()
  })

  it('uses a custom title when set', () => {
    render(<SessionTabs project={mkProject([{ id: 's1', createdAt: 0, title: 'refactor' }])} activeSessionId="s1" />)
    expect(screen.getByText('refactor')).toBeInTheDocument()
  })

  it('hides the close button when only one session remains', () => {
    render(<SessionTabs project={mkProject([{ id: 's1', createdAt: 0 }])} activeSessionId="s1" />)
    expect(screen.queryByTitle('Закрити сесію')).not.toBeInTheDocument()
  })

  it('clicking a tab selects that session and persists the choice', () => {
    render(<SessionTabs project={mkProject(two)} activeSessionId="s1" />)
    fireEvent.click(screen.getByText('Сесія 2'))
    expect(useStore.getState().activeSessionByProject.w).toBe('s2')
    expect(JSON.parse(localStorage.getItem('conductor-pcb.activeSession') ?? '{}')).toEqual({ w: 's2' })
  })

  it('the add button creates a session and selects it', async () => {
    api.createSession.mockResolvedValueOnce({ id: 'fresh', createdAt: 0 })
    render(<SessionTabs project={mkProject([{ id: 's1', createdAt: 0 }])} activeSessionId="s1" />)
    fireEvent.click(screen.getByTitle('Нова сесія Claude'))
    expect(api.createSession).toHaveBeenCalledWith('w')
    await waitFor(() => expect(useStore.getState().activeSessionByProject.w).toBe('fresh'))
  })

  it('closing the active session selects a sibling, calls closeSession and drops its mirror', async () => {
    useChatStore.setState({ chats: { s1: { items: [], pending: null, busy: false, seq: 0, running: true, commands: [], modelState: null } }, drafts: { s1: 'draft' } })
    render(<SessionTabs project={mkProject(two)} activeSessionId="s1" />)
    fireEvent.click(screen.getAllByTitle('Закрити сесію')[0])
    expect(useStore.getState().activeSessionByProject.w).toBe('s2')
    expect(api.closeSession).toHaveBeenCalledWith('s1')
    await waitFor(() => expect(useChatStore.getState().chats.s1).toBeUndefined())
    expect(useChatStore.getState().drafts.s1).toBeUndefined()
  })

  it('double-click opens a rename input that commits on Enter', () => {
    render(<SessionTabs project={mkProject([{ id: 's1', createdAt: 0 }])} activeSessionId="s1" />)
    fireEvent.doubleClick(screen.getByText('Сесія 1'))
    const input = screen.getByDisplayValue('Сесія 1') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'bugfix' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.renameSession).toHaveBeenCalledWith('s1', 'bugfix')
  })

  it('right-click opens a rename input pre-filled with the custom title', () => {
    render(<SessionTabs project={mkProject([{ id: 's1', createdAt: 0, title: 'refactor' }])} activeSessionId="s1" />)
    fireEvent.contextMenu(screen.getByText('refactor'))
    const input = screen.getByDisplayValue('refactor') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'review' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(api.renameSession).toHaveBeenCalledWith('s1', 'review')
  })

  it('cancels the rename on Escape', () => {
    render(<SessionTabs project={mkProject([{ id: 's1', createdAt: 0 }])} activeSessionId="s1" />)
    fireEvent.doubleClick(screen.getByText('Сесія 1'))
    const input = screen.getByDisplayValue('Сесія 1') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'nope' } })
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(false)
    expect(api.renameSession).not.toHaveBeenCalled()
    expect(screen.getByText('Сесія 1')).toBeInTheDocument()
  })

  it('shows a busy spinner on a working session', () => {
    useChatStore.setState({ chats: { s2: { items: [], pending: null, busy: true, seq: 0, running: true, commands: [], modelState: null } } })
    const { container } = render(<SessionTabs project={mkProject(two)} activeSessionId="s1" />)
    expect(container.querySelector('.session-tab-spin')).toBeInTheDocument()
  })
})
