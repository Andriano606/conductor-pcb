// @vitest-environment jsdom
import React, { useState } from 'react'
import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ChatItem, WorkflowAgent, WorkflowRun } from '@shared/types'
import { WorkflowPanel, WorkflowRow, formatSpan, formatTokens } from '../../src/renderer/src/components/WorkflowView'
import { useChatStore } from '../../src/renderer/src/chatStore'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => '/tmp', isPackaged: false } }))
import { _entryForTest, handleLine, setChatStorageDir } from '../../src/main/claudeChat'

const api = { stopChatWorkflow: vi.fn() }
beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = api
  api.stopChatWorkflow.mockClear()
})

const agent = (over: Partial<WorkflowAgent> & { index: number; label: string }): WorkflowAgent => ({ state: 'start', phaseIndex: 1, phaseTitle: 'Пошук', model: 'claude-opus-5', ...over })

const mkRun = (over: Partial<WorkflowRun> = {}): WorkflowRun => ({
  taskId: 'wf_task1',
  name: 'board-audit',
  description: 'Мультиагентна перевірка плати',
  status: 'running',
  phases: [{ index: 1, title: 'Пошук' }, { index: 2, title: 'Перевірка' }],
  agents: [
    agent({ index: 1, label: 'find:power', state: 'done', startedAt: 1000, tokens: 75400 }),
    agent({ index: 2, label: 'find:clock', state: 'progress', startedAt: 1000, tokens: 12000 }),
    agent({ index: 3, label: 'find:usb' }), // queued: no startedAt
    agent({ index: 4, label: 'check:one', phaseIndex: 2, phaseTitle: 'Перевірка' })
  ],
  totalTokens: 860500,
  toolUses: 12,
  durationMs: 94000,
  startTs: Date.now() - 94000,
  ...over
})

/** Stands in for ChatView: the row is in the transcript, the panel it opens one level up. */
function Host({ item }: { item: ChatItem }): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null)
  return (
    <>
      <WorkflowRow item={item} onOpen={() => setOpenId(item.id)} />
      {openId && <WorkflowPanel sessionId="s1" itemId={openId} onClose={() => setOpenId(null)} />}
    </>
  )
}

/** Put the item in the store (the panel reads the run live from there) and render its row. */
function renderRow(run: WorkflowRun): ChatItem {
  const item: ChatItem = { id: 'toolu_wf1', role: 'tool', toolName: 'Workflow', text: 'board-audit', done: run.status !== 'running', ts: run.startTs, workflow: run }
  useChatStore.setState({ chats: { s1: { items: [item], pending: null, busy: true, seq: 1, running: true, commands: [], modelState: null } } })
  render(<Host item={item} />)
  return item
}

describe('formatters', () => {
  it('render spans and token counts compactly', () => {
    expect(formatSpan(3200)).toBe('3.2с')
    expect(formatSpan(64_000)).toBe('1хв 04с')
    expect(formatSpan(4_320_000)).toBe('1г 12хв')
    expect(formatTokens(912)).toBe('912')
    expect(formatTokens(75_400)).toBe('75.4k')
    expect(formatTokens(3_800_000)).toBe('3.80M')
  })
})

describe('WorkflowRow', () => {
  it('shows the run name, what it is doing and the live totals', () => {
    renderRow(mkRun({ current: 'Пошук: find:clock' }))
    expect(screen.getByText('board-audit')).toBeInTheDocument()
    // The current step wins over the static description (like the TUI status line).
    expect(screen.getByText('Пошук: find:clock')).toBeInTheDocument()
    expect(screen.getByText('1/4 агентів')).toBeInTheDocument()
    expect(screen.getByText('↓860.5k')).toBeInTheDocument()
  })
  it('falls back to the description before the first progress event', () => {
    renderRow(mkRun({ current: undefined }))
    expect(screen.getByText('Мультиагентна перевірка плати')).toBeInTheDocument()
  })
})

describe('WorkflowPanel', () => {
  const open = (run = mkRun()): void => {
    renderRow(run)
    fireEvent.click(screen.getByText('board-audit'))
  }

  it('opens from the row and lists the plan with per-phase progress', () => {
    open()
    expect(screen.getByText('План')).toBeInTheDocument()
    expect(screen.getByText('Пошук')).toBeInTheDocument()
    expect(screen.getByText('Перевірка')).toBeInTheDocument()
    expect(screen.getByText('1/3')).toBeInTheDocument() // phase 1: 3 agents, one done
    expect(screen.getByText('0/1')).toBeInTheDocument() // phase 2
  })

  it('lists every agent with its state, and filters to the picked phase', () => {
    open()
    expect(screen.getByText('find:power')).toBeInTheDocument()
    expect(screen.getByText('check:one')).toBeInTheDocument()
    expect(screen.getAllByText('у черзі')).toHaveLength(2)
    expect(screen.getByText('12.0k tok')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Перевірка'))
    expect(screen.queryByText('find:power')).not.toBeInTheDocument()
    expect(screen.getByText('check:one')).toBeInTheDocument()
  })

  it('expands an agent to show its prompt and result', () => {
    const run = mkRun()
    run.agents[0].promptPreview = 'Audit the power section'
    run.agents[0].resultPreview = '{"findings":[]}'
    open(run)
    expect(screen.queryByText('Audit the power section')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('find:power'))
    expect(screen.getByText('Audit the power section')).toBeInTheDocument()
    expect(screen.getByText('{"findings":[]}')).toBeInTheDocument()
  })

  it('offers «Зупинити» only while the run is live, stops it through the CLI, closes on Escape', () => {
    open()
    fireEvent.click(screen.getByText('Зупинити воркфлов'))
    expect(api.stopChatWorkflow).toHaveBeenCalledWith('s1', 'wf_task1')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByText('План')).not.toBeInTheDocument()
  })

  it('a finished run shows its status and summary instead of a stop button', () => {
    open(mkRun({ status: 'completed', endTs: Date.now(), summary: 'Знайдено 3 дефекти', current: undefined }))
    expect(screen.getByText('завершено')).toBeInTheDocument()
    expect(screen.getByText('Знайдено 3 дефекти')).toBeInTheDocument()
    expect(screen.queryByText('Зупинити воркфлов')).not.toBeInTheDocument()
  })

  it('keeps updating live from the store while open', () => {
    const item = renderRow(mkRun())
    fireEvent.click(screen.getByText('board-audit'))
    const next = { ...item, workflow: { ...item.workflow!, agents: item.workflow!.agents.map((a) => ({ ...a, state: 'done' as const, startedAt: 1 })) } }
    act(() => useChatStore.getState().applyEvent({ id: 's1', seq: 2, ev: { type: 'update', item: next } }))
    expect(screen.getByText('4/4 агентів')).toBeInTheDocument()
  })
})

/**
 * End-to-end over a real recording (`tests/fixtures/ultracode-workflow.ndjson`, captured from
 * `claude -p --output-format stream-json`): a session with ultracode applied was given an ordinary
 * question, Claude reached for the Workflow tool on its own. Those exact bytes go through the
 * main-process parser, then the row and its panel render the result.
 */
describe('a workflow Claude launched on its own (ultracode)', () => {
  it('parses the CLI stream into ChatItem.workflow and renders the row and panel from it', () => {
    setChatStorageDir(null)
    const id = 'wf-e2e'
    const e = _entryForTest(id)
    for (const line of readFileSync(join(__dirname, '../fixtures/ultracode-workflow.ndjson'), 'utf8').split('\n')) if (line.trim()) handleLine(id, e, line)
    const item = e.items.find((it) => it.toolName === 'Workflow')
    const run = item?.workflow
    if (!item || !run) throw new Error('the recording produced no workflow item')
    // task_type: 'local_workflow' on task_started is the whole detection rule — nothing inferred from text.
    expect(run).toMatchObject({ taskId: 'wd6t9c0kz', name: 'smoke-test', status: 'completed', totalTokens: 49955 })
    expect(run.phases.map((p) => p.title)).toEqual(['Ask', 'Sum'])
    expect(run.agents.length).toBeGreaterThan(0)
    expect(run.agents.every((a) => a.state === 'done')).toBe(true)
    expect(run.summary).toContain('completed')
    // the tool row waited for the task, not the immediate "launched" tool_result
    expect(item).toMatchObject({ done: true, isError: false })
    expect(item.output).toContain('completed')
    // the transcript kept the assistant's follow-up turn and the session went idle only at its end
    expect(e.items.at(-1)?.text).toContain('Workflow finished')
    expect(e.busy).toBe(false)

    useChatStore.setState({ chats: { s1: { items: [item], pending: null, busy: false, seq: 1, running: true, commands: [], modelState: null } } })
    render(<Host item={item} />)
    expect(screen.getByText('smoke-test')).toBeInTheDocument()
    expect(screen.getByText(`${run.agents.length}/${run.agents.length} агентів`)).toBeInTheDocument()
    fireEvent.click(screen.getByText('smoke-test'))
    expect(screen.getByText('План')).toBeInTheDocument()
    for (const phase of run.phases) expect(screen.getAllByText(phase.title).length).toBeGreaterThan(0)
    for (const a of run.agents) expect(screen.getByText(a.label)).toBeInTheDocument()
  })
})
