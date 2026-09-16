import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs'
import { spawn } from 'child_process'
import { join } from 'path'
import type { PcbProject, KicadStatus } from '../shared/types'
import { buildSystemPrompt, projectFromFiles, removeProject, upsertProject } from '../shared/projects'
import { getConfig, setConfig } from './store'
import { bundledRulesDir } from './rulesRepo'
import { buildEnv } from './env'
import { restartChat, startChat, chatRunning, deleteChatHistory } from './claudeChat'

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
  deleteChatHistory(id)
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

export function startProjectChat(id: string, userData: string, restart = false): boolean {
  const p = getProject(id)
  if (!p) return false
  const cfg = getConfig()
  const opts = {
    cwd: p.dir,
    resume: p.claudeSessionId,
    mcpConfig: mcpConfigFor(p, userData),
    systemPrompt: buildSystemPrompt(p, `http://${cfg.api.host}:${cfg.api.port}`),
    args: cfg.claudeArgs,
    model: p.claudeModel,
    effort: p.claudeEffort
  }
  if (restart) restartChat(id, opts)
  else if (!chatRunning(id)) startChat(id, opts)
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

/** Run the checker CLI for a project; resolves with the JSON report or an error text. */
export function runCheck(p: PcbProject): Promise<{ ok: boolean; report?: unknown; error?: string }> {
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
      try {
        const report = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { summary?: PcbProject['lastCheck'] extends infer T ? (T extends { summary: infer S } ? S : never) : never; generated?: string }
        if (report.summary && report.generated) updateProject(p.id, { lastCheck: { generated: report.generated, summary: report.summary } })
        resolve({ ok: true, report })
      } catch (e) {
        resolve({ ok: false, error: `bad checker output: ${(e as Error).message}` })
      }
    })
  })
}
