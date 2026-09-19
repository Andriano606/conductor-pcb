import { describe, expect, it } from 'vitest'
import { addSession, findSession, isBoardFile, isSkippedDir, migrateSessionProfiles, migrateSessions, projectFromFiles, reportStemFor, selectedBoards, removeProject, removeSession, renameSession, sessionLabel, updateSession, upsertProject } from '@shared/projects'

describe('projectFromFiles', () => {
  it('derives name and files from a folder listing, ignoring backups', () => {
    const p = projectFromFiles('/x/board', ['board.kicad_pro', 'board.kicad_pcb', 'board.kicad_pcb.backup-1', 'board.kicad_sch'], 'id1', 5)!
    expect(p).toMatchObject({ id: 'id1', name: 'board', dir: '/x/board', proFile: '/x/board/board.kicad_pro', boardFile: '/x/board/board.kicad_pcb', createdAt: 5 })
    // The first session tab shares the project id, so its transcript lives at chats/<projectId>.json.
    expect(p.sessions).toEqual([{ id: 'id1', createdAt: 5 }])
  })
  it('accepts a bare pcb and rejects a folder with neither', () => {
    expect(projectFromFiles('/y/', ['b.kicad_pcb'], 'i')?.boardFile).toBe('/y/b.kicad_pcb')
    expect(projectFromFiles('/z', ['readme.md'], 'i')).toBeNull()
  })
})

describe('upsertProject / removeProject', () => {
  const a = projectFromFiles('/a', ['a.kicad_pro'], 'ida')!
  const b = projectFromFiles('/b', ['b.kicad_pro'], 'idb')!
  it('appends new, replaces by dir keeping the original id, removes by id', () => {
    const l1 = upsertProject([], a)
    const l2 = upsertProject(l1, b)
    expect(l2.map((p) => p.id)).toEqual(['ida', 'idb'])
    const l3 = upsertProject(l2, { ...a, id: 'other', name: 'renamed' })
    expect(l3.map((p) => p.id)).toEqual(['ida', 'idb'])
    expect(l3[0].name).toBe('renamed')
    expect(removeProject(l3, 'ida').map((p) => p.id)).toEqual(['idb'])
  })
})

describe('chat sessions (tabs)', () => {
  const base = projectFromFiles('/a', ['a.kicad_pro'], 'pa', 1)!

  it('migrates a pre-tabs project into one session that keeps the project id and Claude fields', () => {
    const { sessions: _s, ...legacy } = base
    void _s
    const old = { ...legacy, claudeSessionId: 'cs', claudeModel: 'opus', claudeEffort: 'high' } as typeof base
    const m = migrateSessions(old)
    expect(m.sessions).toEqual([{ id: 'pa', createdAt: 1, claudeSessionId: 'cs', claudeModel: 'opus', claudeEffort: 'high' }])
    expect(m.claudeSessionId).toBeUndefined()
    expect(m.claudeModel).toBeUndefined()
    expect(migrateSessions(base)).toBe(base) // already migrated: untouched
  })

  it('adds, finds, updates, renames and removes sessions, never the last one', () => {
    const { list: l1, session } = addSession([base], 'pa', 's2', 7)
    expect(session).toEqual({ id: 's2', createdAt: 7 })
    expect(l1[0].sessions.map((s) => s.id)).toEqual(['pa', 's2'])
    expect(addSession([base], 'nope', 'x').session).toBeUndefined()
    expect(findSession(l1, 's2')).toEqual({ project: l1[0], session })
    expect(findSession(l1, 'zz')).toBeUndefined()

    const l2 = updateSession(l1, 's2', { claudeSessionId: 'cs2', id: 'ignored' })
    expect(l2[0].sessions[1]).toEqual({ id: 's2', createdAt: 7, claudeSessionId: 'cs2' })

    expect(sessionLabel(l2[0], 'pa')).toBe('Сесія 1')
    expect(sessionLabel(l2[0], 's2')).toBe('Сесія 2')
    const l3 = renameSession(l2, 's2', '  NRST reroute ')
    expect(sessionLabel(l3[0], 's2')).toBe('NRST reroute')
    expect(renameSession(l3, 's2', '   ')[0].sessions[1].title).toBeUndefined()

    const l4 = removeSession(l3, 'pa')
    expect(l4[0].sessions.map((s) => s.id)).toEqual(['s2'])
    expect(removeSession(l4, 's2')[0].sessions.map((s) => s.id)).toEqual(['s2'])
  })
})

describe('Claude config profiles per session tab', () => {
  const base = { id: 'p', name: 'b', dir: '/x', proFile: '', boardFile: '/x/b.kicad_pcb', createdAt: 1 }
  it('moves the legacy per-project set into every tab that has none, once', () => {
    const legacy = { ...base, claudeConfigProfileIds: ['a', 'b'], sessions: [{ id: 'p', createdAt: 1 }, { id: 's2', createdAt: 2, claudeConfigProfileIds: [] }] }
    const m = migrateSessionProfiles(legacy)
    expect(m.claudeConfigProfileIds).toBeUndefined()
    expect(m.newSessionProfileIds).toEqual(['a', 'b'])
    expect(m.sessions[0].claudeConfigProfileIds).toEqual(['a', 'b'])
    expect(m.sessions[1].claudeConfigProfileIds).toEqual([]) // a tab's own choice is never overwritten
    expect(migrateSessionProfiles(m)).toBe(m)
  })
  it('drops an empty legacy set without touching the tabs', () => {
    const m = migrateSessionProfiles({ ...base, claudeConfigProfileIds: [], sessions: [{ id: 'p', createdAt: 1 }] })
    expect(m).toEqual({ ...base, sessions: [{ id: 'p', createdAt: 1 }] })
  })
  it('a new tab starts with the set chosen last in the project, as its own copy', () => {
    const p = { ...base, newSessionProfileIds: ['a'], sessions: [{ id: 'p', createdAt: 1 }] }
    const { list, session } = addSession([p], 'p', 's2', 9)
    expect(session).toEqual({ id: 's2', createdAt: 9, claudeConfigProfileIds: ['a'] })
    expect(session!.claudeConfigProfileIds).not.toBe(p.newSessionProfileIds)
    expect(list[0].sessions[0].claudeConfigProfileIds).toBeUndefined()
    expect(addSession([{ ...p, newSessionProfileIds: [] }], 'p', 's3', 9).session).toEqual({ id: 's3', createdAt: 9 })
  })
})

describe('boards of a project', () => {
  it('filters board files and skipped dirs', () => {
    expect(isBoardFile('a.kicad_pcb')).toBe(true)
    expect(isBoardFile('a.kicad_pcb.backup')).toBe(false)
    expect(isBoardFile('_autosave-a.kicad_pcb')).toBe(false)
    expect(isBoardFile('a.kicad_sch')).toBe(false)
    expect(isSkippedDir('proj-backups')).toBe(true)
    expect(isSkippedDir('.git')).toBe(true)
    expect(isSkippedDir('boards')).toBe(false)
  })
  it('selects every board unless switched off, and names report files per board', () => {
    const p = { boardFile: '/d/a.kicad_pcb', boards: ['/d/a.kicad_pcb', '/d/sub/b.kicad_pcb'], checkBoards: { '/d/sub/b.kicad_pcb': false } }
    expect(selectedBoards(p)).toEqual(['/d/a.kicad_pcb'])
    expect(selectedBoards({ boardFile: '/d/a.kicad_pcb' })).toEqual(['/d/a.kicad_pcb'])
    expect(reportStemFor('/d/a.kicad_pcb', ['/d/a.kicad_pcb'])).toBe('pcb_report')
    expect(reportStemFor('/d/sub/b.kicad_pcb', p.boards)).toBe('pcb_report-b')
  })
})
