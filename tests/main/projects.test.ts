import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => '/tmp', isPackaged: false } }))

import { carryResumeTranscript, transcriptSlug } from '../../src/main/projects'

describe('transcript carry-over between config dirs', () => {
  it('slugs the cwd like Claude does', () => {
    expect(transcriptSlug('/home/andrii/Desktop/stm32h753_led')).toBe('-home-andrii-Desktop-stm32h753-led')
  })
  it('copies the session jsonl into the target config dir once', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'carry-'))
    const p = { id: 'p', name: 'b', dir: '/x/board', proFile: '', boardFile: '', createdAt: 0, sessions: [{ id: 'p', createdAt: 0, claudeSessionId: 'sid' }] }
    const from = join(tmp, 'global')
    mkdirSync(join(from, 'projects', '-x-board'), { recursive: true })
    writeFileSync(join(from, 'projects', '-x-board', 'sid.jsonl'), 'conv')
    const to = join(tmp, 'merged')
    expect(carryResumeTranscript(p, to, ['', from])).toBe(true)
    expect(readFileSync(join(to, 'projects', '-x-board', 'sid.jsonl'), 'utf8')).toBe('conv')
    expect(carryResumeTranscript(p, to, [])).toBe(true) // already there
    expect(carryResumeTranscript({ ...p, sessions: [{ id: 'p', createdAt: 0, claudeSessionId: 'other' }] }, to, [from])).toBe(false)
    expect(existsSync(join(to, 'projects', '-x-board', 'other.jsonl'))).toBe(false)
    expect(carryResumeTranscript({ ...p, sessions: [{ id: 'p', createdAt: 0 }] }, to, [from])).toBe(false) // nothing to carry
  })
  it('carries every session tab of the project', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'carry-'))
    const from = join(tmp, 'global')
    mkdirSync(join(from, 'projects', '-x-board'), { recursive: true })
    writeFileSync(join(from, 'projects', '-x-board', 'a.jsonl'), 'A')
    writeFileSync(join(from, 'projects', '-x-board', 'b.jsonl'), 'B')
    const p = { id: 'p', name: 'b', dir: '/x/board', proFile: '', boardFile: '', createdAt: 0, sessions: [{ id: 'p', createdAt: 0, claudeSessionId: 'a' }, { id: 's2', createdAt: 0, claudeSessionId: 'b' }] }
    const to = join(tmp, 'merged')
    expect(carryResumeTranscript(p, to, [from])).toBe(true)
    expect(readFileSync(join(to, 'projects', '-x-board', 'a.jsonl'), 'utf8')).toBe('A')
    expect(readFileSync(join(to, 'projects', '-x-board', 'b.jsonl'), 'utf8')).toBe('B')
  })
})
