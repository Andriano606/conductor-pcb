import { describe, expect, it } from 'vitest'
import { projectFromFiles, removeProject, upsertProject } from '@shared/projects'

describe('projectFromFiles', () => {
  it('derives name and files from a folder listing, ignoring backups', () => {
    const p = projectFromFiles('/x/board', ['board.kicad_pro', 'board.kicad_pcb', 'board.kicad_pcb.backup-1', 'board.kicad_sch'], 'id1', 5)!
    expect(p).toMatchObject({ id: 'id1', name: 'board', dir: '/x/board', proFile: '/x/board/board.kicad_pro', boardFile: '/x/board/board.kicad_pcb', createdAt: 5 })
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
