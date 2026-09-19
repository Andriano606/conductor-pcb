import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => '/tmp', isPackaged: false } }))

import { carryResumeTranscript, parseCheckerOutput, transcriptSlug } from '../../src/main/projects'

describe('transcript carry-over between config dirs', () => {
  it('slugs the cwd like Claude does', () => {
    expect(transcriptSlug('/home/andrii/Desktop/stm32h753_led')).toBe('-home-andrii-Desktop-stm32h753-led')
  })
  it('copies the session jsonl into the target config dir once', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'carry-'))
    const from = join(tmp, 'global')
    mkdirSync(join(from, 'projects', '-x-board'), { recursive: true })
    writeFileSync(join(from, 'projects', '-x-board', 'sid.jsonl'), 'conv')
    const to = join(tmp, 'merged')
    expect(carryResumeTranscript('/x/board', 'sid', to, ['', from])).toBe(true)
    expect(readFileSync(join(to, 'projects', '-x-board', 'sid.jsonl'), 'utf8')).toBe('conv')
    expect(carryResumeTranscript('/x/board', 'sid', to, [])).toBe(true) // already there
    expect(carryResumeTranscript('/x/board', 'other', to, [from])).toBe(false)
    expect(existsSync(join(to, 'projects', '-x-board', 'other.jsonl'))).toBe(false)
    expect(carryResumeTranscript('/x/board', undefined, to, [from])).toBe(false) // nothing to carry
  })
  it('carries one tab only: the other tabs of the project stay where they are', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'carry-'))
    const from = join(tmp, 'global')
    mkdirSync(join(from, 'projects', '-x-board'), { recursive: true })
    writeFileSync(join(from, 'projects', '-x-board', 'a.jsonl'), 'A')
    writeFileSync(join(from, 'projects', '-x-board', 'b.jsonl'), 'B')
    const to = join(tmp, 'merged')
    expect(carryResumeTranscript('/x/board', 'a', to, [from])).toBe(true)
    expect(readFileSync(join(to, 'projects', '-x-board', 'a.jsonl'), 'utf8')).toBe('A')
    expect(existsSync(join(to, 'projects', '-x-board', 'b.jsonl'))).toBe(false)
  })
  it('a newer copy elsewhere replaces the stale one (profiles toggled off and on again)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'carry-'))
    const globalDir = join(tmp, 'global')
    const merged = join(tmp, 'merged')
    for (const d of [globalDir, merged]) mkdirSync(join(d, 'projects', '-x-board'), { recursive: true })
    const stale = join(globalDir, 'projects', '-x-board', 'sid.jsonl')
    const fresh = join(merged, 'projects', '-x-board', 'sid.jsonl')
    writeFileSync(stale, 'old')
    writeFileSync(fresh, 'old+new')
    utimesSync(stale, new Date(1000), new Date(1000))
    utimesSync(fresh, new Date(5000), new Date(5000))
    expect(carryResumeTranscript('/x/board', 'sid', globalDir, [merged])).toBe(true)
    expect(readFileSync(stale, 'utf8')).toBe('old+new')
    // and an older candidate never overwrites the newer target
    writeFileSync(fresh, 'older')
    utimesSync(fresh, new Date(1000), new Date(1000))
    expect(carryResumeTranscript('/x/board', 'sid', globalDir, [merged])).toBe(true)
    expect(readFileSync(stale, 'utf8')).toBe('old+new')
  })
})

describe('parseCheckerOutput', () => {
  it('takes the JSON report from the last stdout line and points at the report files that exist', () => {
    const out = 'log line\n{"board":"b.kicad_pcb","generated":"g","summary":{"error":1,"warning":0,"info":0},"findings":[{"code":"X","severity":"error","title":"t"}]}\n'
    const r = parseCheckerOutput(out, '/x/board', (f) => f.endsWith('pcb_report.md'))
    expect(r.ok).toBe(true)
    expect(r.report?.findings).toHaveLength(1)
    expect(r.reportFile).toBe('/x/board/pcb_report.md')
    expect(r.reportJson).toBeUndefined()
    const both = parseCheckerOutput(out, '/x/board', () => true)
    expect(both.reportJson).toBe('/x/board/pcb_report.json')
  })
  it('fails on non-JSON or a report without findings', () => {
    expect(parseCheckerOutput('oops', '/x', () => true).ok).toBe(false)
    expect(parseCheckerOutput('{"board":"b"}', '/x', () => true).ok).toBe(false)
  })
})
