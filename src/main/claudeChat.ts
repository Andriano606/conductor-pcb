/**
 * One headless `claude` process per project, speaking NDJSON over stdio
 * (`-p --input-format stream-json --output-format stream-json`). The transcript is a
 * structured ChatItem[] mirrored to the renderer through sequenced events; permission
 * requests and AskUserQuestion arrive as control_request/can_use_tool and become ChatPending.
 * Slimmed down from conductor-linux's claudeChat.ts (no subagent transcripts / local commands), but
 * with its multi-agent workflow tracking: the Workflow tool (which Claude reaches for in ultracode)
 * is one background task whose plan and per-agent progress are folded onto the tool's ChatItem.
 */
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ChatAnswer, ChatAttachment, ChatCommand, ChatEvent, ChatItem, ChatModelOption, ChatModelState, ChatPending, ChatQuestion, ChatSnapshot, WorkflowAgent, WorkflowAgentState, WorkflowPhase, WorkflowRun, WorkflowStatus } from '../shared/types'
import { buildEnv } from './env'

export interface StartOpts {
  cwd: string
  resume?: string
  mcpConfig?: string
  systemPrompt?: string
  args?: string
  model?: string
  effort?: string
  /**
   * Ultracode (xhigh effort + standing multi-agent orchestration). The CLI keeps it in its
   * session-scoped flag layer, so it is re-applied with an apply_flag_settings control request
   * after every handshake — not as a CLI flag (see enforceUltracode).
   */
  ultracode?: boolean
  /** Extra environment (CLAUDE_CONFIG_DIR of a merged profile dir, profile env vars). */
  env?: NodeJS.ProcessEnv
  /** Human label of the Claude config profile(s) in use, for the start notice. */
  profileLabel?: string
}

interface Entry {
  proc?: ChildProcess
  items: ChatItem[]
  seq: number
  busy: boolean
  queue: { pending: ChatPending; rawInput: unknown }[]
  /**
   * The assistant item currently receiving streamed text, per agent: '' is the main agent, a
   * subagent's key is its parent_tool_use_id — so parallel subagents stream into their own items.
   */
  liveIds: Record<string, string | undefined>
  /** Spawned subagents: Agent/Task tool_use id → human label, for the badge/colour in the transcript. */
  subagents: Record<string, string>
  /**
   * The main agent's turn is in flight — including the one the CLI starts on its own to consume a
   * finished background task's notification. Together with `bgTasks` this is what busy is derived
   * from (see refreshBusy).
   */
  turnActive?: boolean
  /**
   * Live background tasks that are *Claude's own work* (subagents, workflows — see AGENT_TASK_TYPES),
   * from the CLI's `background_tasks_changed` snapshots. A backgrounded shell job is deliberately
   * NOT here: it runs beside the conversation without Claude waiting on it.
   */
  bgTasks: Set<string>
  /** task id → whether that background task counts as Claude working (judged from its task_type). */
  taskKinds: Map<string, TaskKind>
  /** Safety net for a turn we *expect* the CLI to start (after a task finished) but that never comes. */
  taskTurnTimer?: ReturnType<typeof setTimeout>
  stdoutBuf: string
  stderrTail: string
  sessionId?: string
  opts?: StartOpts
  saveTimer?: NodeJS.Timeout
  turnHadText: boolean
  initRequestId?: string
  commands?: ChatCommand[]
  models?: ChatModelOption[]
  /** Set after the first spawn; later (re)starts push a start notice into the transcript. */
  everSpawned?: boolean
  /**
   * In-flight apply_flag_settings requests for ultracode: request id → the value we asked for.
   * The CLI refuses ultracode when dynamic workflows are off or the model/org disallows xhigh,
   * so a rejection has to roll our state back instead of leaving the selector claiming a level
   * that never took effect.
   */
  ultracodeReqs: Map<string, boolean>
  /**
   * tool_use ids of background tasks (workflows) still running. The CLI answers such a call with a
   * tool_result immediately ("launched"), so these ids are held back from being flipped done until
   * their task_notification.
   */
  runningTasks: Set<string>
  /** Live workflow runs: the CLI's background-task id → the id of the Workflow tool item carrying the run. */
  workflowItems: Map<string, string>
}

/** Persisted patch of the runtime knobs chosen in the composer (model / effort / ultracode). */
export interface ChatParamsPatch {
  model?: string
  effort?: string
  ultracode?: boolean
}

/**
 * Ultracode is not a mode beside the effort levels — the CLI treats it as one *of* them
 * (`/effort [low|…|max|ultracode]`, "Current effort level: ultracode") and picking any ordinary
 * level turns it off. So it is the last option of the effort selector here too, and the two can
 * never both look on. Being last does NOT make it the strongest effort: the CLI runs ultracode at
 * **xhigh**, so `max` is a higher raw level — what ultracode adds on top is the standing
 * multi-agent orchestration (Claude reaches for the Workflow tool on every substantive task).
 */
export const ULTRACODE = 'ultracode'

const MAX_ITEMS = 2000
const entries = new Map<string, Entry>()
let storageDir: string | null = null
let emitSink: (id: string, seq: number, ev: ChatEvent) => void = () => {}
let sessionIdSink: (id: string, sessionId: string) => void = () => {}
let busySink: (id: string, busy: boolean) => void = () => {}
let paramsSink: (id: string, params: ChatParamsPatch) => void = () => {}
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
    e = { items: [], seq: 0, busy: false, queue: [], stdoutBuf: '', stderrTail: '', turnHadText: false, ultracodeReqs: new Map(), runningTasks: new Set(), workflowItems: new Map(), liveIds: {}, subagents: {}, bgTasks: new Set(), taskKinds: new Map() }
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

/**
 * `task_type`s the CLI reports for background tasks that *are* Claude thinking: a spawned subagent,
 * a teammate, a workflow, an agentic MCP task. Everything else it tracks as a background task —
 * above all `local_bash` (a command launched with `run_in_background`) and the `monitor_*` watchers
 * — runs alongside the conversation without Claude waiting on it, so it must not keep the chat
 * "typing". A task with no `task_type` at all (older CLI) counts as agent work.
 */
const AGENT_TASK_TYPES = new Set(['local_agent', 'remote_agent', 'in_process_teammate', 'local_workflow', 'mcp_task'])
type TaskKind = 'agent' | 'other'
function taskKind(taskType: unknown): TaskKind {
  if (typeof taskType !== 'string' || !taskType) return 'agent'
  return AGENT_TASK_TYPES.has(taskType) ? 'agent' : 'other'
}

/**
 * Claude is busy while the main agent's turn is in flight OR any subagent is still running in the
 * background. Subagents are background tasks: the Agent tool_use is answered at once ("started")
 * and the main turn can finish (`result`) long before they do — the CLI then starts a fresh turn
 * on its own once each task reports back. Deriving busy from both keeps the typing indicator and
 * the sidebar dot honest instead of stopping on the main agent's early exit.
 */
function refreshBusy(id: string, e: Entry): void {
  setBusy(id, e, !!e.turnActive || e.bgTasks.size > 0)
}

/**
 * The main agent is (about to be) producing output. `watchdog` marks a turn we only *expect* — the
 * CLI itself starts one to consume a finished task's notification; if it never does, the timer
 * releases busy instead of wedging it.
 */
const TASK_TURN_GRACE_MS = 30_000
function markTurnActive(id: string, e: Entry, watchdog = false): void {
  // Only guard a turn that is still merely expected: a turn already producing output always ends
  // with a `result`, and arming the timer against it would drop busy mid-way through a quiet tool call.
  const arm = watchdog && (!e.turnActive || !!e.taskTurnTimer)
  e.turnActive = true
  clearTaskTurnTimer(e)
  if (arm) {
    e.taskTurnTimer = setTimeout(() => {
      e.taskTurnTimer = undefined
      e.turnActive = false
      refreshBusy(id, e)
    }, TASK_TURN_GRACE_MS)
  }
  refreshBusy(id, e)
}

function clearTaskTurnTimer(e: Entry): void {
  if (e.taskTurnTimer) clearTimeout(e.taskTurnTimer)
  e.taskTurnTimer = undefined
}

/** Forget all turn/background-task state (session (re)spawn, exit, new conversation). */
function resetTurnState(e: Entry): void {
  clearTaskTurnTimer(e)
  e.turnActive = false
  e.bgTasks.clear()
  e.taskKinds.clear()
  e.runningTasks.clear()
  e.workflowItems.clear()
  e.liveIds = {}
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
    e.items = Array.isArray(d.items)
      ? d.items.map((it) => {
          if (it.role !== 'tool' || it.done) return it
          // A workflow killed with the app can never report again — freeze the run so the panel
          // doesn't show agents spinning forever.
          if (it.workflow?.status === 'running') finishWorkflowRun(it.workflow, 'killed')
          return { ...it, done: true, isError: true }
        })
      : []
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

/** MCP server names from the --mcp-config file, for the start notice. */
function mcpServerNames(mcpConfig?: string): string[] {
  if (!mcpConfig) return []
  try {
    const parsed = JSON.parse(readFileSync(mcpConfig, 'utf8')) as { mcpServers?: Record<string, unknown> }
    return Object.keys(parsed.mcpServers ?? {})
  } catch {
    return []
  }
}

export const START_NOTICE_PREFIX = '🔄 Сесію запущено · '

/**
 * A human-readable one-liner describing exactly how the session is (re)started — every
 * parameter that shapes the `claude` process (same format as conductor-linux; the renderer
 * splits it back into one option per line). Pushed into the transcript on every spawn
 * except the very first of a brand-new empty session.
 */
export function describeStart(opts: StartOpts): string {
  const mcp = mcpServerNames(opts.mcpConfig)
  const args = opts.args?.trim() ?? ''
  const mode = /--permission-mode[= ]+([\w-]+)/.exec(args)?.[1] ?? 'default'
  const parts = [
    `модель: ${opts.model ?? 'default'}`,
    // Ultracode replaces the level rather than sitting beside it, so naming `opts.effort` here
    // would report a level the session is not actually running.
    `зусилля: ${opts.ultracode ? 'ultracode (xhigh + воркфлови)' : (opts.effort ?? 'default')}`,
    `режим: ${mode}`,
    `resume: ${opts.resume ? `так (${opts.resume.slice(0, 8)}…)` : 'ні — нова розмова'}`,
    `MCP: ${mcp.length ? `${mcp.length} (${mcp.join(', ')})` : 'немає'}`,
    `профіль: ${opts.profileLabel ?? (opts.env?.CLAUDE_CONFIG_DIR ? opts.env.CLAUDE_CONFIG_DIR : 'стандартний ~/.claude')}`,
    `args: ${args || 'немає'}`
  ]
  return `${START_NOTICE_PREFIX}${parts.join(' · ')}`
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
  if (opts.resume || e.everSpawned) info(id, e, describeStart(opts))
  e.everSpawned = true
  console.log(`[chat ${id}] ${command}`)
  const proc = spawn(shell, ['-ilc', command], { cwd: opts.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  e.proc = proc
  e.stdoutBuf = ''
  e.ultracodeReqs.clear()
  resetTurnState(e)
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
    closeRunningTasks(id, e, 'killed')
    resetTurnState(e)
    refreshBusy(id, e)
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
  closeRunningTasks(id, e, 'killed')
  resetTurnState(e)
  try {
    if (p.pid) process.kill(-p.pid, 'SIGTERM')
  } catch {
    try {
      p.kill('SIGTERM')
    } catch {
      /* gone */
    }
  }
  refreshBusy(id, e)
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

/** The model's effort levels plus ultracode as the last one (see ULTRACODE). */
function withUltracode(m: ChatModelOption): ChatModelOption {
  if (!m.supportsEffort || !m.supportedEffortLevels?.length) return m
  return { ...m, supportedEffortLevels: [...m.supportedEffortLevels.filter((l) => l !== ULTRACODE), ULTRACODE] }
}

function modelState(e: Entry): ChatModelState | undefined {
  if (!e.models) return undefined
  const ultracode = e.opts?.ultracode === true
  return {
    models: e.models.map(withUltracode),
    model: e.opts?.model ?? e.models.find((m) => m.value === 'default')?.value ?? e.models[0]?.value,
    // Ultracode replaces the level rather than sitting beside it, so it *is* the current effort while on.
    effort: ultracode ? ULTRACODE : e.opts?.effort,
    ultracode
  }
}

export function attachChat(id: string): ChatSnapshot {
  const e = ensure(id)
  return { items: e.items, pending: e.queue[0]?.pending ?? null, busy: e.busy, seq: e.seq, running: !!e.proc, commands: e.commands, modelState: modelState(e) }
}

/**
 * Change the model/effort: persisted via the params sink and applied by restarting the session
 * (resumed). `effort: 'ultracode'` is a level like any other from the user's side but a different
 * mechanism underneath: a live apply_flag_settings flag (no restart) instead of a `--effort`
 * respawn. Switching *away* from ultracode therefore does both — turns the flag off live, then
 * restarts only if the stored level itself also changed.
 */
export function setChatParams(id: string, params: { model?: string; effort?: string }): { ok: boolean; reason?: string } {
  const e = ensure(id)
  if (e.busy) return { ok: false, reason: 'зачекайте завершення відповіді' }
  if (!e.opts) return { ok: false, reason: 'сесію не запущено' }
  if (params.effort === ULTRACODE) {
    if (params.model !== undefined && params.model !== e.opts.model) return { ok: false, reason: 'модель і ultracode змінюються окремо' }
    if (e.opts.ultracode !== true) {
      setUltracode(id, e, true)
      info(id, e, '⚡ Ультракод увімкнено — зусилля xhigh (не max: max вищий, але без воркфловів) + Claude сам запускає мультиагентні воркфлови на кожній суттєвій задачі.')
    }
    return { ok: true }
  }
  if (params.effort !== undefined && e.opts.ultracode === true) {
    setUltracode(id, e, false)
    info(id, e, '✅ Ультракод вимкнено — сесія повертається до звичайного рівня зусиль.')
  }
  const next = { ...e.opts, ...params }
  if (next.model === e.opts.model && next.effort === e.opts.effort) return { ok: true }
  paramsSink(id, { model: next.model, effort: next.effort })
  info(id, e, `Сесію перезапущено: модель ${next.model ?? 'типова'}, зусилля ${next.effort ?? 'типові'}.`)
  restartChat(id, next)
  return { ok: true }
}

/**
 * Turn ultracode on/off for the running session. The CLI exposes it as a session-scoped *flag
 * setting* (not a CLI flag): apply_flag_settings merges it into the active configuration live —
 * effort jumps to xhigh and Claude is told to reach for the Workflow tool on every substantive
 * task. Persisted so the choice survives a restart (see enforceUltracode).
 */
function setUltracode(id: string, e: Entry, on: boolean): void {
  if (!e.opts) return
  e.opts = { ...e.opts, ultracode: on }
  paramsSink(id, { ultracode: on })
  if (e.proc) requestUltracode(e, on)
  emit(id, e, { type: 'meta', commands: e.commands, modelState: modelState(e) })
}

/**
 * Ask the CLI to apply ultracode, remembering the request so its answer can be matched: the CLI
 * rejects it when dynamic workflows are off or the model/org doesn't allow xhigh effort, and that
 * rejection has to undo our optimistic state (see handleUltracodeResponse).
 */
function requestUltracode(e: Entry, on: boolean): void {
  const requestId = randomUUID()
  e.ultracodeReqs.set(requestId, on)
  writeLine(e, { type: 'control_request', request_id: requestId, request: { subtype: 'apply_flag_settings', settings: { ultracode: on } } })
}

/**
 * The CLI's answer to one of our ultracode requests. On a rejection the mode was never applied,
 * so roll our state back (and persist the rollback) instead of showing a selector that lies.
 * Returns true when the response was ours to handle.
 */
function handleUltracodeResponse(id: string, e: Entry, requestId: string, error?: string): boolean {
  const asked = e.ultracodeReqs.get(requestId)
  if (asked === undefined) return false
  e.ultracodeReqs.delete(requestId)
  if (!error) return true
  // Only roll back if nothing else has changed the mode since we asked.
  if (e.opts && e.opts.ultracode === asked) {
    e.opts = { ...e.opts, ultracode: !asked }
    paramsSink(id, { ultracode: !asked })
    emit(id, e, { type: 'meta', commands: e.commands, modelState: modelState(e) })
  }
  info(id, e, `Ультракод недоступний у цій сесії: ${error}`)
  return true
}

/**
 * Re-assert ultracode after the handshake. The CLI's flag layer lives only for the life of the
 * process, so a persisted choice would silently vanish on every restart/resume without this.
 */
function enforceUltracode(e: Entry): void {
  if (e.proc && e.opts?.ultracode !== undefined) requestUltracode(e, e.opts.ultracode)
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
  markTurnActive(id, e)
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
  // An interrupt takes the running background subagents down with the turn, and a killed task
  // never sends its notification — so drop them here, otherwise busy (derived from them) would
  // never fall back to idle.
  closeRunningTasks(id, e, 'killed')
  clearTaskTurnTimer(e)
  e.bgTasks.clear()
  e.taskKinds.clear()
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
          e.subagents = {}
          resetTurnState(e)
          refreshBusy(id, e)
          emit(id, e, { type: 'clear' })
          info(id, e, 'Розпочато нову розмову — контекст очищено.')
        }
        e.sessionId = msg.session_id
        sessionIdSink(id, msg.session_id)
      } else if (msg.subtype === 'background_tasks_changed') handleBackgroundTasks(id, e, msg)
      else if (msg.subtype === 'task_started') handleTaskStarted(id, e, msg)
      else if (msg.subtype === 'task_progress') handleTaskProgress(id, e, msg)
      else if (msg.subtype === 'task_updated') handleTaskUpdated(id, e, msg)
      else if (msg.subtype === 'task_notification') handleTaskDone(id, e, msg)
      break
    case 'stream_event':
      handleStreamEvent(id, e, (msg.event ?? {}) as Record<string, unknown>, parentId(msg))
      break
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
      } else if (resp.request_id && handleUltracodeResponse(id, e, resp.request_id, resp.subtype === 'error' && resp.error ? resp.error : undefined)) {
        // an ultracode apply — a refusal rolls the level back with its own notice
      } else if (resp.subtype === 'error' && resp.error) info(id, e, `Помилка: ${resp.error}`)
      break
    }
    case 'result': {
      e.liveIds = {}
      e.turnActive = false
      clearTaskTurnTimer(e)
      if (msg.is_error && typeof msg.result === 'string' && msg.result) info(id, e, msg.result)
      else if (!e.turnHadText && typeof msg.result === 'string' && msg.result.trim())
        pushItem(id, e, { id: randomUUID(), role: 'assistant', text: msg.result, ts: Date.now() })
      // Subagents/workflows outlive the turn that spawned them (they are background tasks), so this
      // `result` is only the *main* agent stepping back: stay busy until the last of them reports
      // back and its follow-up turn ends (refreshBusy reads bgTasks).
      refreshBusy(id, e)
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
  // Ultracode lives in the CLI's session-scoped flag layer, which a (re)spawn starts empty.
  enforceUltracode(e)
}

/** The subagent a message belongs to (its Agent tool_use id), or undefined for the main agent. */
function parentId(msg: Record<string, unknown>): string | undefined {
  const p = msg.parent_tool_use_id
  return typeof p === 'string' && p ? p : undefined
}

/** Partial text deltas: stream assistant text into a live item as it arrives (per agent). */
function handleStreamEvent(id: string, e: Entry, ev: Record<string, unknown>, agentId?: string): void {
  const key = agentId ?? ''
  // Subagent output never says anything about the main agent, so it must not resurrect the turn.
  if (!agentId) markTurnActive(id, e)
  if (ev.type === 'content_block_start') {
    const block = (ev.content_block ?? {}) as ContentBlock
    if (block.type !== 'text') return
    if (e.liveIds[key]) {
      appendLive(id, e, '\n\n', agentId)
      return
    }
    const item: ChatItem = { id: randomUUID(), role: 'assistant', text: '', ts: Date.now(), agentId, agentLabel: agentId ? e.subagents[agentId] : undefined }
    e.liveIds[key] = item.id
    pushItem(id, e, item)
  } else if (ev.type === 'content_block_delta') {
    const delta = (ev.delta ?? {}) as { type?: string; text?: string }
    if (delta.type === 'text_delta' && delta.text && e.liveIds[key]) appendLive(id, e, delta.text, agentId)
  }
}

function appendLive(id: string, e: Entry, text: string, agentId?: string): void {
  const liveId = e.liveIds[agentId ?? '']
  const item = liveId ? e.items.find((it) => it.id === liveId) : undefined
  if (!item) return
  item.text += text
  if (!agentId) e.turnHadText = true
  emit(id, e, { type: 'append', itemId: item.id, text })
  scheduleSave(id, e)
}

/**
 * A complete assistant message: the joined text is authoritative, so the live item is finalized
 * with it; tool calls become running tool items. The message's parent_tool_use_id tags every item
 * with its subagent (badge + colour in the transcript).
 */
function handleAssistant(id: string, e: Entry, msg: Record<string, unknown>): void {
  const agentId = parentId(msg)
  // Main-agent output means the turn is live — including the one the CLI starts by itself after a
  // background subagent reports back (there is no user message to flip busy on there).
  if (!agentId) markTurnActive(id, e)
  const key = agentId ?? ''
  const agentLabel = agentId ? e.subagents[agentId] : undefined
  const message = (msg.message ?? {}) as { content?: ContentBlock[] }
  const blocks = Array.isArray(message.content) ? message.content : []
  const text = blocks.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n\n')
  if (text) {
    const liveId = e.liveIds[key]
    const live = liveId ? e.items.find((it) => it.id === liveId) : undefined
    if (live) {
      live.text = text
      emit(id, e, { type: 'update', item: live })
    } else {
      pushItem(id, e, { id: randomUUID(), role: 'assistant', text, ts: Date.now(), agentId, agentLabel })
    }
    e.liveIds[key] = undefined
    if (!agentId) e.turnHadText = true
  }
  for (const b of blocks) {
    if (b.type !== 'tool_use' || !b.id || b.name === 'AskUserQuestion') continue
    // An Agent/Task call spawns a subagent — remember its label so its later (parented) messages
    // can be badged in the transcript.
    if (b.name === 'Task' || b.name === 'Agent') {
      const inp = (b.input ?? {}) as { description?: string; subagent_type?: string }
      e.subagents[b.id] = inp.description || inp.subagent_type || 'субагент'
    }
    const bg = b.name === 'Bash' && !!(b.input as { run_in_background?: unknown })?.run_in_background
    pushItem(id, e, { id: b.id, role: 'tool', toolName: b.name ?? 'tool', text: summarizeToolUse(b.name ?? '', b.input), ts: Date.now(), agentId, agentLabel, background: bg || undefined })
  }
}

function handleToolResults(id: string, e: Entry, msg: Record<string, unknown>): void {
  const message = (msg.message ?? {}) as { content?: ContentBlock[] }
  const blocks = Array.isArray(message.content) ? message.content : []
  for (const b of blocks) {
    if (b.type !== 'tool_result' || !b.tool_use_id) continue
    // A workflow's call is answered the moment it is launched, not when it is done — leave its
    // row running; the real result lands in handleTaskDone.
    if (e.runningTasks.has(b.tool_use_id)) continue
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
  else if ((name === 'Agent' || name === 'Task') && (typeof inp.description === 'string' || typeof inp.prompt === 'string')) s = (inp.description as string) || (inp.prompt as string)
  else if (name === 'Workflow') {
    // Ultracode launches multi-agent workflows: name the run from the script's meta, not its source.
    const meta = workflowMeta(typeof inp.script === 'string' ? inp.script : '')
    s = [(typeof inp.name === 'string' && inp.name) || meta.name, meta.description].filter(Boolean).join(' — ') || 'воркфлов'
  }
  else if (name.startsWith('mcp__')) {
    const short = name.split('__').slice(2).join('.')
    const args = Object.entries(inp).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
    s = `${short}(${args})`
  } else s = JSON.stringify(inp)
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

/**
 * Pull `name` / `description` out of a workflow script's `export const meta = {…}` literal. The
 * Workflow tool requires that block to be a pure literal at the top of the script, so a plain scan
 * of the first lines is enough. Authoritative values arrive later on the task_started event.
 */
function workflowMeta(script: string): { name?: string; description?: string } {
  if (!script) return {}
  const head = script.slice(0, 2000)
  const grab = (key: string): string | undefined => head.match(new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^'"\`]*)\\1`))?.[2] || undefined
  return { name: grab('name'), description: grab('description') }
}

// ---------------------------------------------------------------- multi-agent workflows
//
// The Workflow tool launches ONE background task that runs a script spawning many subagents. The
// CLI answers the tool call immediately ("Workflow launched in background") and then streams the
// run's state on system/task_progress: `workflow_progress` is a full snapshot of the plan
// (workflow_phase rows) and every agent (workflow_agent rows), re-sent whenever something changes —
// an event may omit it entirely (a heartbeat), in which case the last known snapshot stands.
// `task_updated` flips the status, `task_notification` closes the run with its summary.

/** Truncation cap for the prompt/result previews kept per agent (they are persisted). */
const WF_PREVIEW = 600

/**
 * The CLI's authoritative snapshot of the background tasks still running. Only the agent ones feed
 * busy (see AGENT_TASK_TYPES); the rest are remembered by kind alone so their notification can be
 * told apart later. An agent task dropping out of the list means it just finished — the CLI will
 * start a turn of its own to consume its notification, so keep the session busy across that gap.
 */
function handleBackgroundTasks(id: string, e: Entry, msg: Record<string, unknown>): void {
  const tasks = Array.isArray(msg.tasks) ? (msg.tasks as { task_id?: unknown; task_type?: unknown }[]) : []
  const next = new Set<string>()
  for (const t of tasks) {
    const taskId = typeof t?.task_id === 'string' ? t.task_id : ''
    if (!taskId) continue
    const kind = taskKind(t?.task_type)
    e.taskKinds.set(taskId, kind)
    if (kind === 'agent') next.add(taskId)
  }
  const finished = [...e.bgTasks].some((t) => !next.has(t))
  e.bgTasks = next
  if (finished && !e.turnActive) markTurnActive(id, e, true)
  else refreshBusy(id, e)
}

/**
 * A background task was launched (a subagent, a backgrounded shell job, a workflow). Its tool call
 * is answered with a tool_result right away, so hold the row open until the task itself reports
 * back in handleTaskDone.
 */
function handleTaskStarted(id: string, e: Entry, msg: Record<string, unknown>): void {
  const toolUseId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : ''
  if (!toolUseId) return
  const item = e.items.find((it) => it.id === toolUseId)
  if (!item) return
  e.runningTasks.add(toolUseId)
  const label = (typeof msg.description === 'string' && msg.description) || (typeof msg.subagent_type === 'string' && msg.subagent_type) || ''
  if (label && (item.toolName === 'Agent' || item.toolName === 'Task')) e.subagents[toolUseId] = label
  refreshBusy(id, e)
  // Only workflows carry a plan; a plain background task just keeps spinning until its notification.
  if (msg.task_type !== 'local_workflow') return
  const taskId = typeof msg.task_id === 'string' ? msg.task_id : ''
  const meta = workflowMeta(typeof msg.prompt === 'string' ? msg.prompt : '')
  item.workflow = {
    taskId,
    name: (typeof msg.workflow_name === 'string' && msg.workflow_name) || meta.name || 'workflow',
    description: (typeof msg.description === 'string' && msg.description) || meta.description || '',
    status: 'running',
    phases: [],
    agents: [],
    totalTokens: 0,
    toolUses: 0,
    durationMs: 0,
    startTs: item.ts
  }
  if (taskId) e.workflowItems.set(taskId, toolUseId)
  emit(id, e, { type: 'update', item })
}

/** The Workflow tool item a task event belongs to (by task id or tool_use id). */
function workflowItem(e: Entry, msg: Record<string, unknown>): ChatItem | undefined {
  const taskId = typeof msg.task_id === 'string' ? msg.task_id : ''
  const toolUseId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : ''
  const itemId = (taskId && e.workflowItems.get(taskId)) || toolUseId
  const item = itemId ? e.items.find((it) => it.id === itemId) : undefined
  return item?.workflow ? item : undefined
}

/** Live progress: a workflow's carries the whole plan + agent state, a plain task's just a line. */
function handleTaskProgress(id: string, e: Entry, msg: Record<string, unknown>): void {
  const desc = typeof msg.description === 'string' ? msg.description : ''
  const item = workflowItem(e, msg)
  if (item?.workflow) {
    updateWorkflowRun(item.workflow, msg, desc)
    emit(id, e, { type: 'update', item })
    return
  }
  const toolUseId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : ''
  if (!toolUseId || !desc || !e.runningTasks.has(toolUseId)) return
  const plain = e.items.find((it) => it.id === toolUseId)
  if (!plain || plain.done) return
  plain.text = desc
  emit(id, e, { type: 'update', item: plain })
}

/** Fold one task_progress/notification event into a run (usage always, the plan when sent). */
function updateWorkflowRun(run: WorkflowRun, msg: Record<string, unknown>, desc: string): void {
  const usage = (msg.usage ?? {}) as Record<string, unknown>
  if (typeof usage.total_tokens === 'number') run.totalTokens = usage.total_tokens
  if (typeof usage.tool_uses === 'number') run.toolUses = usage.tool_uses
  if (typeof usage.duration_ms === 'number') run.durationMs = usage.duration_ms
  if (desc) run.current = desc
  if (!Array.isArray(msg.workflow_progress)) return // a heartbeat: keep the snapshot we have
  const { phases, agents } = parseWorkflowProgress(msg.workflow_progress)
  if (phases.length) run.phases = phases
  if (agents.length) run.agents = agents
}

/** Split a `workflow_progress` snapshot into its phase and agent rows (sorted by index). */
export function parseWorkflowProgress(raw: unknown[]): { phases: WorkflowPhase[]; agents: WorkflowAgent[] } {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const cut = (v: string | undefined): string | undefined => (v && v.length > WF_PREVIEW ? v.slice(0, WF_PREVIEW - 1) + '…' : v)
  const state = (v: unknown): WorkflowAgentState => (v === 'done' || v === 'error' || v === 'progress' ? v : 'start')
  const phases: WorkflowPhase[] = []
  const agents: WorkflowAgent[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const row = r as Record<string, unknown>
    const index = num(row.index)
    if (index === undefined) continue
    if (row.type === 'workflow_phase') phases.push({ index, title: str(row.title) ?? `Фаза ${index}`, ...(str(row.kind) ? { kind: str(row.kind) } : {}) })
    else if (row.type === 'workflow_agent')
      agents.push({
        index,
        label: str(row.label) ?? `агент ${index}`,
        state: state(row.state),
        phaseIndex: num(row.phaseIndex),
        phaseTitle: str(row.phaseTitle),
        agentId: str(row.agentId),
        agentType: str(row.agentType),
        model: str(row.model),
        queuedAt: num(row.queuedAt),
        startedAt: num(row.startedAt),
        lastProgressAt: num(row.lastProgressAt),
        attempt: num(row.attempt),
        lastToolName: str(row.lastToolName),
        lastToolSummary: cut(str(row.lastToolSummary)),
        promptPreview: cut(str(row.promptPreview)),
        resultPreview: cut(str(row.resultPreview)),
        error: cut(str(row.error)),
        isolation: str(row.isolation),
        ...(row.blocked === true ? { blocked: true } : {}),
        ...(row.cached === true ? { cached: true } : {}),
        tokens: num(row.tokens),
        toolCalls: num(row.toolCalls),
        durationMs: num(row.durationMs)
      })
  }
  phases.sort((a, b) => a.index - b.index)
  agents.sort((a, b) => a.index - b.index)
  return { phases, agents }
}

/** The CLI's task status, narrowed to the run statuses we render. */
function taskStatus(v: unknown): WorkflowStatus {
  return v === 'completed' || v === 'failed' || v === 'killed' ? v : 'failed'
}

/** Close a run out (task finished, stopped, or the session died). A late summary still lands. */
function finishWorkflowRun(run: WorkflowRun, status: WorkflowStatus, summary?: string): void {
  if (summary) run.summary = summary
  if (run.status !== 'running') return
  run.status = status
  run.endTs = Date.now()
  // Anything still marked running can never report again — show it as stopped, not spinning forever.
  if (status !== 'completed') for (const a of run.agents) if (a.state === 'start' || a.state === 'progress') a.state = 'error'
}

/** `task_updated` carries a status patch (a run stopped by the user reaches us as `killed` here first). */
function handleTaskUpdated(id: string, e: Entry, msg: Record<string, unknown>): void {
  const item = workflowItem(e, msg)
  const patch = (msg.patch ?? {}) as Record<string, unknown>
  if (!item?.workflow || typeof patch.status !== 'string' || patch.status === 'running') return
  finishWorkflowRun(item.workflow, taskStatus(patch.status))
  emit(id, e, { type: 'update', item })
}

/** A background task finished: close its row with the summary it reported (the real end of the call). */
function handleTaskDone(id: string, e: Entry, msg: Record<string, unknown>): void {
  const toolUseId = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : ''
  const taskId = typeof msg.task_id === 'string' ? msg.task_id : ''
  const summary = typeof msg.summary === 'string' ? msg.summary.trim() : ''
  let kind: TaskKind = 'agent'
  if (taskId) {
    kind = e.taskKinds.get(taskId) ?? 'agent'
    e.bgTasks.delete(taskId)
    e.taskKinds.delete(taskId)
  }
  const wfItem = workflowItem(e, msg)
  if (wfItem?.workflow) {
    // The final usage lands here too (the last progress event can be throttled away).
    updateWorkflowRun(wfItem.workflow, msg, '')
    finishWorkflowRun(wfItem.workflow, taskStatus(msg.status), summary)
    if (taskId) e.workflowItems.delete(taskId)
  }
  const item = wfItem ?? (toolUseId ? e.items.find((it) => it.id === toolUseId) : undefined)
  if (toolUseId) e.runningTasks.delete(toolUseId)
  if (item) {
    if (!item.done) {
      item.done = true
      item.isError = msg.status !== 'completed'
      item.endTs = Date.now()
      if (summary) item.output = summary
    }
    emit(id, e, { type: 'update', item })
  }
  // A subagent's notification is followed by a turn the CLI starts on its own (mark it expected);
  // a plain background shell job has nothing to wait for.
  if (kind === 'agent') markTurnActive(id, e, true)
  else refreshBusy(id, e)
}

/** The process is gone (exit/kill/interrupt): nothing still running can ever report again. */
function closeRunningTasks(id: string, e: Entry, status: WorkflowStatus): void {
  for (const toolUseId of e.runningTasks) {
    const item = e.items.find((it) => it.id === toolUseId)
    if (!item) continue
    if (item.workflow) finishWorkflowRun(item.workflow, status)
    if (!item.done) {
      item.done = true
      item.isError = true
      item.endTs = Date.now()
      item.output = item.workflow ? 'Воркфлов перервано.' : item.toolName === 'Agent' || item.toolName === 'Task' ? 'Субагента перервано.' : 'Фонову задачу перервано.'
    }
    emit(id, e, { type: 'update', item })
  }
  e.runningTasks.clear()
  e.workflowItems.clear()
}

/**
 * Stop a running workflow (the panel's «Зупинити воркфлов» button) via the CLI's own stop_task
 * control request — the same thing the TUI's `x stop workflow` does.
 */
export function stopChatWorkflow(id: string, taskId: string): void {
  const e = entries.get(id)
  if (!e?.proc || !taskId) return
  const itemId = e.workflowItems.get(taskId)
  const item = itemId ? e.items.find((it) => it.id === itemId) : undefined
  writeLine(e, { type: 'control_request', request_id: randomUUID(), request: { subtype: 'stop_task', task_id: taskId } })
  info(id, e, `Зупиняю воркфлов «${item?.workflow?.name ?? taskId}»…`)
}

/** Test hook: create/inspect an entry without a process. */
export function _entryForTest(id: string): Entry {
  return ensure(id)
}
