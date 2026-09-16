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
    const p = { id: 'p', name: 'b', dir: '/x/board', proFile: '', boardFile: '', createdAt: 0, claudeSessionId: 'sid' }
    const from = join(tmp, 'global')
    mkdirSync(join(from, 'projects', '-x-board'), { recursive: true })
    writeFileSync(join(from, 'projects', '-x-board', 'sid.jsonl'), 'conv')
    const to = join(tmp, 'merged')
    expect(carryResumeTranscript(p, to, ['', from])).toBe(true)
    expect(readFileSync(join(to, 'projects', '-x-board', 'sid.jsonl'), 'utf8')).toBe('conv')
    expect(carryResumeTranscript(p, to, [])).toBe(true) // already there
    expect(carryResumeTranscript({ ...p, claudeSessionId: 'other' }, to, [from])).toBe(false)
    expect(existsSync(join(to, 'projects', '-x-board', 'other.jsonl'))).toBe(false)
  })
})
