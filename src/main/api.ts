import { createServer } from 'http'
import type { IncomingMessage, Server, ServerResponse } from 'http'
import type { AppConfig, FindingsReport, Rule } from '../shared/types'
import { exportCheckerConfig } from '../shared/rules'
import { getConfig, setConfig } from './store'
import { getRule, getRules, saveUserRule, deleteUserRule, snapshot } from './rulesRepo'
import { attachChat, sendChatMessage, interruptChat } from './claudeChat'
import { startSessionChat } from './projects'
import { findSession } from '../shared/projects'
import { app } from 'electron'

/**
 * Local HTTP API for integrating the library with the board-check flow.
 *
 *   GET  /api/health                → { ok, version, rules }
 *   GET  /api/rules                 → EffectiveRule[]   (?enabled=1, ?category=power, ?project=<id> for that project's overrides)
 *   GET  /api/rules/:code           → EffectiveRule
 *   PUT  /api/rules/:code           → create/replace a *user* rule (body = Rule JSON); ?project=<id> saves it for that project only
 *   DELETE /api/rules/:code         → delete a user rule
 *   GET  /api/config                → AppConfig
 *   PATCH /api/config               → merge a partial AppConfig (overrides, api, paths)
 *   GET  /api/export/pcbagent       → flat thresholds + ignore_codes for pcbagent.checks.CheckConfig
 *   POST /api/findings              → store the latest checker report (FindingsReport); app shows it
 *   GET  /api/findings              → the latest stored report or null
 *   GET  /api/projects              → registered KiCad projects
 *   GET  /api/chat/:id              → chat snapshot (items, busy, pending, running); `id` is a session (tab)
 *                                     id, or a project id meaning its first session tab
 *   POST /api/chat/:id/send         → { text } send a message to that session's Claude (starts it if needed)
 *   POST /api/chat/:id/interrupt
 *
 * Bound to 127.0.0.1 by default; there is no auth because it never leaves the machine.
 */

let server: Server | null = null
let lastReport: FindingsReport | null = null
let onReport: ((r: FindingsReport) => void) | null = null
let onConfig: ((c: AppConfig) => void) | null = null
let screenshot: ((view?: string) => Promise<string>) | null = null

/** Provider that captures the main window to a PNG file and returns its path (dev/testing aid). */
export function setScreenshotProvider(fn: (view?: string) => Promise<string>): void {
  screenshot = fn
}

/** Called after a config change made through the HTTP API (so the window can refresh). */
export function setConfigListener(fn: (c: AppConfig) => void): void {
  onConfig = fn
}
let appVersion = '0.0.0'

export function setReportListener(fn: (r: FindingsReport) => void): void {
  onReport = fn
}

export function getLastReport(): FindingsReport | null {
  return lastReport
}

export function setLastReport(r: FindingsReport | null): void {
  lastReport = r
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 1)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,PATCH,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  })
  res.end(json)
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 8 * 1024 * 1024) reject(new Error('body too large'))
    })
    req.on('end', () => {
      if (!data) return resolve(undefined)
      try {
        resolve(JSON.parse(data))
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const method = req.method ?? 'GET'
  if (method === 'OPTIONS') return send(res, 204, {})
  try {
    if (path === '/api/health' && method === 'GET') {
      return send(res, 200, { ok: true, version: appVersion, rules: getRules().length })
    }
    const projectQ = url.searchParams.get('project') || undefined
    if (path === '/api/rules' && method === 'GET') {
      let rules = getRules(projectQ)
      if (url.searchParams.get('enabled') === '1') rules = rules.filter((r) => r.effective.enabled)
      const cat = url.searchParams.get('category')
      if (cat) rules = rules.filter((r) => r.category === cat)
      return send(res, 200, rules)
    }
    const m = path.match(/^\/api\/rules\/([A-Z0-9_]+)$/)
    if (m) {
      const code = m[1]
      if (method === 'GET') {
        const r = getRule(code, projectQ)
        return r ? send(res, 200, r) : send(res, 404, { error: `rule ${code} not found` })
      }
      if (method === 'PUT') {
        const body = (await readBody(req)) as Rule
        if (!body || typeof body !== 'object') return send(res, 400, { error: 'body must be a rule object' })
        const problems = saveUserRule({ ...body, code }, projectQ)
        return problems.length ? send(res, 422, { error: 'invalid rule', problems }) : send(res, 200, getRule(code, projectQ))
      }
      if (method === 'DELETE') {
        return deleteUserRule(code, projectQ) ? send(res, 200, { deleted: code }) : send(res, 404, { error: 'no user rule with that code' })
      }
    }
    if (path === '/api/config') {
      if (method === 'GET') return send(res, 200, getConfig())
      if (method === 'PATCH' || method === 'PUT') {
        const body = (await readBody(req)) as Partial<AppConfig>
        if (!body || typeof body !== 'object') return send(res, 400, { error: 'body must be a partial config' })
        const next = setConfig(body)
        onConfig?.(next)
        return send(res, 200, next)
      }
    }
    if (path === '/api/export/pcbagent' && method === 'GET') {
      return send(res, 200, exportCheckerConfig(getRules(projectQ)))
    }
    if (path === '/api/snapshot' && method === 'GET') {
      return send(res, 200, snapshot())
    }
    if (path === '/api/findings') {
      if (method === 'GET') return send(res, 200, lastReport)
      if (method === 'POST') {
        const body = (await readBody(req)) as FindingsReport
        if (!body || !Array.isArray(body.findings)) return send(res, 400, { error: 'body must be { board, generated, findings: [] }' })
        lastReport = { board: body.board ?? '', generated: body.generated ?? new Date().toISOString(), summary: body.summary, findings: body.findings }
        onReport?.(lastReport)
        return send(res, 200, { stored: lastReport.findings.length })
      }
    }
    if (path === '/api/projects' && method === 'GET') return send(res, 200, getConfig().projects)
    if (path === '/api/screenshot' && method === 'GET') {
      if (!screenshot) return send(res, 503, { error: 'no window' })
      return send(res, 200, { path: await screenshot(url.searchParams.get('view') || undefined) })
    }
    const cm = path.match(/^\/api\/chat\/([A-Za-z0-9_-]+)(?:\/(send|interrupt))?$/)
    if (cm) {
      const projects = getConfig().projects
      const sid = findSession(projects, cm[1])?.session.id ?? projects.find((p) => p.id === cm[1])?.sessions[0]?.id
      if (!sid) return send(res, 404, { error: `no project or session ${cm[1]}` })
      if (!cm[2] && method === 'GET') return send(res, 200, attachChat(sid))
      if (cm[2] === 'send' && method === 'POST') {
        const body = (await readBody(req)) as { text?: string }
        if (!body?.text) return send(res, 400, { error: 'body must be { text }' })
        sendChatMessage(sid, body.text, () => startSessionChat(sid, app.getPath('userData')))
        return send(res, 200, { sent: true })
      }
      if (cm[2] === 'interrupt' && method === 'POST') {
        interruptChat(sid)
        return send(res, 200, { interrupted: true })
      }
    }
    return send(res, 404, { error: `no route ${method} ${path}` })
  } catch (e) {
    return send(res, 500, { error: (e as Error).message })
  }
}

export function startApi(version: string): Promise<{ ok: boolean; url?: string; error?: string }> {
  appVersion = version
  return new Promise((resolve) => {
    stopApi()
    const cfg = getConfig().api
    if (!cfg.enabled) return resolve({ ok: false, error: 'disabled' })
    const s = createServer((req, res) => void handle(req, res))
    s.on('error', (e) => {
      server = null
      resolve({ ok: false, error: (e as Error).message })
    })
    s.listen(cfg.port, cfg.host, () => {
      server = s
      resolve({ ok: true, url: `http://${cfg.host}:${cfg.port}` })
    })
  })
}

export function stopApi(): void {
  if (server) {
    server.close()
    server = null
  }
}

export function apiStatus(): { running: boolean; url: string } {
  const cfg = getConfig().api
  return { running: !!server, url: `http://${cfg.host}:${cfg.port}` }
}
