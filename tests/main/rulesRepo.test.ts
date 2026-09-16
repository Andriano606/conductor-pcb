import { describe, expect, it, vi, beforeAll } from 'vitest'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'pcb-project-rules-'))
const userDir = join(tmp, 'user-rules')
mkdirSync(userDir)

vi.mock('electron', () => ({
  app: {
    getPath: (k: string) => (k === 'home' ? tmp : join(tmp, 'userData')),
    getAppPath: () => tmp,
    isPackaged: false
  }
}))

import { sampleRule } from '../helpers/sample'
import { initStore, setConfig } from '../../src/main/store'
import { deleteProjectRules, deleteUserRule, getRules, projectRulesDir, reloadRules, saveUserRule, setProjectRulesRoot, snapshot } from '../../src/main/rulesRepo'
import { handle } from '../../src/main/api'
import { reconcileProjectOverrides, setProjectRuleOverride } from '../../src/main/projects'
import type { IncomingMessage, ServerResponse } from 'http'

mkdirSync(join(tmp, 'rules'), { recursive: true })
writeFileSync(join(tmp, 'rules', 'A.json'), JSON.stringify(sampleRule({ code: 'A_RULE', title: 'bundled A' })))

function req(method: string, url: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve) => {
    const listeners: Record<string, (...a: unknown[]) => void> = {}
    const r = { method, url, on: (ev: string, fn: (...a: unknown[]) => void) => { listeners[ev] = fn; return r } } as unknown as IncomingMessage
    let status = 0
    const res = { writeHead: (s: number) => { status = s }, end: (data: string) => resolve({ status, json: data ? JSON.parse(data) : null }) } as unknown as ServerResponse
    void handle(r, res)
    if (body !== undefined) listeners.data?.(JSON.stringify(body))
    listeners.end?.()
  })
}

describe('project-scoped rules', () => {
  beforeAll(() => {
    initStore(join(tmp, 'userData'))
    setProjectRulesRoot(join(tmp, 'project-rules'))
    setConfig({ userRulesDir: userDir, projects: [{ id: 'p1', name: 'one', dir: '/x', proFile: '', boardFile: '', createdAt: 0, sessions: [{ id: 'p1', createdAt: 0 }] }, { id: 'p2', name: 'two', dir: '/y', proFile: '', boardFile: '', createdAt: 0, sessions: [{ id: 'p2', createdAt: 0 }] }] })
    reloadRules()
  })
  it('a rule saved for a project shows only in that project scope, tagged source=project', () => {
    expect(saveUserRule(sampleRule({ code: 'ONLY_P1' }), 'p1')).toEqual([])
    expect(existsSync(join(projectRulesDir('p1'), 'ONLY_P1.json'))).toBe(true)
    expect(getRules('p1').find((r) => r.code === 'ONLY_P1')?.source).toBe('project')
    expect(getRules().some((r) => r.code === 'ONLY_P1')).toBe(false)
    expect(getRules('p2').some((r) => r.code === 'ONLY_P1')).toBe(false)
    const snap = snapshot('p1')
    expect(snap.projectId).toBe('p1')
    expect(snap.projectRulesDir).toBe(projectRulesDir('p1'))
    expect(snapshot().projectRulesDir).toBeUndefined()
  })
  it('a project rule with a bundled code overrides it in that project only', () => {
    expect(saveUserRule(sampleRule({ code: 'A_RULE', title: 'project A' }), 'p1')).toEqual([])
    expect(getRules('p1').find((r) => r.code === 'A_RULE')?.title).toBe('project A')
    expect(getRules().find((r) => r.code === 'A_RULE')?.title).toBe('bundled A')
    expect(getRules('p2').find((r) => r.code === 'A_RULE')?.title).toBe('bundled A')
    // deleting the project copy brings the bundled rule back; the bundled file is untouched
    expect(deleteUserRule('A_RULE', 'p1')).toBe(true)
    expect(deleteUserRule('A_RULE', 'p1')).toBe(false)
    expect(deleteUserRule('A_RULE')).toBe(false) // not a user rule
    expect(getRules('p1').find((r) => r.code === 'A_RULE')?.title).toBe('bundled A')
  })
  it('global enabled state is inherited by the project until it overrides it', () => {
    setConfig({ overrides: { A_RULE: { enabled: false } } })
    expect(getRules('p1').find((r) => r.code === 'A_RULE')?.effective.enabled).toBe(false)
    setConfig({ projects: getRules && [{ ...getConfigProject('p1'), ruleOverrides: { A_RULE: { enabled: true } } }, getConfigProject('p2')] })
    expect(getRules('p1').find((r) => r.code === 'A_RULE')?.effective.enabled).toBe(true)
    expect(getRules('p2').find((r) => r.code === 'A_RULE')?.effective.enabled).toBe(false)
    expect(getRules().find((r) => r.code === 'A_RULE')?.effective.enabled).toBe(false)
  })
  it('a project override flipped back to the global value disappears', () => {
    setConfig({ overrides: { A_RULE: { enabled: false } } })
    setProjectRuleOverride('p2', 'A_RULE', { enabled: true })
    expect(getConfigProject('p2').ruleOverrides?.A_RULE).toEqual({ enabled: true })
    setProjectRuleOverride('p2', 'A_RULE', { params: { thr: 3 } }) // equals the default → not kept
    expect(getConfigProject('p2').ruleOverrides?.A_RULE).toEqual({ enabled: true })
    setProjectRuleOverride('p2', 'A_RULE', { enabled: false }) // back to the global value → gone
    expect(getConfigProject('p2').ruleOverrides?.A_RULE).toBeUndefined()
    setProjectRuleOverride('p2', 'A_RULE', { params: { thr: 7 } })
    expect(getConfigProject('p2').ruleOverrides?.A_RULE).toEqual({ params: { thr: 7 } })
    setProjectRuleOverride('p2', 'A_RULE', null)
    expect(getConfigProject('p2').ruleOverrides?.A_RULE).toBeUndefined()
  })
  it('changing the global values re-prunes the project overrides', () => {
    setConfig({ overrides: { A_RULE: { enabled: false, params: { thr: 3 } } } })
    setProjectRuleOverride('p2', 'A_RULE', { enabled: true, params: { thr: 5 } })
    expect(getConfigProject('p2').ruleOverrides?.A_RULE).toEqual({ enabled: true, params: { thr: 5 } })
    // the global default now matches the project's enabled flag → only the threshold stays overridden
    setConfig({ overrides: { A_RULE: { enabled: true } } })
    expect(reconcileProjectOverrides()).toBe(true)
    expect(getConfigProject('p2').ruleOverrides?.A_RULE).toEqual({ params: { thr: 5 } })
    expect(reconcileProjectOverrides()).toBe(false) // nothing more to drop
    setConfig({ overrides: { A_RULE: { params: { thr: 5 } } } })
    expect(reconcileProjectOverrides()).toBe(true)
    expect(getConfigProject('p2').ruleOverrides?.A_RULE).toBeUndefined()
  })
  it('the HTTP API saves and deletes project rules with ?project=', async () => {
    const put = await req('PUT', '/api/rules/VIA_API?project=p2', sampleRule({ code: 'VIA_API' }))
    expect(put.status).toBe(200)
    expect((put.json as { source: string }).source).toBe('project')
    expect(getRules('p2').some((r) => r.code === 'VIA_API')).toBe(true)
    expect(getRules().some((r) => r.code === 'VIA_API')).toBe(false)
    expect((await req('GET', '/api/rules?project=p2')).json as unknown[]).toContainEqual(expect.objectContaining({ code: 'VIA_API' }))
    expect((await req('DELETE', '/api/rules/VIA_API')).status).toBe(404)
    expect((await req('DELETE', '/api/rules/VIA_API?project=p2')).status).toBe(200)
    expect(getRules('p2').some((r) => r.code === 'VIA_API')).toBe(false)
  })
  it('deleteProjectRules wipes the project dir', () => {
    expect(existsSync(projectRulesDir('p1'))).toBe(true)
    deleteProjectRules('p1')
    expect(existsSync(projectRulesDir('p1'))).toBe(false)
    expect(getRules('p1').some((r) => r.code === 'ONLY_P1')).toBe(false)
    deleteProjectRules('nope') // no-op
  })
})

import { getConfig } from '../../src/main/store'
function getConfigProject(id: string) {
  return getConfig().projects.find((p) => p.id === id)!
}
