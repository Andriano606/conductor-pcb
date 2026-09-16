import type { PcbProject } from './types'

export interface PromptVar {
  name: string
  description: string
}

/** Variables offered in the prompt editor's `$` autocomplete and substituted on insert. */
export const PROMPT_VARS: PromptVar[] = [
  { name: 'PCB_PROJECT_NAME', description: 'Назва проекту (плати)' },
  { name: 'PCB_PROJECT_DIR', description: 'Папка проекту KiCad' },
  { name: 'PCB_BOARD_FILE', description: 'Файл плати .kicad_pcb' }
]

export function promptVarValues(project?: PcbProject): Record<string, string> {
  return {
    PCB_PROJECT_NAME: project?.name ?? '',
    PCB_PROJECT_DIR: project?.dir ?? '',
    PCB_BOARD_FILE: project?.boardFile ?? ''
  }
}

/** Replace every $TOKEN with its value; unknown tokens stay untouched. */
export function substitutePromptVars(text: string, values: Record<string, string>): string {
  return text.replace(/\$([A-Z_][A-Z0-9_]*)/g, (m, name: string) => (name in values ? values[name] : m))
}
