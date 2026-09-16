import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChildProcess } from 'child_process'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => '/tmp', isPackaged: false } }))

import { initStore, setConfig } from '../../src/main/store'
import { listBoards, runChecks } from '../../src/main/projects'
import type { CheckDeps } from '../../src/main/projects'
import type { CheckProgress, PcbProject } from '@shared/types'

const tmp = mkdtempSync(join(tmpdir(), 'boards-'))
initStore(join(tmp, 'userData'))

describe('listBoards', () => {
  it('finds board files recursively, skipping backups, autosaves and backup dirs', () => {
    const d = join(tmp, 'proj')
    mkdirSync(join(d, 'sub'), { recursive: true })
    mkdirSync(join(d, 'proj-backups'), { recursive: true })
    mkdirSync(join(d, '.git'), { recursive: true })
    for (const f of ['main.kicad_pcb', 'main.kicad_pro', 'sub/second.kicad_pcb', 'proj-backups/main.kicad_pcb', '.git/x.kicad_pcb', 'main.kicad_pcb.backup', '_autosave-main.kicad_pcb']) writeFileSync(join(d, f), '')
    expect(listBoards(d)).toEqual([join(d, 'main.kicad_pcb'), join(d, 'sub', 'second.kicad_pcb')])
    expect(listBoards(join(tmp, 'nope'))).toEqual([])
  })
})

const A = '/p/a.kicad_pcb'
const B = '/p/sub/b.kicad_pcb'
const C = '/p/c.kicad_pcb'
const project: PcbProject = { id: 'p1', name: 'p', dir: '/p', proFile: '', boardFile: A, createdAt: 0, sessions: [{ id: 'p1', createdAt: 0 }], boards: [A, B, C] }
const report = (board: string) => ({ board, generated: 'g', summary: { error: 1, warning: 0, info: 0 }, findings: [] })

function deps(opts: Partial<Omit<CheckDeps, 'editors'>> & { docs?: string[]; editors?: number }): CheckDeps & { launched: string[]; closed: number; checked: [string, string][] } {
  const { docs, editors, ...over } = opts
  const state = { docs: docs ?? [], editors: editors ?? 0 }
  const d = {
    launched: [] as string[],
    closed: 0,
    checked: [] as [string, string][],
    openDocs: async () => state.docs,
    editors: async () => state.editors,
    launch: (b: string) => {
      d.launched.push(b)
      state.docs = [b] // the launched editor shows the board on the next poll
      state.editors += 1
      return { pid: 1 } as ChildProcess
    },
    close: () => {
      d.closed += 1
      state.docs = []
      state.editors -= 1
    },
    check: async (b: string, stem: string) => {
      d.checked.push([b, stem])
      return { ok: true, report: report(b), reportFile: `/p/${stem}.md` }
    },
    sleep: async () => {},
    openTimeout: 10_000,
    ...over
  }
  return d
}

describe('runChecks', () => {
  it('checks an open board in place, opens the closed ones itself one by one, closes what it opened', async () => {
    setConfig({ projects: [project] })
    const d = deps({ docs: [A], editors: 0 })
    const progress: CheckProgress[] = []
    const r = await runChecks(project, [A, B, C], (p) => progress.push(p), d)
    expect(r.boards.map((b) => [b.boardFile, b.status])).toEqual([[A, 'ok'], [B, 'ok'], [C, 'ok']])
    expect(d.checked).toEqual([[A, 'pcb_report-a'], [B, 'pcb_report-b'], [C, 'pcb_report-c']])
    expect(d.launched).toEqual([B, C])
    expect(d.closed).toBe(2)
    expect(r.boards[1].reportFile).toBe('/p/pcb_report-b.md')
    expect(progress.filter((p) => p.boardFile === B).map((p) => p.phase)).toEqual(['waiting', 'opening', 'checking', 'ok'])
    // per-board and total summaries persisted on the project
    const { getConfig } = await import('../../src/main/store')
    const saved = getConfig().projects[0]
    expect(Object.keys(saved.lastChecks ?? {})).toEqual([A, B, C])
    expect(saved.lastCheck?.summary).toEqual({ error: 3, warning: 0, info: 0 })
  })
  it('skips closed boards while a foreign editor holds the API, and reports checker errors', async () => {
    setConfig({ projects: [project] })
    const d = deps({ docs: [A], editors: 1, check: async (b: string) => (b === A ? { ok: false, error: 'boom' } : { ok: true, report: report(b) }) })
    const r = await runChecks(project, [A, B], () => {}, d)
    expect(r.boards[0]).toMatchObject({ boardFile: A, status: 'error', error: 'boom' })
    expect(r.boards[1].status).toBe('skipped')
    expect(r.boards[1].error).toMatch(/інша плата/)
    expect(d.launched).toEqual([])
  })
  it('gives up on a board KiCad does not open in time', async () => {
    setConfig({ projects: [project] })
    const d = deps({ docs: [], editors: 0, openTimeout: 0, launch: (b: string) => { d.launched.push(b); return { pid: 1 } as ChildProcess } })
    const r = await runChecks(project, [B], () => {}, d)
    expect(r.boards[0]).toMatchObject({ status: 'error', error: 'KiCad не відкрив плату вчасно' })
    expect(d.closed).toBe(1) // the editor we started is still closed at the end
  })
  it('uses the plain pcb_report stem for a single-board project', async () => {
    const single = { ...project, boards: [A] }
    setConfig({ projects: [single] })
    const d = deps({ docs: [A] })
    await runChecks(single, [A], () => {}, d)
    expect(d.checked).toEqual([[A, 'pcb_report']])
  })
})
