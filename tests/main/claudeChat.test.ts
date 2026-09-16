import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ChatEvent } from '@shared/types'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => '/tmp', isPackaged: false } }))

import { _entryForTest, answerChat, buildCommand, handleLine, onChatEvent, onChatSessionId, setChatStorageDir, summarizeToolUse } from '../../src/main/claudeChat'

const events: ChatEvent[] = []
onChatEvent((_id, _seq, ev) => events.push(ev))
const sessionIds: string[] = []
onChatSessionId((_id, sid) => sessionIds.push(sid))
setChatStorageDir(null)

function feed(id: string, lines: unknown[]): void {
  const e = _entryForTest(id)
  for (const l of lines) handleLine(id, e, JSON.stringify(l))
}

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

describe('summarizeToolUse', () => {
  it('labels Bash, file tools and MCP tools compactly', () => {
    expect(summarizeToolUse('Bash', { command: 'ls  -la' })).toBe('ls -la')
    expect(summarizeToolUse('Read', { file_path: '/a/b.ts' })).toBe('/a/b.ts')
    expect(summarizeToolUse('mcp__pcbagent__route', { net: 'X', ref_a: 'U1' })).toBe('route(net=X, ref_a=U1)')
    expect(summarizeToolUse('Other', { k: 'v' }, 5)).toHaveLength(5)
  })
})
