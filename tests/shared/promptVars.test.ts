import { describe, expect, it } from 'vitest'
import { PROMPT_VARS, promptVarValues, substitutePromptVars } from '@shared/promptVars'

describe('promptVars', () => {
  it('substitutes known $VARS and leaves unknown ones', () => {
    const v = promptVarValues({ id: 'i', name: 'board', dir: '/x', proFile: '', boardFile: '/x/b.kicad_pcb', createdAt: 0 })
    expect(substitutePromptVars('Перевір $PCB_BOARD_FILE у $PCB_PROJECT_DIR ($PCB_PROJECT_NAME) $OTHER $', v)).toBe('Перевір /x/b.kicad_pcb у /x (board) $OTHER $')
    expect(Object.keys(promptVarValues())).toEqual(PROMPT_VARS.map((p) => p.name))
    expect(promptVarValues().PCB_PROJECT_NAME).toBe('')
  })
})
