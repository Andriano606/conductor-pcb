import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import { join } from 'path'
import type { BoardCheckResult, ChatSession, CheckProgress, CheckResult, FindingsReport, KernelInfo, MultiCheckResult, PcbProject, KicadStatus, RuleOverride, Severity } from '../shared/types'
import { addSession, findSession, isBoardFile, isSkippedDir, projectFromFiles, removeProject, removeSession, renameSession, reportStemFor, updateSession, upsertProject } from '../shared/projects'
import { snapshotOverrides, withProjectOverride } from '../shared/rules'
import { getConfig, setConfig } from './store'
import { bundledRulesDir, deleteProjectRules, getRules } from './rulesRepo'
import { buildMergedConfig } from './configMerge'
import { CREDENTIALS_FILE, syncCredentials } from './credentialsSync'
import type { ClaudeProfile } from '../shared/types'
import { buildEnv } from './env'
import { restartChat, startChat, chatRunning, deleteChatHistory, killChat } from './claudeChat'

export function addProjectFromDir(dir: string): PcbProject | null {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir)
  const p = projectFromFiles(dir, files, randomUUID())
  if (!p) return null
  const projects = upsertProject(getConfig().projects, p)
  setConfig({ projects, activeProjectId: projects.find((x) => x.dir === dir)?.id })
  pinUnpinnedProjects() // a new project starts with a copy of the current global rule values
  return getConfig().projects.find((x) => x.dir === dir) ?? null
}

export function deleteProject(id: string): void {
  for (const s of getProject(id)?.sessions ?? []) deleteChatHistory(s.id)
  deleteProjectRules(id)
  const cfg = getConfig()
  const projects = removeProject(cfg.projects, id)
  setConfig({ projects, activeProjectId: cfg.activeProjectId === id ? projects[0]?.id : cfg.activeProjectId })
}

/** Merge `ov` into a project's override for `code` (null removes it). */
export function setProjectRuleOverride(projectId: string, code: string, ov: RuleOverride | null): void {
  setConfig({ projects: withProjectOverride(getConfig().projects, projectId, code, ov) })
}

/**
 * Apply the current global values to a project (↺ in the «Правила» tab): its overrides become a
 * full copy of the global effective state, plus the file defaults of its own project-only rules.
 */
export function applyGlobalRulesToProject(projectId: string): void {
  const cleared = getConfig().projects.map((p) => (p.id === projectId ? { ...p, ruleOverrides: {} } : p))
  setConfig({ projects: cleared })
  const snapshot = snapshotOverrides(getRules(projectId))
  setConfig({ projects: getConfig().projects.map((p) => (p.id === projectId ? { ...p, ruleOverrides: snapshot, rulesPinned: true } : p)) })
}

/**
 * Pin the rule state of projects that are not pinned yet: their current effective values
 * (global + whatever partial overrides they had) become a full copy, so global changes stop
 * leaking into them. Runs once at startup (migration) and for every new project.
 */
export function pinUnpinnedProjects(): number {
  let n = 0
  for (const p of getConfig().projects) {
    if (p.rulesPinned) continue
    const snapshot = snapshotOverrides(getRules(p.id))
    setConfig({ projects: getConfig().projects.map((x) => (x.id === p.id ? { ...x, ruleOverrides: snapshot, rulesPinned: true } : x)) })
    n++
  }
  return n
}

export function updateProject(id: string, patch: Partial<PcbProject>): PcbProject | undefined {
  const projects = getConfig().projects.map((p) => (p.id === id ? { ...p, ...patch, id } : p))
  setConfig({ projects })
  return projects.find((p) => p.id === id)
}

export function getProject(id: string): PcbProject | undefined {
  return getConfig().projects.find((p) => p.id === id)
}

// ---- chat sessions (tabs): the session id is the chat key used by claudeChat.ts ----

export function getSession(sessionId: string): { project: PcbProject; session: ChatSession } | undefined {
  return findSession(getConfig().projects, sessionId)
}

export function patchSession(sessionId: string, patch: Partial<ChatSession>): void {
  setConfig({ projects: updateSession(getConfig().projects, sessionId, patch) })
}

/** Add a session tab to a project and start its chat right away. */
export function createChatSession(projectId: string, userData: string): ChatSession | undefined {
  const { list, session } = addSession(getConfig().projects, projectId, randomUUID())
  if (!session) return undefined
  setConfig({ projects: list })
  startSessionChat(session.id, userData)
  return session
}

/** Close a session tab: kill its claude, drop its transcript, forget it. The last session stays. */
export function closeChatSession(sessionId: string, userData?: string): boolean {
  const found = getSession(sessionId)
  if (!found || found.project.sessions.length <= 1) return false
  killChat(sessionId)
  deleteChatHistory(sessionId)
  // Its merged config goes too — except the dir named after the project, which the pre per-session
  // profiles shared between all tabs: the other tabs' transcripts may still wait there to be carried over.
  if (userData && sessionId !== found.project.id) rmSync(sessionConfigDir(sessionId, userData), { recursive: true, force: true })
  setConfig({ projects: removeSession(getConfig().projects, sessionId) })
  return true
}

export function renameChatSession(sessionId: string, title: string): void {
  setConfig({ projects: renameSession(getConfig().projects, sessionId, title) })
}

/** Write the MCP config file for a project (points claude at the pcbagent server). */
export function mcpConfigFor(p: PcbProject, userData: string): string {
  const cfg = getConfig()
  const dir = join(userData, 'mcp')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${p.id}.json`)
  const rulesUrl = `http://${cfg.api.host}:${cfg.api.port}`
  writeFileSync(file, JSON.stringify({
    mcpServers: {
      pcbagent: {
        command: cfg.pythonPath,
        args: ['-m', 'pcbagent.mcp_server'],
        cwd: cfg.pcbagentDir,
        env: { PCB_RULES_URL: rulesUrl, KICAD_CLI: cfg.kicadCli, PCB_PROJECT_DIR: p.dir, PCB_BOARD_FILE: p.boardFile, PCB_PROJECT_ID: p.id, PCB_RULES_DIR: bundledRulesDir(), PYTHONPATH: cfg.pcbagentDir }
      }
    }
  }, null, 2))
  return file
}

/** Profiles enabled for a session tab, in saved-list order (dangling ids dropped). */
export function sessionProfiles(session: ChatSession): ClaudeProfile[] {
  const ids = new Set(session.claudeConfigProfileIds ?? [])
  return getConfig().claudeProfiles.filter((x) => ids.has(x.id))
}

function profilesEnv(profiles: ClaudeProfile[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const pr of profiles) for (const { key, value } of pr.env ?? []) if (key.trim()) env[key.trim()] = value
  return env
}

/** Claude's per-cwd transcript folder name: every non-alphanumeric char becomes '-'. */
export function transcriptSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * `--resume` reads `<CLAUDE_CONFIG_DIR>/projects/<slug>/<claudeSessionId>.jsonl`. When a session's
 * config dir changes (profiles enabled/disabled/rebuilt) its conversation would be lost, so copy the
 * transcript from wherever it currently lives into the target dir.
 * The newest copy wins: a tab that toggles its profiles back and forth leaves an older copy in the
 * dir it returns to. Idempotent; returns true when the transcript is in `toDir` afterwards.
 */
export function carryResumeTranscript(cwd: string, claudeSessionId: string | undefined, toDir: string, candidates: string[]): boolean {
  if (!claudeSessionId) return false
  const rel = join('projects', transcriptSlug(cwd), `${claudeSessionId}.jsonl`)
  const dest = join(toDir, rel)
  const mtime = (f: string): number => {
    try {
      return statSync(f).mtimeMs
    } catch {
      return -1
    }
  }
  let src = ''
  let newest = mtime(dest)
  for (const from of candidates) {
    if (!from || from === toDir) continue
    const t = mtime(join(from, rel))
    if (t > newest) {
      newest = t
      src = join(from, rel)
    }
  }
  if (!src) return newest >= 0
  try {
    mkdirSync(join(toDir, 'projects', transcriptSlug(cwd)), { recursive: true })
    copyFileSync(src, dest)
    return true
  } catch {
    return existsSync(dest)
  }
}

/** The app-owned CLAUDE_CONFIG_DIR of one session tab. */
export function sessionConfigDir(sessionId: string, userData: string): string {
  return join(userData, 'claude-configs', sessionId)
}

/** (Re)build the merged CLAUDE_CONFIG_DIR of a session tab; returns the env to spawn its claude with. */
export function sessionClaudeEnv(p: PcbProject, session: ChatSession, userData: string, rebuild = false): NodeJS.ProcessEnv {
  const profiles = sessionProfiles(session)
  const globalDir = join(homedir(), '.claude')
  const mergedDir = sessionConfigDir(session.id, userData)
  // Profiles used to be per project with one merged dir for all its tabs: a transcript may still live there.
  const legacyDirs = [p.mergedConfigDir ?? '', sessionConfigDir(p.id, userData)]
  if (!profiles.length) {
    // back to plain ~/.claude: bring the conversation along
    carryResumeTranscript(p.dir, session.claudeSessionId, globalDir, [session.mergedConfigDir ?? '', mergedDir, ...legacyDirs])
    if (session.mergedConfigDir) patchSession(session.id, { mergedConfigDir: undefined })
    return {}
  }
  if (rebuild || !existsSync(mergedDir)) buildMergedConfig(profiles, mergedDir)
  // The merged copy of the login must carry the same (freshest) OAuth token as ~/.claude, see credentialsSync.ts.
  syncCredentials(userData, [join(mergedDir, CREDENTIALS_FILE)])
  carryResumeTranscript(p.dir, session.claudeSessionId, mergedDir, [globalDir, session.mergedConfigDir ?? '', ...legacyDirs])
  if (session.mergedConfigDir !== mergedDir) patchSession(session.id, { mergedConfigDir: mergedDir })
  return { ...profilesEnv(profiles), CLAUDE_CONFIG_DIR: mergedDir }
}

/**
 * Change which profiles one session tab uses and restart that tab (only when it runs; an idle tab
 * starts lazily). The other tabs of the project keep their own sets and are not touched. The set
 * also becomes what the project's next new tab starts with.
 */
export function setSessionProfiles(sessionId: string, profileIds: string[], userData: string): boolean {
  const found = getSession(sessionId)
  if (!found) return false
  patchSession(sessionId, { claudeConfigProfileIds: profileIds })
  updateProject(found.project.id, { newSessionProfileIds: profileIds })
  const now = getSession(sessionId)
  if (!now) return false
  sessionClaudeEnv(now.project, now.session, userData, true)
  if (chatRunning(sessionId)) startSessionChat(sessionId, userData, true)
  return true
}

/** Re-read every profile's source dir and rebuild all merged configs; restart the running chats that use one. */
export function rebuildAllConfigs(userData: string): number {
  let n = 0
  for (const p of getConfig().projects) {
    for (const s of p.sessions) {
      if (!s.claudeConfigProfileIds?.length) continue
      sessionClaudeEnv(p, s, userData, true)
      if (chatRunning(s.id)) startSessionChat(s.id, userData, true)
      n++
    }
  }
  return n
}

/** Start (or, with `restart`, respawn) the claude process behind one session tab. */
export function startSessionChat(sessionId: string, userData: string, restart = false): boolean {
  const found = getSession(sessionId)
  if (!found) return false
  const { project: p, session } = found
  const cfg = getConfig()
  const profiles = sessionProfiles(session)
  const opts = {
    env: sessionClaudeEnv(p, session, userData),
    profileLabel: profiles.length ? profiles.map((x) => x.name).join(', ') : 'стандартний ~/.claude',
    cwd: p.dir,
    resume: session.claudeSessionId,
    mcpConfig: mcpConfigFor(p, userData),
    args: cfg.claudeArgs,
    model: session.claudeModel,
    effort: session.claudeEffort,
    ultracode: session.claudeUltracode
  }
  if (restart) restartChat(sessionId, opts)
  else if (!chatRunning(sessionId)) startChat(sessionId, opts)
  return true
}

// ---------------------------------------------------------------- boards, KiCad, checks

/** Every board file under `dir` (depth-limited, skipping backups/hidden dirs), sorted, absolute. */
export function listBoards(dir: string, depth = 3): string[] {
  const out: string[] = []
  const walk = (d: string, left: number): void => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const full = join(d, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir) {
        if (left > 0 && !isSkippedDir(name)) walk(full, left - 1)
      } else if (isBoardFile(name)) out.push(full)
    }
  }
  walk(dir, depth)
  return out
}

/** Re-scan a project's boards and persist the list when it changed. */
export function refreshBoards(p: PcbProject): PcbProject {
  const found = listBoards(p.dir)
  const boards = found.length ? found : (existsSync(p.boardFile) ? [p.boardFile] : [])
  if (JSON.stringify(boards) === JSON.stringify(p.boards ?? [])) return p
  return updateProject(p.id, { boards }) ?? p
}

/** Open a board in KiCad's PCB editor (standalone pcbnew, so the API sees it). Returns the launcher process. */
export function openInKicad(p: PcbProject, boardFile = p.boardFile): ChildProcess {
  const cfg = getConfig()
  const child = spawn(cfg.kicadLauncher, ['pcbnew', boardFile], { cwd: p.dir, env: buildEnv(), detached: true, stdio: 'ignore' })
  child.unref()
  return child
}

/** Command lines of the running pcbnew editors (the AppImage's inner binary, one per window). */
function pcbnewCommandLines(): Promise<string[]> {
  return new Promise((resolve) => {
    const ps = spawn('pgrep', ['-af', 'bin/pcbnew'], { env: buildEnv() })
    let out = ''
    ps.stdout.on('data', (d) => (out += d.toString()))
    ps.on('exit', () => resolve(out.split('\n').filter((l) => l.trim())))
    ps.on('error', () => resolve([]))
  })
}

export async function kicadStatus(p: PcbProject): Promise<KicadStatus> {
  const apiSocket = existsSync('/tmp/kicad/api.sock')
  const lines = await pcbnewCommandLines()
  const boards = p.boards?.length ? p.boards : [p.boardFile]
  const runningBoards = boards.filter((b) => lines.some((l) => l.includes(basename(b))))
  return { running: runningBoards.length > 0, apiSocket, runningBoards }
}

function basename(f: string): string {
  return f.split('/').pop() ?? f
}

function checkerEnv(p: PcbProject): NodeJS.ProcessEnv {
  const cfg = getConfig()
  return buildEnv({ KICAD_CLI: cfg.kicadCli, PCB_RULES_URL: `http://${cfg.api.host}:${cfg.api.port}`, PYTHONPATH: cfg.pcbagentDir, PCB_PROJECT_ID: p.id, PCB_RULES_DIR: bundledRulesDir() })
}

let kernelsCache: { at: number; list: KernelInfo[] } | null = null

/** Kernels the checker knows (`pcbagent.cli kernels --json`), cached for a minute; [] when the checker is unreachable. */
export function listKernels(force = false): Promise<KernelInfo[]> {
  if (!force && kernelsCache && Date.now() - kernelsCache.at < 60_000) return Promise.resolve(kernelsCache.list)
  const cfg = getConfig()
  return new Promise((resolve) => {
    const ps = spawn(cfg.pythonPath, ['-m', 'pcbagent.cli', 'kernels', '--json'], { cwd: cfg.pcbagentDir, env: buildEnv({ PYTHONPATH: cfg.pcbagentDir }) })
    let out = ''
    ps.stdout.on('data', (d) => (out += d.toString()))
    ps.on('error', () => resolve([]))
    ps.on('exit', () => {
      try {
        const list = (JSON.parse(out.trim().split('\n').pop() ?? '{}') as { kernels?: KernelInfo[] }).kernels ?? []
        kernelsCache = { at: Date.now(), list }
        resolve(list)
      } catch {
        resolve([])
      }
    })
  })
}

/** Boards currently open in the KiCad the API reaches (`pcbagent.cli docs --json`), [] when none/unreachable. */
export function openBoardsInKicad(p: PcbProject): Promise<string[]> {
  const cfg = getConfig()
  return new Promise((resolve) => {
    const ps = spawn(cfg.pythonPath, ['-m', 'pcbagent.cli', 'docs', '--json'], { cwd: cfg.pcbagentDir, env: checkerEnv(p) })
    let out = ''
    ps.stdout.on('data', (d) => (out += d.toString()))
    ps.on('error', () => resolve([]))
    ps.on('exit', () => {
      try {
        resolve((JSON.parse(out.trim().split('\n').pop() ?? '{}') as { boards?: string[] }).boards ?? [])
      } catch {
        resolve([])
      }
    })
  })
}

/** Report files the checker CLI writes into the project dir (`pcbagent.report.write_reports`). */
export const CHECK_REPORT_MD = 'pcb_report.md'
export const CHECK_REPORT_JSON = 'pcb_report.json'

/**
 * Turn the checker's stdout (JSON report on the last line) into a CheckResult, pointing at the
 * report files in `dir` when they exist. Pure apart from the injected `exists`.
 */
export function parseCheckerOutput(out: string, dir: string, exists: (f: string) => boolean = existsSync, stem = 'pcb_report'): CheckResult {
  let report: FindingsReport
  try {
    report = JSON.parse(out.trim().split('\n').pop() ?? '{}') as FindingsReport
  } catch (e) {
    return { ok: false, error: `bad checker output: ${(e as Error).message}` }
  }
  if (!report || typeof report !== 'object' || !Array.isArray(report.findings)) return { ok: false, error: 'bad checker output: no findings array' }
  const md = join(dir, `${stem}.md`)
  const js = join(dir, `${stem}.json`)
  return { ok: true, report, ...(exists(md) ? { reportFile: md } : {}), ...(exists(js) ? { reportJson: js } : {}) }
}

/** Run the checker CLI for one board of a project (must be open in KiCad); resolves with the report or an error text. */
export function runCheck(p: PcbProject, boardFile = p.boardFile, stem = 'pcb_report'): Promise<CheckResult> {
  const cfg = getConfig()
  return new Promise((resolve) => {
    const ps = spawn(cfg.pythonPath, ['-m', 'pcbagent.cli', 'check', '--json', '--post', '--board', boardFile, '--stem', stem, p.dir], { cwd: cfg.pcbagentDir, env: checkerEnv(p) })
    let out = ''
    let err = ''
    ps.stdout.on('data', (d) => (out += d.toString()))
    ps.stderr.on('data', (d) => (err += d.toString()))
    ps.on('error', (e) => resolve({ ok: false, error: e.message }))
    ps.on('exit', (code) => {
      if (code !== 0) return resolve({ ok: false, error: (err || out).trim().split('\n').slice(-5).join('\n') })
      resolve(parseCheckerOutput(out, p.dir, existsSync, stem))
    })
  })
}

const sameBoard = (a: string, b: string): boolean => a === b || basename(a) === basename(b)

/** Injectable plumbing of `runChecks`, so the orchestration is unit-testable without KiCad. */
export interface CheckDeps {
  openDocs: () => Promise<string[]>
  /** Number of running pcbnew editors (any board). */
  editors: () => Promise<number>
  launch: (boardFile: string) => ChildProcess
  close: (proc: ChildProcess) => void
  check: (boardFile: string, stem: string) => Promise<CheckResult>
  sleep: (ms: number) => Promise<void>
  /** How long to wait for a launched pcbnew to expose the board (ms). */
  openTimeout: number
}

function defaultDeps(p: PcbProject): CheckDeps {
  return {
    openDocs: () => openBoardsInKicad(p),
    editors: async () => (await pcbnewCommandLines()).length,
    launch: (b) => openInKicad(p, b),
    close: (proc) => {
      if (proc.pid) {
        try {
          process.kill(-proc.pid, 'SIGTERM') // the AppImage runtime and the editor it started share the group
        } catch {
          try {
            proc.kill('SIGTERM')
          } catch {
            /* already gone */
          }
        }
      }
    },
    check: (b, stem) => runCheck(p, b, stem),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    openTimeout: 120_000
  }
}

/**
 * «Перевірити плату» over `boards`, one at a time. KiCad exposes its API from a single editor,
 * so: a board already open is checked right away; a board that is not open is opened by us
 * (and closed afterwards) only when no other editor is running, otherwise it is skipped with
 * an explanation. Progress goes to `onProgress`; per-board summaries are persisted on the project.
 */
export async function runChecks(p: PcbProject, boards: string[], onProgress: (pr: CheckProgress) => void, deps: CheckDeps = defaultDeps(p)): Promise<MultiCheckResult> {
  const progress = (boardFile: string, phase: CheckProgress['phase'], message?: string): void => onProgress({ projectId: p.id, boardFile, phase, message })
  for (const b of boards) progress(b, 'waiting')
  const results: BoardCheckResult[] = []
  let launched: ChildProcess | null = null
  const allBoards = p.boards?.length ? p.boards : boards
  const isOpen = (docs: string[], b: string): boolean => docs.some((d) => sameBoard(d, b))
  const closeLaunched = async (): Promise<void> => {
    if (!launched) return
    deps.close(launched)
    launched = null
    const t0 = Date.now()
    while ((await deps.editors()) > 0 && Date.now() - t0 < 20_000) await deps.sleep(1000)
  }
  for (const board of boards) {
    let docs = await deps.openDocs()
    if (!isOpen(docs, board)) {
      const foreign = (await deps.editors()) - (launched ? 1 : 0)
      if (foreign > 0) {
        const msg = 'у KiCad відкрита інша плата, а API доступний лише з одного редактора: закрийте її або відкрийте цю плату вручну'
        results.push({ ok: false, boardFile: board, status: 'skipped', error: msg })
        progress(board, 'skipped', msg)
        continue
      }
      await closeLaunched()
      progress(board, 'opening', 'відкриваю в KiCad…')
      launched = deps.launch(board)
      const t0 = Date.now()
      while (!isOpen(docs, board) && Date.now() - t0 < deps.openTimeout) {
        await deps.sleep(2000)
        docs = await deps.openDocs()
      }
      if (!isOpen(docs, board)) {
        const msg = 'KiCad не відкрив плату вчасно'
        results.push({ ok: false, boardFile: board, status: 'error', error: msg })
        progress(board, 'error', msg)
        continue
      }
    }
    progress(board, 'checking', 'перевіряю…')
    const r = await deps.check(board, reportStemFor(board, allBoards))
    results.push({ ...r, boardFile: board, status: r.ok ? 'ok' : 'error' })
    progress(board, r.ok ? 'ok' : 'error', r.error)
  }
  await closeLaunched()
  // persist per-board summaries and the project-wide total
  const lastChecks = { ...(getProject(p.id)?.lastChecks ?? {}) }
  const total: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  let generated = ''
  for (const r of results) {
    if (!r.ok || !r.report?.summary) continue
    lastChecks[r.boardFile] = { generated: r.report.generated, summary: r.report.summary }
    generated = r.report.generated
    for (const k of Object.keys(total) as Severity[]) total[k] += r.report.summary[k] ?? 0
  }
  if (generated) updateProject(p.id, { lastChecks, lastCheck: { generated, summary: total } })
  return { projectId: p.id, boards: results }
}
