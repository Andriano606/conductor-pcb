/**
 * One headless `claude` process per project, speaking NDJSON over stdio
 * (`-p --input-format stream-json --output-format stream-json`). The transcript is a
 * structured ChatItem[] mirrored to the renderer through sequenced events; permission
 * requests and AskUserQuestion arrive as control_request/can_use_tool and become ChatPending.
 * Slimmed down from conductor-linux's claudeChat.ts (no subagents/workflows/local commands).
 */
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ChatAnswer, ChatAttachment, ChatCommand, ChatEvent, ChatItem, ChatModelOption, ChatModelState, ChatPending, ChatQuestion, ChatSnapshot } from '../shared/types'
import { buildEnv } from './env'

export interface StartOpts {
  cwd: string
  resume?: string
  mcpConfig?: string
  systemPrompt?: string
  args?: string
  model?: string
  effort?: string
  /** Extra environment (CLAUDE_CONFIG_DIR of a merged profile dir, profile env vars). */
  env?: NodeJS.ProcessEnv
}

interface Entry {
  proc?: ChildProcess
  items: ChatItem[]
  seq: number
  busy: boolean
  queue: { pending: ChatPending; rawInput: unknown }[]
  liveId?: string
  stdoutBuf: string
  stderrTail: string
  sessionId?: string
  opts?: StartOpts
  saveTimer?: NodeJS.Timeout
  turnHadText: boolean
  initRequestId?: string
  commands?: ChatCommand[]
  models?: ChatModelOption[]
}

const MAX_ITEMS = 2000
const entries = new Map<string, Entry>()
let storageDir: string | null = null
let emitSink: (id: string, seq: number, ev: ChatEvent) => void = () => {}
let sessionIdSink: (id: string, sessionId: string) => void = () => {}
let busySink: (id: string, busy: boolean) => void = () => {}
let paramsSink: (id: string, params: { model?: string; effort?: string }) => void = () => {}
export function onChatParams(fn: typeof paramsSink): void {
  paramsSink = fn
}

export function setChatStorageDir(dir: string | null): void {
  storageDir = dir
  if (dir) mkdirSync(dir, { recursive: true })
}
export function onChatEvent(fn: typeof emitSink): void {
  emitSink = fn
}
export function onChatSessionId(fn: typeof sessionIdSink): void {
  sessionIdSink = fn
}
export function onChatBusy(fn: typeof busySink): void {
  busySink = fn
}

function ensure(id: string): Entry {
  let e = entries.get(id)
  if (!e) {
    e = { items: [], seq: 0, busy: false, queue: [], stdoutBuf: '', stderrTail: '', turnHadText: false }
    entries.set(id, e)
    load(id, e)
  }
  return e
}

function emit(id: string, e: Entry, ev: ChatEvent): void {
  e.seq += 1
  emitSink(id, e.seq, ev)
  if (ev.type !== 'busy' && ev.type !== 'pending') scheduleSave(id, e)
}

function pushItem(id: string, e: Entry, item: ChatItem): void {
  e.items.push(item)
  if (e.items.length > MAX_ITEMS) e.items.splice(0, e.items.length - MAX_ITEMS)
  emit(id, e, { type: 'push', item })
}

function info(id: string, e: Entry, text: string): void {
  pushItem(id, e, { id: randomUUID(), role: 'info', text, ts: Date.now() })
}

function setBusy(id: string, e: Entry, busy: boolean): void {
  if (e.busy === busy) return
  e.busy = busy
  emit(id, e, { type: 'busy', busy })
  busySink(id, busy)
}

function emitPending(id: string, e: Entry): void {
  emit(id, e, { type: 'pending', pending: e.queue[0]?.pending ?? null })
}

// ---------------------------------------------------------------- persistence

function chatFile(id: string): string | null {
  return storageDir ? join(storageDir, `${id}.json`) : null
}

function load(id: string, e: Entry): void {
  const f = chatFile(id)
  if (!f || !existsSync(f)) return
  try {
    const d = JSON.parse(readFileSync(f, 'utf8')) as { items?: ChatItem[] }
    e.items = Array.isArray(d.items) ? d.items.map((it) => (it.role === 'tool' && !it.done ? { ...it, done: true, isError: true } : it)) : []
  } catch {
    e.items = []
  }
}

function scheduleSave(id: string, e: Entry): void {
  if (!storageDir) return
  if (e.saveTimer) clearTimeout(e.saveTimer)
  e.saveTimer = setTimeout(() => saveNow(id, e), 400)
}

function saveNow(id: string, e: Entry): void {
  const f = chatFile(id)
  if (!f) return
  if (e.saveTimer) {
    clearTimeout(e.saveTimer)
    e.saveTimer = undefined
  }
  try {
    writeFileSync(f, JSON.stringify({ items: e.items }))
  } catch (err) {
    console.error('chat save failed', err)
  }
}

export function deleteChatHistory(id: string): void {
  const f = chatFile(id)
  if (f && existsSync(f)) unlinkSync(f)
  killChat(id)
  entries.delete(id)
}

// ---------------------------------------------------------------- process

export function buildCommand(opts: StartOpts): string {
  const fixed = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio']
  if (opts.resume) fixed.push('--resume', opts.resume)
  if (opts.mcpConfig) fixed.push('--mcp-config', opts.mcpConfig)
  if (opts.systemPrompt) fixed.push('--append-system-prompt', opts.systemPrompt)
  // runtime choices last so they win over anything in the user's extra args
  const tail: string[] = []
  if (opts.model) tail.push('--model', opts.model)
  if (opts.effort) tail.push('--effort', opts.effort)
  const quote = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))
  return ['exec', fixed.map(quote).join(' '), opts.args?.trim() ?? '', tail.map(quote).join(' ')].filter(Boolean).join(' ')
}

function writeLine(e: Entry, obj: unknown): void {
  e.proc?.stdin?.write(JSON.stringify(obj) + '\n')
}

export function startChat(id: string, opts: StartOpts): void {
  const e = ensure(id)
  if (e.proc) return
  e.opts = opts
  const env = buildEnv(opts.env ?? {})
  const shell = env.SHELL || '/bin/bash'
  const command = buildCommand(opts)
  console.log(`[chat ${id}] ${command}`)
  const proc = spawn(shell, ['-ilc', command], { cwd: opts.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  e.proc = proc
  e.stdoutBuf = ''
  proc.stdout?.on('data', (d: Buffer) => {
    e.stdoutBuf += d.toString()
    let i: number
    while ((i = e.stdoutBuf.indexOf('\n')) >= 0) {
      const line = e.stdoutBuf.slice(0, i)
      e.stdoutBuf = e.stdoutBuf.slice(i + 1)
      if (line.trim()) handleLine(id, e, line)
    }
  })
  proc.stderr?.on('data', (d: Buffer) => {
    e.stderrTail = (e.stderrTail + d.toString()).slice(-4000)
  })
  e.initRequestId = randomUUID()
  writeLine(e, { type: 'control_request', request_id: e.initRequestId, request: { subtype: 'initialize' } })
  proc.on('exit', (code) => {
    if (e.proc !== proc) return
    e.proc = undefined
    e.liveId = undefined
    setBusy(id, e, false)
    if (e.queue.length) {
      e.queue = []
      emitPending(id, e)
    }
    if (code && code !== 0) {
      const lines = e.stderrTail.trim().split('\n').filter((l) => l.trim() && !/nvm/i.test(l))
      const tail = [...new Set(lines)].slice(-2).join('\n')
      if (/No conversation found/i.test(e.stderrTail)) {
        // the transcript is not in this config dir: forget the id so the next start is a fresh conversation
        e.sessionId = undefined
        e.opts = { ...opts, resume: undefined }
        sessionIdSink(id, '')
        info(id, e, 'Попередню розмову не знайдено в цій конфігурації Claude — наступне повідомлення почне нову.')
      } else {
        info(id, e, `Claude завершився з кодом ${code}${tail ? `: ${tail}` : ''}. Наступне повідомлення перезапустить сесію.`)
        if (opts.resume && !e.sessionId) e.opts = { ...opts, resume: undefined }
      }
    }
    saveNow(id, e)
  })
}

export function killChat(id: string): void {
  const e = entries.get(id)
  if (!e?.proc) return
  const p = e.proc
  e.proc = undefined
  try {
    if (p.pid) process.kill(-p.pid, 'SIGTERM')
  } catch {
    try {
      p.kill('SIGTERM')
    } catch {
      /* gone */
    }
  }
  setBusy(id, e, false)
  saveNow(id, e)
}

export function killAllChats(): void {
  for (const id of [...entries.keys()]) killChat(id)
}

export function chatRunning(id: string): boolean {
  return !!entries.get(id)?.proc
}

export function restartChat(id: string, opts: StartOpts): void {
  killChat(id)
  const e = ensure(id)
  startChat(id, { ...opts, resume: opts.resume ?? e.sessionId })
}

// ---------------------------------------------------------------- API used by ipc

function modelState(e: Entry): ChatModelState | undefined {
  if (!e.models) return undefined
  return { models: e.models, model: e.opts?.model ?? e.models.find((m) => m.value === 'default')?.value ?? e.models[0]?.value, effort: e.opts?.effort }
}

export function attachChat(id: string): ChatSnapshot {
  const e = ensure(id)
  return { items: e.items, pending: e.queue[0]?.pending ?? null, busy: e.busy, seq: e.seq, running: !!e.proc, commands: e.commands, modelState: modelState(e) }
}

/** Change the model/effort: persisted via the params sink and applied by restarting the session (resumed). */
export function setChatParams(id: string, params: { model?: string; effort?: string }): { ok: boolean; reason?: string } {
  const e = ensure(id)
  if (e.busy) return { ok: false, reason: 'зачекайте завершення відповіді' }
  if (!e.opts) return { ok: false, reason: 'сесію не запущено' }
  const next = { ...e.opts, ...params }
  if (next.model === e.opts.model && next.effort === e.opts.effort) return { ok: true }
  paramsSink(id, { model: next.model, effort: next.effort })
  info(id, e, `Сесію перезапущено: модель ${next.model ?? 'типова'}, зусилля ${next.effort ?? 'типові'}.`)
  restartChat(id, next)
  return { ok: true }
}

function imageBlock(a: ChatAttachment): unknown | null {
  try {
    const data = readFileSync(a.path).toString('base64')
    return { type: 'image', source: { type: 'base64', media_type: a.mediaType ?? 'image/png', data } }
  } catch {
    return null
  }
}

export function sendChatMessage(id: string, text: string, start?: () => void, attachments: ChatAttachment[] = []): void {
  const e = ensure(id)
  if (!e.proc) start?.()
  if (!e.proc) {
    info(id, e, 'Сесію Claude не запущено.')
    return
  }
  const blocks: unknown[] = []
  const sent: ChatAttachment[] = []
  for (const a of attachments) {
    if (a.kind === 'image') {
      const b = imageBlock(a)
      if (b) {
        blocks.push(b)
        sent.push(a)
      } else info(id, e, `Зображення «${a.name}» не прочиталось — пропущено.`)
    } else if (existsSync(a.path)) sent.push(a)
    else info(id, e, `Файл «${a.name}» не знайдено — пропущено.`)
  }
  const refs = sent.filter((a) => a.kind === 'file').map((a) => `Файл: ${a.path}`)
  const built = [text.trim(), ...refs].filter(Boolean).join('\n')
  if (!built && !blocks.length) return
  pushItem(id, e, { id: randomUUID(), role: 'user', text, ...(sent.length ? { attachments: sent } : {}), ts: Date.now() })
  setBusy(id, e, true)
  e.turnHadText = false
  writeLine(e, { type: 'user', message: { role: 'user', content: [...blocks, { type: 'text', text: built || '(див. зображення)' }] } })
}

export function answerChat(id: string, answer: ChatAnswer): void {
  const e = entries.get(id)
  if (!e) return
  const idx = e.queue.findIndex((p) => p.pending.requestId === answer.requestId)
  if (idx === -1) return
  const [{ pending, rawInput }] = e.queue.splice(idx, 1)
  if (answer.kind === 'question' && pending.kind === 'question') {
    const input = (rawInput ?? {}) as { questions?: ChatQuestion[] }
    respond(e, answer.requestId, { behavior: 'allow', updatedInput: { questions: input.questions ?? [], answers: answer.answers } })
    const summary = pending.questions.map((q) => `${q.header || q.question}: ${answer.answers[q.question] ?? '—'}`).join('\n')
    pushItem(id, e, { id: randomUUID(), role: 'user', text: summary, answer: true, ts: Date.now() })
  } else if (answer.kind === 'permission' && pending.kind === 'permission') {
    if (answer.allow) {
      respond(e, answer.requestId, { behavior: 'allow', updatedInput: rawInput })
      info(id, e, `Дозволено: ${pending.toolName}`)
    } else {
      respond(e, answer.requestId, { behavior: 'deny', message: answer.message?.trim() || 'Користувач відхилив цю дію.' })
      info(id, e, `Відхилено: ${pending.toolName}`)
    }
  }
  emitPending(id, e)
}

function respond(e: Entry, requestId: string, response: unknown): void {
  writeLine(e, { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
}

export function interruptChat(id: string): void {
  const e = entries.get(id)
  if (!e?.proc) return
  writeLine(e, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
}

export function clearChat(id: string): void {
  const e = ensure(id)
  e.items = []
  emit(id, e, { type: 'clear' })
  saveNow(id, e)
}

// ---------------------------------------------------------------- NDJSON parsing

interface ContentBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

export function handleLine(id: string, e: Entry, line: string): void {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init' && typeof msg.session_id === 'string') {
        if (e.sessionId && msg.session_id !== e.sessionId) {
          e.items = []
          emit(id, e, { type: 'clear' })
          info(id, e, 'Розпочато нову розмову — контекст очищено.')
        }
        e.sessionId = msg.session_id
        sessionIdSink(id, msg.session_id)
      }
      break
    case 'stream_event': {
      if (msg.parent_tool_use_id) break // subagent text: not shown
      const ev = (msg.event ?? {}) as Record<string, unknown>
      setBusy(id, e, true)
      if (ev.type === 'content_block_start') {
        const block = (ev.content_block ?? {}) as ContentBlock
        if (block.type !== 'text') break
        if (e.liveId) {
          appendLive(id, e, '\n\n')
          break
        }
        const item: ChatItem = { id: randomUUID(), role: 'assistant', text: '', ts: Date.now() }
        e.liveId = item.id
        pushItem(id, e, item)
      } else if (ev.type === 'content_block_delta') {
        const delta = (ev.delta ?? {}) as { type?: string; text?: string }
        if (delta.type === 'text_delta' && delta.text && e.liveId) appendLive(id, e, delta.text)
      }
      break
    }
    case 'assistant':
      handleAssistant(id, e, msg)
      break
    case 'user':
      handleToolResults(id, e, msg)
      break
    case 'control_request':
      handleControlRequest(id, e, msg)
      break
    case 'control_cancel_request': {
      const rid = String(msg.request_id ?? '')
      const i = e.queue.findIndex((p) => p.pending.requestId === rid)
      if (i !== -1) {
        e.queue.splice(i, 1)
        emitPending(id, e)
      }
      break
    }
    case 'control_response': {
      const resp = (msg.response ?? {}) as { subtype?: string; error?: string; request_id?: string; response?: Record<string, unknown> }
      if (resp.request_id && resp.request_id === e.initRequestId) {
        e.initRequestId = undefined
        if (resp.subtype === 'success') handleInitialize(id, e, resp.response ?? {})
      } else if (resp.subtype === 'error' && resp.error) info(id, e, `Помилка: ${resp.error}`)
      break
    }
    case 'result': {
      e.liveId = undefined
      if (msg.is_error && typeof msg.result === 'string' && msg.result) info(id, e, msg.result)
      else if (!e.turnHadText && typeof msg.result === 'string' && msg.result.trim())
        pushItem(id, e, { id: randomUUID(), role: 'assistant', text: msg.result, ts: Date.now() })
      setBusy(id, e, false)
      saveNow(id, e)
      break
    }
    default:
      break
  }
}

function handleInitialize(id: string, e: Entry, r: Record<string, unknown>): void {
  if (Array.isArray(r.models)) {
    e.models = (r.models as Record<string, unknown>[]).filter((m) => typeof m.value === 'string').map((m) => ({
      value: m.value as string,
      displayName: typeof m.displayName === 'string' ? m.displayName : (m.value as string),
      description: typeof m.description === 'string' ? m.description : undefined,
      supportsEffort: !!m.supportsEffort,
      supportedEffortLevels: Array.isArray(m.supportedEffortLevels) ? (m.supportedEffortLevels as string[]) : undefined
    }))
  }
  if (Array.isArray(r.commands)) {
    const seen = new Set<string>()
    e.commands = (r.commands as Record<string, unknown>[])
      .filter((c) => typeof c.name === 'string' && c.name)
      .map((c) => ({ name: c.name as string, description: typeof c.description === 'string' ? c.description : undefined, argumentHint: typeof c.argumentHint === 'string' ? c.argumentHint : undefined }))
      .filter((c) => {
        const k = `${c.name}${c.description ?? ''}${c.argumentHint ?? ''}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
  }
  emit(id, e, { type: 'meta', commands: e.commands, modelState: modelState(e) })
}

function appendLive(id: string, e: Entry, text: string): void {
  const item = e.items.find((it) => it.id === e.liveId)
  if (!item) return
  item.text += text
  e.turnHadText = true
  emit(id, e, { type: 'append', itemId: item.id, text })
}

function handleAssistant(id: string, e: Entry, msg: Record<string, unknown>): void {
  if (msg.parent_tool_use_id) return
  setBusy(id, e, true)
  const message = (msg.message ?? {}) as { content?: ContentBlock[] }
  const blocks = Array.isArray(message.content) ? message.content : []
  const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n\n')
  if (text) {
    const live = e.liveId ? e.items.find((it) => it.id === e.liveId) : undefined
    if (live) {
      live.text = text
      emit(id, e, { type: 'update', item: live })
    } else {
      pushItem(id, e, { id: randomUUID(), role: 'assistant', text, ts: Date.now() })
    }
    e.liveId = undefined
    e.turnHadText = true
  }
  for (const b of blocks) {
    if (b.type !== 'tool_use' || !b.id || b.name === 'AskUserQuestion') continue
    pushItem(id, e, { id: b.id, role: 'tool', toolName: b.name ?? 'tool', text: summarizeToolUse(b.name ?? '', b.input), ts: Date.now() })
  }
}

function handleToolResults(id: string, e: Entry, msg: Record<string, unknown>): void {
  const message = (msg.message ?? {}) as { content?: ContentBlock[] }
  const blocks = Array.isArray(message.content) ? message.content : []
  for (const b of blocks) {
    if (b.type !== 'tool_result' || !b.tool_use_id) continue
    const item = e.items.find((it) => it.id === b.tool_use_id)
    if (!item) continue
    item.done = true
    item.isError = !!b.is_error
    item.endTs = Date.now()
    item.output = contentText(b.content).slice(0, 20000)
    emit(id, e, { type: 'update', item })
  }
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' && typeof (x as { text?: string }).text === 'string' ? (x as { text: string }).text : '')).join('\n')
  return ''
}

function handleControlRequest(id: string, e: Entry, msg: Record<string, unknown>): void {
  const requestId = String(msg.request_id ?? '')
  const req = (msg.request ?? {}) as { subtype?: string; tool_name?: string; display_name?: string; input?: unknown }
  if (req.subtype !== 'can_use_tool') {
    respond(e, requestId, {})
    return
  }
  let pending: ChatPending
  if (req.tool_name === 'AskUserQuestion') {
    const input = (req.input ?? {}) as { questions?: ChatQuestion[] }
    pending = { kind: 'question', requestId, questions: input.questions ?? [] }
  } else {
    pending = { kind: 'permission', requestId, toolName: req.display_name || req.tool_name || 'tool', summary: summarizeToolUse(req.tool_name ?? '', req.input) }
  }
  e.queue.push({ pending, rawInput: req.input })
  if (e.queue.length === 1) emitPending(id, e)
}

/** Compact one-line label for a tool call. */
export function summarizeToolUse(name: string, input: unknown, max = 300): string {
  const inp = (input ?? {}) as Record<string, unknown>
  let s: string
  if (name === 'Bash' && typeof inp.command === 'string') s = inp.command
  else if ((name === 'Read' || name === 'Edit' || name === 'Write') && typeof inp.file_path === 'string') s = inp.file_path
  else if (name.startsWith('mcp__')) {
    const short = name.split('__').slice(2).join('.')
    const args = Object.entries(inp).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
    s = `${short}(${args})`
  } else s = JSON.stringify(inp)
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/** Test hook: create/inspect an entry without a process. */
export function _entryForTest(id: string): Entry {
  return ensure(id)
}
