import type { ChatSession, PcbProject } from './types'

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
    createdAt: now,
    // The first session shares the project id (same convention as the migration below).
    sessions: [{ id, createdAt: now }]
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

// ---- chat sessions (tabs) ------------------------------------------------------------

/**
 * Give a project loaded from an older config its `sessions` list: one session that reuses the
 * project id (so chats/<projectId>.json keeps working) and carries the legacy per-project
 * Claude fields. Projects that already have sessions are returned unchanged.
 */
export function migrateSessions(p: PcbProject): PcbProject {
  if (Array.isArray(p.sessions) && p.sessions.length) return p
  const { claudeSessionId, claudeModel, claudeEffort, ...rest } = p
  const first: ChatSession = { id: p.id, createdAt: p.createdAt }
  if (claudeSessionId) first.claudeSessionId = claudeSessionId
  if (claudeModel) first.claudeModel = claudeModel
  if (claudeEffort) first.claudeEffort = claudeEffort
  return { ...rest, sessions: [first] }
}

export function findSession(list: PcbProject[], sessionId: string): { project: PcbProject; session: ChatSession } | undefined {
  for (const project of list) {
    const session = project.sessions?.find((s) => s.id === sessionId)
    if (session) return { project, session }
  }
  return undefined
}

/** Append a new session to a project; returns the new list and the session (undefined if no such project). */
export function addSession(list: PcbProject[], projectId: string, id: string, now = Date.now()): { list: PcbProject[]; session?: ChatSession } {
  const p = list.find((x) => x.id === projectId)
  if (!p) return { list }
  const session: ChatSession = { id, createdAt: now }
  return { list: list.map((x) => (x.id === projectId ? { ...x, sessions: [...x.sessions, session] } : x)), session }
}

/** Remove a session; a project's last session is never removed. */
export function removeSession(list: PcbProject[], sessionId: string): PcbProject[] {
  return list.map((p) => (p.sessions.length > 1 && p.sessions.some((s) => s.id === sessionId) ? { ...p, sessions: p.sessions.filter((s) => s.id !== sessionId) } : p))
}

export function updateSession(list: PcbProject[], sessionId: string, patch: Partial<ChatSession>): PcbProject[] {
  return list.map((p) => (p.sessions.some((s) => s.id === sessionId) ? { ...p, sessions: p.sessions.map((s) => (s.id === sessionId ? { ...s, ...patch, id: s.id } : s)) } : p))
}

/** Set (or clear, with an empty/blank title) a session's user-chosen label. */
export function renameSession(list: PcbProject[], sessionId: string, title: string): PcbProject[] {
  return updateSession(list, sessionId, { title: title.trim() || undefined })
}

/** Display label for a session: its title, or "Сесія N" by position. */
export function sessionLabel(p: PcbProject, sessionId: string): string {
  const i = p.sessions.findIndex((s) => s.id === sessionId)
  return p.sessions[i]?.title || `Сесія ${i + 1}`
}
