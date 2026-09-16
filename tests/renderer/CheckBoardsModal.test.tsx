// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckBoardsModal } from '../../src/renderer/src/components/CheckBoardsModal'
import { ProjectSidebar } from '../../src/renderer/src/components/ProjectSidebar'
import { useStore } from '../../src/renderer/src/store'
import { useChatStore } from '../../src/renderer/src/chatStore'
import type { PcbProject } from '@shared/types'

const A = '/x/board/a.kicad_pcb'
const B = '/x/board/sub/b.kicad_pcb'
const project: PcbProject = { id: 'p1', name: 'board', dir: '/x/board', proFile: '', boardFile: A, createdAt: 1, sessions: [{ id: 'p1', createdAt: 1 }], boards: [A, B], lastChecks: { [A]: { generated: 'g', summary: { error: 2, warning: 1, info: 0 } } } }

describe('CheckBoardsModal', () => {
  const api = {
    kicadStatus: vi.fn().mockResolvedValue({ running: true, apiSocket: true, runningBoards: [A] }),
    setCheckBoards: vi.fn().mockImplementation((_id: string, sel: Record<string, boolean>) => { api.listProjects.mockResolvedValue([{ ...project, checkBoards: sel }]); return Promise.resolve(undefined) }),
    listProjects: vi.fn().mockResolvedValue([project]),
    checkBoards: vi.fn().mockResolvedValue({ projectId: 'p1', boards: [] }),
    lastFindings: vi.fn().mockResolvedValue(null),
    listBoards: vi.fn().mockResolvedValue([A, B]),
    openBoard: vi.fn()
  }
  beforeEach(() => {
    ;(window as unknown as { api: unknown }).api = api
    api.listProjects.mockResolvedValue([project])
    useStore.setState({ projects: [project], checkModalProject: 'p1', checkProgress: {}, checking: {}, kicad: {}, checkResult: null, expandedProjects: {} })
    useChatStore.setState({ chats: {} })
  })
  it('says how many rules will run for the project', async () => {
    const ext = api as typeof api & { getRules: ReturnType<typeof vi.fn> }
    ext.getRules = vi.fn().mockResolvedValue({ rules: [{ code: 'A', effective: { enabled: true } }, { code: 'B', effective: { enabled: false } }, { code: 'C', effective: { enabled: true } }], errors: [], bundledDir: '', userRulesDir: '' })
    useStore.setState({ checkModalProject: null, checkModalRules: null })
    await useStore.getState().openCheckModal('p1')
    expect(ext.getRules).toHaveBeenCalledWith('p1')
    render(<CheckBoardsModal />)
    expect(screen.getByText(/Правил буде застосовано:/)).toHaveTextContent('Правил буде застосовано: 2 з 3')
  })
  it('lists the boards all on by default, remembers a switched-off board and checks only the selected ones', async () => {
    render(<CheckBoardsModal />)
    expect(await screen.findByText('відкрита в KiCad')).toBeInTheDocument()
    expect(screen.getByText('закрита — потрібен вільний API')).toBeInTheDocument()
    expect(screen.getByText('Перевірити (2)')).toBeEnabled()
    fireEvent.click(screen.getByLabelText('Перевіряти sub/b.kicad_pcb'))
    await vi.waitFor(() => expect(api.setCheckBoards).toHaveBeenCalledWith('p1', { [B]: false }))
    expect(await screen.findByText('Перевірити (1)')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Перевірити (1)'))
    await vi.waitFor(() => expect(api.checkBoards).toHaveBeenCalledWith('p1', [A]))
    await vi.waitFor(() => expect(useStore.getState().checkModalProject).toBeNull())
    expect(useStore.getState().checkResult).toEqual({ projectId: 'p1', boards: [] })
  })
  it('shows live per-board progress while checking', async () => {
    useStore.setState({ checking: { p1: true } })
    render(<CheckBoardsModal />)
    useStore.getState().applyCheckProgress({ projectId: 'p1', boardFile: B, phase: 'opening', message: 'відкриваю в KiCad…' })
    expect(await screen.findByText('відкриваю в KiCad…')).toBeInTheDocument()
    useStore.getState().applyCheckProgress({ projectId: 'p1', boardFile: B, phase: 'skipped', message: 'зайнято' })
    expect(await screen.findByText('пропущено: зайнято')).toBeInTheDocument()
    expect(screen.getByText('Перевіряю…')).toBeDisabled()
  })
})

describe('ProjectSidebar boards', () => {
  it('expands a project row into its board list with last counts and an open-in-KiCad action', async () => {
    const api = { listBoards: vi.fn().mockResolvedValue([A, B]), listProjects: vi.fn().mockResolvedValue([project]), openBoard: vi.fn() }
    ;(window as unknown as { api: unknown }).api = api
    useStore.setState({ projects: [project], config: { activeProjectId: 'p1' } as never, kicad: { p1: { running: true, apiSocket: true, runningBoards: [A] } }, expandedProjects: {}, addError: null })
    useChatStore.setState({ chats: {} })
    render(<ProjectSidebar />)
    expect(screen.queryByText('sub/b.kicad_pcb')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Показати плати'))
    expect(api.listBoards).toHaveBeenCalledWith('p1')
    expect(await screen.findByText('sub/b.kicad_pcb')).toBeInTheDocument()
    expect(screen.getByText('2/1/0')).toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument() // an unchecked board shows no placeholder
    expect(document.querySelector('.project-item.expanded.active')).not.toBeNull()
    fireEvent.click(screen.getByLabelText('Відкрити sub/b.kicad_pcb в KiCad'))
    expect(api.openBoard).toHaveBeenCalledWith('p1', B)
    fireEvent.click(screen.getByLabelText('Сховати плати'))
    expect(screen.queryByText('sub/b.kicad_pcb')).not.toBeInTheDocument()
  })
})
