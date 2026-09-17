import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatEvent } from '@shared/types'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => '/tmp', isPackaged: false } }))
// A restart respawns `claude`; never let the tests reach the real binary.
const spawned: { args: string[] }[] = []
vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events')
  return {
    spawn: (_shell: string, args: string[]) => {
      spawned.push({ args })
      const p = new EventEmitter() as EventEmitter & { pid: number; stdin: { write: () => void }; stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
      Object.assign(p, { pid: 424242, stdin: { write: () => {} }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => {} })
      return p
    }
  }
})

import { _entryForTest, answerChat, attachChat, buildCommand, describeStart, handleLine, killChat, onChatEvent, onChatParams, onChatSessionId, setChatParams, setChatStorageDir, stopChatWorkflow, summarizeToolUse } from '../../src/main/claudeChat'

const events: ChatEvent[] = []
onChatEvent((_id, _seq, ev) => events.push(ev))
const sessionIds: string[] = []
onChatSessionId((_id, sid) => sessionIds.push(sid))
setChatStorageDir(null)

function feed(id: string, lines: unknown[]): void {
  const e = _entryForTest(id)
  for (const l of lines) handleLine(id, e, JSON.stringify(l))
}

describe('describeStart', () => {
  it('lists every parameter the session is started with, reading MCP names from the config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
    const mcp = join(dir, 'p.json')
    writeFileSync(mcp, JSON.stringify({ mcpServers: { pcbagent: {} } }))
    const text = describeStart({ cwd: '/x', resume: '1744f7dd-aaaa', mcpConfig: mcp, args: '--dangerously-skip-permissions', effort: 'high', profileLabel: 'стандартний ~/.claude' })
    expect(text).toBe('🔄 Сесію запущено · модель: default · зусилля: high · режим: default · resume: так (1744f7dd…) · MCP: 1 (pcbagent) · профіль: стандартний ~/.claude · args: --dangerously-skip-permissions')
    expect(describeStart({ cwd: '/x', model: 'opus', args: '--permission-mode plan', env: { CLAUDE_CONFIG_DIR: '/cfg/p1' } }))
      .toBe('🔄 Сесію запущено · модель: opus · зусилля: default · режим: plan · resume: ні — нова розмова · MCP: немає · профіль: /cfg/p1 · args: --permission-mode plan')
    expect(describeStart({ cwd: '/x', mcpConfig: '/nope.json' })).toContain('MCP: немає · профіль: стандартний ~/.claude · args: немає')
  })
  // Ultracode overrides the stored level at runtime, so naming that level here would lie.
  it('reports ultracode instead of the level it overrides', () => {
    expect(describeStart({ cwd: '/x', effort: 'high', ultracode: true })).toContain('зусилля: ultracode (xhigh + воркфлови)')
    expect(describeStart({ cwd: '/x', effort: 'high', ultracode: false })).toContain('зусилля: high')
  })
})

describe('buildCommand', () => {
  it('builds the headless stream-json invocation with optional parts', () => {
    const cmd = buildCommand({ cwd: '/x', resume: 'abc', mcpConfig: '/m.json', systemPrompt: 'hi there', args: '--dangerously-skip-permissions' })
    expect(cmd).toContain('exec claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio')
    expect(cmd).toContain('--resume abc')
    expect(cmd).toContain('--mcp-config /m.json')
    expect(cmd).toContain('--append-system-prompt "hi there"')
    expect(cmd.endsWith('--dangerously-skip-permissions')).toBe(true)
  })
})

describe('handleLine', () => {
  beforeEach(() => {
    events.length = 0
  })
  it('records the session id, streams text, finalizes on assistant, ends busy on result', () => {
    const id = 't1'
    feed(id, [
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Прив' } } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'іт' } } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Привіт!' }, { type: 'tool_use', id: 'tu1', name: 'mcp__pcbagent__run_checks', input: { with_drc: true } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '# report' }] }] } },
      { type: 'result', subtype: 'success', result: 'Привіт!' }
    ])
    const e = _entryForTest(id)
    expect(sessionIds).toEqual(['sess-1'])
    expect(e.items.map((i) => i.role)).toEqual(['assistant', 'tool'])
    expect(e.items[0].text).toBe('Привіт!')
    expect(e.items[1]).toMatchObject({ toolName: 'mcp__pcbagent__run_checks', done: true, isError: false, output: '# report', text: 'run_checks(with_drc=true)' })
    expect(e.busy).toBe(false)
    expect(events.some((ev) => ev.type === 'busy' && ev.busy)).toBe(true)
    expect(events.filter((ev) => ev.type === 'append')).toHaveLength(2)
  })
  it('turns can_use_tool into a permission pending and answers it', () => {
    const id = 't2'
    const e = _entryForTest(id)
    const written: unknown[] = []
    e.proc = { stdin: { write: (s: string) => written.push(JSON.parse(s)) } } as never
    feed(id, [{ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /' } } }])
    expect(e.queue[0].pending).toMatchObject({ kind: 'permission', requestId: 'r1', toolName: 'Bash', summary: 'rm -rf /' })
    answerChat(id, { kind: 'permission', requestId: 'r1', allow: false, message: 'ні' })
    expect(written[0]).toMatchObject({ type: 'control_response', response: { request_id: 'r1', response: { behavior: 'deny', message: 'ні' } } })
    expect(e.queue).toHaveLength(0)
    expect(e.items.at(-1)?.text).toContain('Відхилено')
  })
  it('turns AskUserQuestion into a question pending and sends the answers back', () => {
    const id = 't3'
    const e = _entryForTest(id)
    const written: unknown[] = []
    e.proc = { stdin: { write: (s: string) => written.push(JSON.parse(s)) } } as never
    const questions = [{ question: 'Який шар?', header: 'Шар', options: [{ label: 'F.Cu' }, { label: 'B.Cu' }] }]
    feed(id, [{ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } } }])
    expect(e.queue[0].pending.kind).toBe('question')
    answerChat(id, { kind: 'question', requestId: 'q1', answers: { 'Який шар?': 'F.Cu' } })
    expect(written[0]).toMatchObject({ response: { request_id: 'q1', response: { behavior: 'allow', updatedInput: { questions, answers: { 'Який шар?': 'F.Cu' } } } } })
    expect(e.items.at(-1)).toMatchObject({ role: 'user', answer: true, text: 'Шар: F.Cu' })
  })
  it('acknowledges unknown control requests, ignores junk, and drops the transcript on a new session id', () => {
    const id = 't4'
    const e = _entryForTest(id)
    const written: unknown[] = []
    e.proc = { stdin: { write: (s: string) => written.push(JSON.parse(s)) } } as never
    handleLine(id, e, 'not json at all')
    feed(id, [{ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback' } }])
    expect(written[0]).toMatchObject({ response: { request_id: 'h1' } })
    feed(id, [{ type: 'system', subtype: 'init', session_id: 'a' }, { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }, { type: 'system', subtype: 'init', session_id: 'b' }])
    expect(e.items.map((i) => i.role)).toEqual(['info'])
    expect(events.some((ev) => ev.type === 'clear')).toBe(true)
  })
  it('shows the result text when the turn streamed nothing (e.g. /usage output)', () => {
    const id = 't5'
    feed(id, [{ type: 'result', subtype: 'success', result: 'Usage: 42%' }])
    expect(_entryForTest(id).items.at(-1)).toMatchObject({ role: 'assistant', text: 'Usage: 42%' })
  })
})

/**
 * Ultracode is not a separate mode: the CLI reports it as an *effort level* and picking any
 * ordinary level turns it off. So it is the last option of the same selector, but with a
 * different mechanism underneath: a live `apply_flag_settings` flag instead of a `--effort` respawn.
 */
describe('ultracode (the last effort level)', () => {
  const models = [{ value: 'default', displayName: 'Default', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] }]
  /** A session whose fake process answered the initialize handshake; returns its stdin writes. */
  const ready = (id: string, opts: Record<string, unknown> = {}): { written: Record<string, unknown>[]; killed: () => number } => {
    const e = _entryForTest(id)
    const written: Record<string, unknown>[] = []
    const before = spawned.length
    const killed = (): number => spawned.length - before // a restart = kill + respawn
    e.proc = { stdin: { write: (s: string) => written.push(JSON.parse(s) as Record<string, unknown>) }, kill: () => {} } as never
    e.opts = { cwd: '/x', effort: 'high', ...opts }
    e.initRequestId = 'init-1'
    feed(id, [{ type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: { models, commands: [] } } }])
    return { written, killed }
  }
  const flagWrites = (written: Record<string, unknown>[]): { ultracode?: boolean }[] =>
    written.filter((w) => w.type === 'control_request' && (w.request as { subtype?: string }).subtype === 'apply_flag_settings').map((w) => (w.request as { settings: { ultracode?: boolean } }).settings)
  beforeEach(() => {
    events.length = 0
  })

  it('is offered as the last option of the effort selector', () => {
    ready('u1')
    expect(attachChat('u1').modelState?.models[0]?.supportedEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(attachChat('u1').modelState).toMatchObject({ effort: 'high', ultracode: false })
  })

  it('turns on live (no restart) and becomes the current effort', () => {
    const sink = vi.fn()
    onChatParams(sink)
    const { written, killed } = ready('u2')
    expect(setChatParams('u2', { effort: 'ultracode' })).toEqual({ ok: true })
    expect(sink).toHaveBeenCalledWith('u2', { ultracode: true })
    expect(killed()).toBe(0) // live control request, not a respawn
    expect(flagWrites(written)).toEqual([{ ultracode: true }])
    // the selector shows it *instead of* a level, never alongside one
    expect(attachChat('u2').modelState).toMatchObject({ ultracode: true, effort: 'ultracode' })
    expect(events.filter((ev) => ev.type === 'meta').at(-1)).toMatchObject({ modelState: { effort: 'ultracode' } })
    expect(_entryForTest('u2').items.at(-1)?.text).toContain('Ультракод увімкнено')
    // re-picking it is a no-op (no repeated control request)
    setChatParams('u2', { effort: 'ultracode' })
    expect(flagWrites(written)).toHaveLength(1)
  })

  it('picking an ordinary level turns it off live and restarts only when the level really changed', () => {
    const sink = vi.fn()
    onChatParams(sink)
    const { written, killed } = ready('u3')
    setChatParams('u3', { effort: 'ultracode' })
    // the stored level is unchanged: the flag comes off, nothing to restart for
    setChatParams('u3', { effort: 'high' })
    expect(flagWrites(written)).toEqual([{ ultracode: true }, { ultracode: false }])
    expect(sink).toHaveBeenLastCalledWith('u3', { ultracode: false })
    expect(killed()).toBe(0)
    expect(attachChat('u3').modelState).toMatchObject({ ultracode: false, effort: 'high' })
    // a different level: off live *and* the --effort respawn
    setChatParams('u3', { effort: 'ultracode' })
    setChatParams('u3', { effort: 'low' })
    expect(sink).toHaveBeenLastCalledWith('u3', { model: undefined, effort: 'low' })
    expect(killed()).toBe(1)
    expect(spawned.at(-1)?.args.join(' ')).toContain('--effort low')
    expect(_entryForTest('u3').opts).toMatchObject({ effort: 'low', ultracode: false })
    _entryForTest('u3').proc = undefined // drop the fake respawn
  })

  it('rolls back when the CLI refuses it (workflows off / no xhigh)', () => {
    const sink = vi.fn()
    onChatParams(sink)
    const { written } = ready('u4')
    setChatParams('u4', { effort: 'ultracode' })
    const req = written.at(-1) as { request_id: string }
    expect(attachChat('u4').modelState).toMatchObject({ effort: 'ultracode' })
    feed('u4', [{ type: 'control_response', response: { subtype: 'error', request_id: req.request_id, error: 'apply_flag_settings: ultracode is not available for this session' } }])
    expect(attachChat('u4').modelState).toMatchObject({ ultracode: false, effort: 'high' })
    expect(sink).toHaveBeenLastCalledWith('u4', { ultracode: false })
    expect(_entryForTest('u4').items.some((i) => i.role === 'info' && i.text.includes('Ультракод недоступний'))).toBe(true)
    // a success response is consumed silently, other errors still surface
    setChatParams('u4', { effort: 'ultracode' })
    const ok = written.at(-1) as { request_id: string }
    feed('u4', [{ type: 'control_response', response: { subtype: 'success', request_id: ok.request_id } }, { type: 'control_response', response: { subtype: 'error', request_id: 'other', error: 'boom' } }])
    expect(attachChat('u4').modelState).toMatchObject({ ultracode: true })
    expect(_entryForTest('u4').items.at(-1)?.text).toBe('Помилка: boom')
  })

  it('re-asserts a persisted choice after the handshake (the flag layer is per-process)', () => {
    const { written } = ready('u5', { ultracode: true })
    expect(flagWrites(written)).toEqual([{ ultracode: true }])
    expect(attachChat('u5').modelState).toMatchObject({ effort: 'ultracode', ultracode: true })
    const off = ready('u6', { ultracode: false })
    expect(flagWrites(off.written)).toEqual([{ ultracode: false }])
    expect(flagWrites(ready('u7').written)).toEqual([]) // never chosen: nothing to enforce
  })
})

/** The Workflow tool (ultracode) is one background task: its row waits for the task, not the tool_result. */
describe('workflow task events', () => {
  const WF = 'toolu_wf'
  const launch = (id: string): void =>
    feed(id, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: WF, name: 'Workflow', input: { script: "export const meta = { name: 'probe', description: 'Tiny probe' }" } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'task1', tool_use_id: WF, task_type: 'local_workflow', workflow_name: 'probe', description: 'Tiny probe' },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: WF, content: 'Workflow launched in background. Task ID: task1' }] } }
    ])
  const progress = (id: string, rows: unknown[], usage = { total_tokens: 1200, tool_uses: 3, duration_ms: 500 }): void =>
    feed(id, [{ type: 'system', subtype: 'task_progress', task_id: 'task1', tool_use_id: WF, description: 'Ask: a1', usage, workflow_progress: rows }])
  beforeEach(() => {
    events.length = 0
  })

  it('seeds the run on task_started and keeps the row running past the "launched" tool_result', () => {
    const id = 'w1'
    launch(id)
    const item = _entryForTest(id).items.find((it) => it.id === WF)!
    expect(item.text).toBe('probe — Tiny probe')
    expect(item.done).toBeUndefined()
    expect(item.workflow).toMatchObject({ taskId: 'task1', name: 'probe', description: 'Tiny probe', status: 'running', agents: [] })
    // the main turn ends while the workflow runs: the session stays busy
    feed(id, [{ type: 'result', subtype: 'success', result: 'running in background' }])
    expect(_entryForTest(id).busy).toBe(true)
  })

  it('folds workflow_progress snapshots (sorted, previews cut) and keeps the last one on a heartbeat', () => {
    const id = 'w2'
    launch(id)
    progress(id, [
      { type: 'workflow_phase', index: 2, title: 'Sum' },
      { type: 'workflow_phase', index: 1, title: 'Ask' },
      { type: 'workflow_agent', index: 2, label: 'a2', state: 'progress', phaseIndex: 1, startedAt: 5, promptPreview: 'x'.repeat(700) },
      { type: 'workflow_agent', index: 1, label: 'a1', state: 'done', phaseIndex: 1, tokens: 300 },
      { type: 'junk' },
      { type: 'workflow_agent', label: 'no index' }
    ])
    const run = _entryForTest(id).items.find((it) => it.id === WF)!.workflow!
    expect(run.phases.map((p) => p.title)).toEqual(['Ask', 'Sum'])
    expect(run.agents.map((a) => a.label)).toEqual(['a1', 'a2'])
    expect(run.agents[1].promptPreview).toHaveLength(600)
    expect(run).toMatchObject({ totalTokens: 1200, toolUses: 3, durationMs: 500, current: 'Ask: a1' })
    feed(id, [{ type: 'system', subtype: 'task_progress', task_id: 'task1', tool_use_id: WF, description: 'Sum: total', usage: { total_tokens: 2000 } }])
    expect(run.agents).toHaveLength(2)
    expect(run).toMatchObject({ totalTokens: 2000, current: 'Sum: total' })
    expect(events.filter((ev) => ev.type === 'update').length).toBeGreaterThanOrEqual(2)
  })

  it('closes the run on task_updated + task_notification with the summary, and frees busy at the follow-up result', () => {
    const id = 'w3'
    launch(id)
    progress(id, [{ type: 'workflow_agent', index: 1, label: 'a1', state: 'progress', startedAt: 1 }])
    feed(id, [
      { type: 'system', subtype: 'task_updated', task_id: 'task1', patch: { status: 'completed' } },
      { type: 'system', subtype: 'task_notification', task_id: 'task1', tool_use_id: WF, status: 'completed', summary: 'Dynamic workflow "Tiny probe" completed', usage: { total_tokens: 9999 } }
    ])
    const item = _entryForTest(id).items.find((it) => it.id === WF)!
    expect(item).toMatchObject({ done: true, isError: false, output: 'Dynamic workflow "Tiny probe" completed' })
    expect(item.workflow).toMatchObject({ status: 'completed', summary: 'Dynamic workflow "Tiny probe" completed', totalTokens: 9999 })
    expect(item.workflow!.endTs).toBeDefined()
    feed(id, [{ type: 'result', subtype: 'success', result: 'done' }])
    expect(_entryForTest(id).busy).toBe(false)
  })

  it('a failed/killed run marks its unfinished agents as errored and the row as an error', () => {
    const id = 'w4'
    launch(id)
    progress(id, [{ type: 'workflow_agent', index: 1, label: 'a1', state: 'done' }, { type: 'workflow_agent', index: 2, label: 'a2', state: 'progress', startedAt: 1 }])
    feed(id, [{ type: 'system', subtype: 'task_updated', task_id: 'task1', patch: { status: 'killed' } }])
    const item = _entryForTest(id).items.find((it) => it.id === WF)!
    expect(item.workflow).toMatchObject({ status: 'killed' })
    expect(item.workflow!.agents.map((a) => a.state)).toEqual(['done', 'error'])
    feed(id, [{ type: 'system', subtype: 'task_notification', task_id: 'task1', tool_use_id: WF, status: 'killed', summary: 'stopped' }])
    expect(item).toMatchObject({ done: true, isError: true, output: 'stopped' })
    expect(item.workflow!.summary).toBe('stopped') // a late summary still lands on the closed run
  })

  it('stopChatWorkflow sends stop_task for the run and says so', () => {
    const id = 'w5'
    const e = _entryForTest(id)
    const written: Record<string, unknown>[] = []
    e.proc = { stdin: { write: (s: string) => written.push(JSON.parse(s) as Record<string, unknown>) } } as never
    launch(id)
    stopChatWorkflow(id, 'task1')
    expect(written.at(-1)).toMatchObject({ type: 'control_request', request: { subtype: 'stop_task', task_id: 'task1' } })
    expect(e.items.at(-1)?.text).toBe('Зупиняю воркфлов «probe»…')
    stopChatWorkflow(id, '')
    expect(written).toHaveLength(1)
    e.proc = undefined
  })

  it('a killed session freezes a running workflow instead of leaving it spinning', () => {
    const id = 'w6'
    const e = _entryForTest(id)
    e.proc = { pid: 0, stdin: { write: () => {} }, kill: () => {} } as never
    launch(id)
    killChat(id)
    const item = e.items.find((it) => it.id === WF)!
    expect(item).toMatchObject({ done: true, isError: true, output: 'Воркфлов перервано.' })
    expect(item.workflow).toMatchObject({ status: 'killed' })
    expect(e.runningTasks.size).toBe(0)
  })
})

describe('summarizeToolUse', () => {
  it('names a Workflow run from its script meta (ultracode launches these)', () => {
    const script = "export const meta = {\n  name: 'review-board',\n  description: 'Перевірити плату по зонах',\n}\nconst r = await agent('x')"
    expect(summarizeToolUse('Workflow', { script })).toBe('review-board — Перевірити плату по зонах')
    expect(summarizeToolUse('Workflow', { name: 'saved-flow' })).toBe('saved-flow')
    expect(summarizeToolUse('Workflow', {})).toBe('воркфлов')
  })
  it('labels Bash, file tools and MCP tools compactly', () => {
    expect(summarizeToolUse('Bash', { command: 'ls  -la' })).toBe('ls -la')
    expect(summarizeToolUse('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(summarizeToolUse('mcp__pcbagent__route', { net: 'X', ref_a: 'U1' })).toBe('route(net=X, ref_a=U1)')
    expect(summarizeToolUse('Other', { k: 'v' }, 5)).toHaveLength(5)
  })
})
