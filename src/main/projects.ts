import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { join } from 'path'
import type { ChatSession, CheckResult, FindingsReport, PcbProject, KicadStatus } from '../shared/types'
import { addSession, findSession, projectFromFiles, removeProject, removeSession, renameSession, updateSession, upsertProject } from '../shared/projects'
import { getConfig, setConfig } from './store'
import { bundledRulesDir } from './rulesRepo'
import { buildMergedConfig } from './configMerge'
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
  return projects.find((x) => x.dir === dir) ?? null
}

export function deleteProject(id: string): void {
  for (const s of getProject(id)?.sessions ?? []) deleteChatHistory(s.id)
  const cfg = getConfig()
  const projects = removeProject(cfg.projects, id)
  setConfig({ projects, activeProjectId: cfg.activeProjectId === id ? projects[0]?.id : cfg.activeProjectId })
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
export function closeChatSession(sessionId: string): boolean {
  const found = getSession(sessionId)
  if (!found || found.project.sessions.length <= 1) return false
  killChat(sessionId)
  deleteChatHistory(sessionId)
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

/** Profiles enabled for a project, in saved-list order (dangling ids dropped). */
export function projectProfiles(p: PcbProject): ClaudeProfile[] {
  const ids = new Set(p.claudeConfigProfileIds ?? [])
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
 * `--resume` reads `<CLAUDE_CONFIG_DIR>/projects/<slug>/<sessionId>.jsonl`. When a project's
 * config dir changes (profiles enabled/disabled/rebuilt) every session's conversation would be
 * lost, so copy each transcript from wherever it currently lives into the target dir.
 * Idempotent; returns true when every session with a Claude id now has its transcript there.
 */
export function carryResumeTranscript(p: PcbProject, toDir: string, candidates: string[]): boolean {
  const ids = p.sessions.map((s) => s.claudeSessionId).filter((x): x is string => !!x)
  if (!ids.length) return false
  let all = true
  for (const claudeSessionId of ids) {
    const rel = join('projects', transcriptSlug(p.dir), `${claudeSessionId}.jsonl`)
    const dest = join(toDir, rel)
    if (existsSync(dest)) continue
    let copied = false
    for (const from of candidates) {
      const src = join(from, rel)
      if (!from || from === toDir || !existsSync(src)) continue
      try {
        mkdirSync(join(toDir, 'projects', transcriptSlug(p.dir)), { recursive: true })
        copyFileSync(src, dest)
        copied = true
        break
      } catch {
      }
    }
    if (!copied) all = false
  }
  return all
}

/** (Re)build the merged CLAUDE_CONFIG_DIR for a project; returns the env to spawn claude with. */
export function projectClaudeEnv(p: PcbProject, userData: string, rebuild = false): NodeJS.ProcessEnv {
  const profiles = projectProfiles(p)
  const globalDir = join(homedir(), '.claude')
  const mergedDir = join(userData, 'claude-configs', p.id)
  if (!profiles.length) {
    // back to plain ~/.claude: bring the conversation along
    carryResumeTranscript(p, globalDir, [p.mergedConfigDir ?? '', mergedDir])
    if (p.mergedConfigDir) updateProject(p.id, { mergedConfigDir: undefined })
    return {}
  }
  if (rebuild || !existsSync(mergedDir)) buildMergedConfig(profiles, mergedDir)
  carryResumeTranscript(p, mergedDir, [globalDir, p.mergedConfigDir ?? ''])
  if (p.mergedConfigDir !== mergedDir) updateProject(p.id, { mergedConfigDir: mergedDir })
  return { ...profilesEnv(profiles), CLAUDE_CONFIG_DIR: mergedDir }
}

/** Restart every running session of a project so it picks up a new config; idle tabs start lazily. */
function restartProjectChats(p: PcbProject, userData: string): void {
  for (const s of p.sessions) if (chatRunning(s.id)) startSessionChat(s.id, userData, true)
}

/** Change which profiles a project uses and restart its chats with the rebuilt config. */
export function setProjectProfiles(id: string, profileIds: string[], userData: string): boolean {
  const p = updateProject(id, { claudeConfigProfileIds: profileIds })
  if (!p) return false
  projectClaudeEnv(p, userData, true)
  restartProjectChats(getProject(id) ?? p, userData)
  return true
}

/** Re-read every profile's source dir and rebuild all merged configs; restart affected chats. */
export function rebuildAllConfigs(userData: string): number {
  let n = 0
  for (const p of getConfig().projects) {
    if (!p.claudeConfigProfileIds?.length) continue
    projectClaudeEnv(p, userData, true)
    restartProjectChats(getProject(p.id) ?? p, userData)
    n++
  }
  return n
}

/** Start (or, with `restart`, respawn) the claude process behind one session tab. */
export function startSessionChat(sessionId: string, userData: string, restart = false): boolean {
  const found = getSession(sessionId)
  if (!found) return false
  const { project: p, session } = found
  const cfg = getConfig()
  const opts = {
    env: projectClaudeEnv(p, userData),
    cwd: p.dir,
    resume: session.claudeSessionId,
    mcpConfig: mcpConfigFor(p, userData),
    args: cfg.claudeArgs,
    model: session.claudeModel,
    effort: session.claudeEffort
  }
  if (restart) restartChat(sessionId, opts)
  else if (!chatRunning(sessionId)) startChat(sessionId, opts)
  return true
}

/** Open the board in KiCad's PCB editor (standalone pcbnew, so the API sees it). */
export function openInKicad(p: PcbProject): void {
  const cfg = getConfig()
  const child = spawn(cfg.kicadLauncher, ['pcbnew', p.boardFile], { cwd: p.dir, env: buildEnv(), detached: true, stdio: 'ignore' })
  child.unref()
}

export function kicadStatus(p: PcbProject): Promise<KicadStatus> {
  return new Promise((resolve) => {
    const apiSocket = existsSync('/tmp/kicad/api.sock')
    const ps = spawn('pgrep', ['-f', `pcbnew .*${basename(p.boardFile)}`], { env: buildEnv() })
    let out = ''
    ps.stdout.on('data', (d) => (out += d.toString()))
    ps.on('exit', () => resolve({ running: out.trim().length > 0, apiSocket }))
    ps.on('error', () => resolve({ running: false, apiSocket }))
  })
}

function basename(f: string): string {
  return f.split('/').pop() ?? f
}

/** Report files the checker CLI writes into the project dir (`pcbagent.report.write_reports`). */
export const CHECK_REPORT_MD = 'pcb_report.md'
export const CHECK_REPORT_JSON = 'pcb_report.json'

/**
 * Turn the checker's stdout (JSON report on the last line) into a CheckResult, pointing at the
 * report files in `dir` when they exist. Pure apart from the injected `exists`.
 */
export function parseCheckerOutput(out: string, dir: string, exists: (f: string) => boolean = existsSync): CheckResult {
  let report: FindingsReport
  try {
    report = JSON.parse(out.trim().split('\n').pop() ?? '{}') as FindingsReport
  } catch (e) {
    return { ok: false, error: `bad checker output: ${(e as Error).message}` }
  }
  if (!report || typeof report !== 'object' || !Array.isArray(report.findings)) return { ok: false, error: 'bad checker output: no findings array' }
  const md = join(dir, CHECK_REPORT_MD)
  const js = join(dir, CHECK_REPORT_JSON)
  return { ok: true, report, ...(exists(md) ? { reportFile: md } : {}), ...(exists(js) ? { reportJson: js } : {}) }
}

/** Run the checker CLI for a project; resolves with the JSON report (and report files) or an error text. */
export function runCheck(p: PcbProject): Promise<CheckResult> {
  const cfg = getConfig()
  return new Promise((resolve) => {
    const env = buildEnv({ KICAD_CLI: cfg.kicadCli, PCB_RULES_URL: `http://${cfg.api.host}:${cfg.api.port}`, PYTHONPATH: cfg.pcbagentDir, PCB_PROJECT_ID: p.id, PCB_RULES_DIR: bundledRulesDir() })
    const ps = spawn(cfg.pythonPath, ['-m', 'pcbagent.cli', 'check', '--json', '--post', p.dir], { cwd: cfg.pcbagentDir, env })
    let out = ''
    let err = ''
    ps.stdout.on('data', (d) => (out += d.toString()))
    ps.stderr.on('data', (d) => (err += d.toString()))
    ps.on('error', (e) => resolve({ ok: false, error: e.message }))
    ps.on('exit', (code) => {
      if (code !== 0) return resolve({ ok: false, error: (err || out).trim().split('\n').slice(-5).join('\n') })
      const r = parseCheckerOutput(out, p.dir)
      if (r.ok && r.report?.summary && r.report.generated) updateProject(p.id, { lastCheck: { generated: r.report.generated, summary: r.report.summary } })
      resolve(r)
    })
  })
}
