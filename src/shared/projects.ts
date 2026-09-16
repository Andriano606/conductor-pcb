import type { PcbProject } from './types'

/** Pure helpers for the project list (persisted in AppConfig.projects). */

export function projectFromFiles(dir: string, files: string[], id: string, now = Date.now()): PcbProject | null {
  const pro = files.find((f) => f.endsWith('.kicad_pro'))
  const pcb = files.find((f) => f.endsWith('.kicad_pcb') && !f.includes('.backup'))
  if (!pro && !pcb) return null
  const base = (pro ?? pcb)!.replace(/\.kicad_(pro|pcb)$/, '')
  const sep = dir.endsWith('/') ? '' : '/'
  return {
    id,
    name: base,
    dir,
    proFile: pro ? `${dir}${sep}${pro}` : '',
    boardFile: pcb ? `${dir}${sep}${pcb}` : `${dir}${sep}${base}.kicad_pcb`,
    createdAt: now
  }
}

export function upsertProject(list: PcbProject[], p: PcbProject): PcbProject[] {
  const i = list.findIndex((x) => x.id === p.id || x.dir === p.dir)
  if (i === -1) return [...list, p]
  const next = [...list]
  next[i] = { ...next[i], ...p, id: next[i].id }
  return next
}

export function removeProject(list: PcbProject[], id: string): PcbProject[] {
  return list.filter((p) => p.id !== id)
}
