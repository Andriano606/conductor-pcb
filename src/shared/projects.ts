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

/**
 * System prompt appended to Claude for a project chat: what the board is, which MCP tools
 * exist, and the check → fix → check loop it should follow.
 */
export function buildSystemPrompt(p: PcbProject, rulesUrl: string): string {
  return [
    `Ти працюєш з платою KiCad «${p.name}» у папці ${p.dir}. Файл плати: ${p.boardFile}.`,
    'Плата має бути відкрита в редакторі KiCad (pcbnew) з увімкненим API; усі зміни роби через MCP-інструменти сервера pcbagent, а не редагуванням файлу.',
    'Робочий цикл: run_checks → прочитай знахідки → виправ їх інструментами (move_footprint, route, add_via, unroute_net, plan_gnd_vias, set_track_width…) → save → знову run_checks. Повторюй, поки помилок не лишиться; попередження виправляй, якщо це не шкодить іншому.',
    `Правила і пороги перевірок живуть у бібліотеці правил за адресою ${rulesUrl} (GET /api/rules/<CODE> дає опис і спосіб виправлення). Код знахідки = код правила.`,
    'Координати в міліметрах, початок у лівому верхньому куті плати; шари F.Cu (верх) і B.Cu (низ, полігон землі). Не клади сигнали на B.Cu без потреби, кожен перехід на B.Cu ріже полігон.',
    'Перед великою зміною (переміщення багатьох компонентів, перерозведення ланцюга) коротко скажи, що збираєшся зробити. Після кожного етапу викликай kicad_drc або run_checks і повідомляй результат цифрами.',
    'Відповідай українською, коротко, без зайвих пояснень.'
  ].join('\n')
}
