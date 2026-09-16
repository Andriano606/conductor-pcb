import { describe, expect, it, vi, beforeAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IncomingMessage, ServerResponse } from 'http'

const tmp = mkdtempSync(join(tmpdir(), 'pcb-rules-'))
const userDir = join(tmp, 'user-rules')
mkdirSync(userDir)
const bundled = join(tmp, 'bundled')
mkdirSync(bundled)

vi.mock('electron', () => ({
  app: {
    getPath: (k: string) => (k === 'home' ? tmp : join(tmp, 'userData')),
    getAppPath: () => tmp,
    isPackaged: false
  }
}))

import { sampleRule } from '../helpers/sample'
import { initStore, setConfig } from '../../src/main/store'
import { reloadRules } from '../../src/main/rulesRepo'
import { handle, getLastReport } from '../../src/main/api'

writeFileSync(join(bundled, 'A.json'), JSON.stringify(sampleRule({ code: 'A_RULE' })))
mkdirSync(join(tmp, 'rules'), { recursive: true })
writeFileSync(join(tmp, 'rules', 'A.json'), JSON.stringify(sampleRule({ code: 'A_RULE' })))

function req(method: string, url: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve) => {
    const listeners: Record<string, (...a: unknown[]) => void> = {}
    const r = {
      method,
      url,
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        listeners[ev] = fn
        return r
      }
    } as unknown as IncomingMessage
    let status = 0
    const res = {
      writeHead: (s: number) => {
        status = s
      },
      end: (data: string) => resolve({ status, json: data ? JSON.parse(data) : null })
    } as unknown as ServerResponse
    void handle(r, res)
    if (body !== undefined) listeners.data?.(JSON.stringify(body))
    listeners.end?.()
  })
}

describe('local API', () => {
  beforeAll(() => {
    initStore(join(tmp, 'userData'))
    setConfig({ userRulesDir: userDir })
    reloadRules()
  })
  it('lists rules and gets one', async () => {
    const list = await req('GET', '/api/rules')
    expect(list.status).toBe(200)
    expect((list.json as { code: string }[]).map((r) => r.code)).toEqual(['A_RULE'])
    const one = await req('GET', '/api/rules/A_RULE')
    expect(one.status).toBe(200)
    expect((one.json as { effective: { params: { thr: number } } }).effective.params.thr).toBe(3)
    expect((await req('GET', '/api/rules/NOPE')).status).toBe(404)
  })
  it('patches config overrides and reflects them in the export', async () => {
    const p = await req('PATCH', '/api/config', { overrides: { A_RULE: { enabled: false, params: { thr: 8 } } } })
    expect(p.status).toBe(200)
    const ex = await req('GET', '/api/export/pcbagent')
    expect((ex.json as { thr: number; ignore_codes: string[] }).thr).toBe(8)
    expect((ex.json as { ignore_codes: string[] }).ignore_codes).toEqual(['A_RULE'])
  })
  it('creates a user rule via PUT, rejects invalid, deletes it', async () => {
    const bad = await req('PUT', '/api/rules/NEW_RULE', { title: 'x' })
    expect(bad.status).toBe(422)
    const ok = await req('PUT', '/api/rules/NEW_RULE', sampleRule({ code: 'NEW_RULE' }))
    expect(ok.status).toBe(200)
    expect((ok.json as { source: string }).source).toBe('user')
    expect(((await req('GET', '/api/rules')).json as unknown[]).length).toBe(2)
    expect((await req('DELETE', '/api/rules/NEW_RULE')).status).toBe(200)
    expect((await req('DELETE', '/api/rules/A_RULE')).status).toBe(404) // bundled, not user
  })
  it('stores findings', async () => {
    const r = await req('POST', '/api/findings', { board: 'x.kicad_pcb', generated: 't', findings: [{ code: 'A_RULE', severity: 'warning', title: 't' }] })
    expect(r.status).toBe(200)
    expect(getLastReport()?.findings).toHaveLength(1)
    expect((await req('POST', '/api/findings', { nope: 1 })).status).toBe(400)
  })
  it('resolves /api/chat/:id by session id or by project id (first tab)', async () => {
    const proj = { id: 'proj', name: 'b', dir: '/x/b', proFile: '', boardFile: '/x/b/b.kicad_pcb', createdAt: 0, sessions: [{ id: 'proj', createdAt: 0 }, { id: 'tab2', createdAt: 0 }] }
    setConfig({ projects: [proj] })
    expect((await req('GET', '/api/chat/proj')).status).toBe(200)
    expect((await req('GET', '/api/chat/tab2')).status).toBe(200)
    expect((await req('GET', '/api/chat/missing')).status).toBe(404)
    expect((await req('POST', '/api/chat/tab2/send', {})).status).toBe(400)
    setConfig({ projects: [] })
  })
  it('404s unknown routes and answers health', async () => {
    expect((await req('GET', '/nothing')).status).toBe(404)
    expect(((await req('GET', '/api/health')).json as { ok: boolean }).ok).toBe(true)
  })
})
