import { beforeAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'sessions-'))
vi.mock('electron', () => ({ app: { getPath: (k: string) => (k === 'home' ? join(tmp, 'home') : join(tmp, 'userData')), getAppPath: () => tmp, isPackaged: false } }))
// No real `claude` is spawned: the chat layer is a spy so we can assert which session ids it starts/kills.
vi.mock('../../src/main/claudeChat', () => ({
  startChat: vi.fn(),
  restartChat: vi.fn(),
  killChat: vi.fn(),
  deleteChatHistory: vi.fn(),
  chatRunning: vi.fn(() => false)
}))

import { startChat, killChat, deleteChatHistory, restartChat, chatRunning } from '../../src/main/claudeChat'
import { getConfig, initStore, removeClaudeProfile, setConfig } from '../../src/main/store'
import { closeChatSession, createChatSession, getSession, patchSession, rebuildAllConfigs, renameChatSession, setSessionProfiles, startSessionChat } from '../../src/main/projects'

const userData = join(tmp, 'userData')
// os.homedir() follows $HOME: merged configs are built from this empty home, never from the real ~/.claude
process.env.HOME = join(tmp, 'home')

describe('chat sessions in the main process', () => {
  beforeAll(() => {
    mkdirSync(userData, { recursive: true })
    mkdirSync(join(tmp, 'home'), { recursive: true })
    // A pre-tabs config: the project carries its Claude session on itself.
    writeFileSync(join(userData, 'config.json'), JSON.stringify({
      projects: [{ id: 'p1', name: 'b', dir: join(tmp, 'board'), proFile: '', boardFile: join(tmp, 'board', 'b.kicad_pcb'), createdAt: 3, claudeSessionId: 'legacy', claudeModel: 'opus' }]
    }))
    initStore(userData)
  })

  it('migrates the legacy project into one session on load', () => {
    const p = getConfig().projects[0]
    expect(p.sessions).toEqual([{ id: 'p1', createdAt: 3, claudeSessionId: 'legacy', claudeModel: 'opus' }])
    expect(p.claudeSessionId).toBeUndefined()
  })

  it('startSessionChat resumes the tab\'s own Claude session and model', () => {
    expect(startSessionChat('p1', userData)).toBe(true)
    expect(startChat).toHaveBeenCalledWith('p1', expect.objectContaining({ resume: 'legacy', model: 'opus', cwd: join(tmp, 'board') }))
    // ultracode lives in the CLI's per-process flag layer, so a restart has to carry the persisted choice
    patchSession('p1', { claudeUltracode: true })
    startSessionChat('p1', userData, true)
    expect(restartChat).toHaveBeenLastCalledWith('p1', expect.objectContaining({ ultracode: true }))
    vi.mocked(restartChat).mockClear()
    expect(startSessionChat('nope', userData)).toBe(false)
  })

  it('creates a tab, starts its chat and persists it; unknown project → undefined', () => {
    const s = createChatSession('p1', userData)!
    expect(s.id).toMatch(/[0-9a-f-]{36}/)
    expect(getConfig().projects[0].sessions.map((x) => x.id)).toEqual(['p1', s.id])
    expect(startChat).toHaveBeenLastCalledWith(s.id, expect.objectContaining({ resume: undefined }))
    expect(getSession(s.id)?.project.id).toBe('p1')
    expect(createChatSession('nope', userData)).toBeUndefined()
  })

  it('patches and renames a tab', () => {
    const id = getConfig().projects[0].sessions[1].id
    patchSession(id, { claudeSessionId: 'cs-new', claudeEffort: 'high', claudeUltracode: true })
    renameChatSession(id, ' Плани ')
    expect(getSession(id)?.session).toMatchObject({ claudeSessionId: 'cs-new', claudeEffort: 'high', claudeUltracode: true, title: 'Плани' })
    // ultracode is a boolean, so `false` must persist as a real value (it is the rollback state)
    patchSession(id, { claudeUltracode: false })
    expect(getSession(id)?.session.claudeUltracode).toBe(false)
  })

  it('closes a tab (kills + drops transcript) but never the last one', () => {
    const id = getConfig().projects[0].sessions[1].id
    expect(closeChatSession(id)).toBe(true)
    expect(killChat).toHaveBeenCalledWith(id)
    expect(deleteChatHistory).toHaveBeenCalledWith(id)
    expect(getConfig().projects[0].sessions.map((x) => x.id)).toEqual(['p1'])
    expect(closeChatSession('p1')).toBe(false)
    expect(closeChatSession('ghost')).toBe(false)
    expect(getConfig().projects[0].sessions).toHaveLength(1)
  })

  it('profiles are a per-tab knob: changing them restarts that tab only, the others keep their set', () => {
    setConfig({ claudeProfiles: [{ id: 'pr', name: 'x', path: join(tmp, 'nope'), env: [{ key: 'FOO', value: '1' }], createdAt: 0, updatedAt: 0 }] })
    const s2 = createChatSession('p1', userData)!
    vi.mocked(chatRunning).mockReturnValue(true) // every tab of the project is running
    vi.mocked(restartChat).mockClear()
    expect(setSessionProfiles(s2.id, ['pr'], userData)).toBe(true)
    expect(restartChat).toHaveBeenCalledTimes(1)
    const mergedDir = join(userData, 'claude-configs', s2.id)
    expect(restartChat).toHaveBeenCalledWith(s2.id, expect.objectContaining({ profileLabel: 'x', env: { FOO: '1', CLAUDE_CONFIG_DIR: mergedDir } }))
    expect(existsSync(mergedDir)).toBe(true)
    expect(getSession(s2.id)?.session).toMatchObject({ claudeConfigProfileIds: ['pr'], mergedConfigDir: mergedDir })
    // the first tab still runs on the plain ~/.claude, also after its own restart
    expect(getSession('p1')?.session.claudeConfigProfileIds).toBeUndefined()
    startSessionChat('p1', userData, true)
    expect(restartChat).toHaveBeenLastCalledWith('p1', expect.objectContaining({ profileLabel: 'стандартний ~/.claude', env: {} }))
    expect(setSessionProfiles('nope', [], userData)).toBe(false)
  })

  it('a new tab starts with the set chosen last; switching a tab back to ~/.claude touches nothing else', () => {
    const s2 = getConfig().projects[0].sessions[1]
    const s3 = createChatSession('p1', userData)!
    expect(s3.claudeConfigProfileIds).toEqual(['pr'])
    vi.mocked(restartChat).mockClear()
    expect(setSessionProfiles(s3.id, [], userData)).toBe(true)
    expect(vi.mocked(restartChat).mock.calls.map((c) => c[0])).toEqual([s3.id])
    expect(getSession(s3.id)?.session.claudeConfigProfileIds).toEqual([])
    expect(getSession(s2.id)?.session.claudeConfigProfileIds).toEqual(['pr'])
    expect(getConfig().projects[0].newSessionProfileIds).toEqual([])
  })

  it('an idle tab is not started by a profile change, and rebuild restarts only running tabs with profiles', () => {
    const [, s2, s3] = getConfig().projects[0].sessions
    vi.mocked(chatRunning).mockReturnValue(false)
    vi.mocked(restartChat).mockClear()
    vi.mocked(startChat).mockClear()
    setSessionProfiles(s3.id, ['pr'], userData)
    expect(restartChat).not.toHaveBeenCalled()
    expect(startChat).not.toHaveBeenCalled()
    vi.mocked(chatRunning).mockImplementation((id) => id === s2.id || id === 'p1')
    expect(rebuildAllConfigs(userData)).toBe(2) // s2 and s3 use a profile, p1 does not
    expect(vi.mocked(restartChat).mock.calls.map((c) => c[0])).toEqual([s2.id])
  })

  it('removing a profile drops it from every tab and from the new-tab default', () => {
    removeClaudeProfile('pr')
    const p = getConfig().projects[0]
    expect(p.newSessionProfileIds).toEqual([])
    expect(p.sessions.map((s) => s.claudeConfigProfileIds ?? [])).toEqual([[], [], []])
  })

  it('closing a tab removes its merged config dir', () => {
    const s2 = getConfig().projects[0].sessions[1]
    const dir = join(userData, 'claude-configs', s2.id)
    expect(existsSync(dir)).toBe(true)
    expect(closeChatSession(s2.id, userData)).toBe(true)
    expect(existsSync(dir)).toBe(false)
  })
})
