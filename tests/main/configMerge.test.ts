import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildMergedConfig, deepMerge, isClaudeConfigDir } from '../../src/main/configMerge'

describe('deepMerge', () => {
  it('merges objects recursively and lets the overlay replace everything else', () => {
    expect(deepMerge({ a: { x: 1, y: 2 }, b: [1], c: 1 }, { a: { y: 3, z: 4 }, b: [2], d: 5 })).toEqual({ a: { x: 1, y: 3, z: 4 }, b: [2], c: 1, d: 5 })
    expect(deepMerge({ a: 1 }, undefined)).toEqual({ a: 1 })
    expect(deepMerge({ a: { x: 1 } }, { a: 'str' })).toEqual({ a: 'str' })
  })
})

describe('buildMergedConfig', () => {
  it('overlays skills/commands, deep-merges settings, concatenates CLAUDE.md and keeps conversation dirs', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cfg-'))
    const home = join(tmp, 'home')
    const globalDir = join(home, '.claude')
    mkdirSync(join(globalDir, 'skills', 'base'), { recursive: true })
    writeFileSync(join(globalDir, 'skills', 'base', 'SKILL.md'), 'base')
    writeFileSync(join(globalDir, 'settings.json'), JSON.stringify({ permissions: { allow: ['a'] }, model: 'x' }))
    writeFileSync(join(globalDir, 'CLAUDE.md'), 'GLOBAL')
    const overlay = join(tmp, 'overlay')
    mkdirSync(join(overlay, 'skills', 'pcb'), { recursive: true })
    writeFileSync(join(overlay, 'skills', 'pcb', 'SKILL.md'), 'pcb')
    mkdirSync(join(overlay, 'commands'), { recursive: true })
    writeFileSync(join(overlay, 'commands', 'go.md'), 'go')
    writeFileSync(join(overlay, 'settings.json'), JSON.stringify({ permissions: { allow: ['b'] }, effort: 'high' }))
    writeFileSync(join(overlay, 'CLAUDE.md'), 'OVERLAY')
    expect(isClaudeConfigDir(overlay)).toBe(true)
    expect(isClaudeConfigDir(join(tmp, 'nope'))).toBe(false)

    const merged = join(tmp, 'merged')
    mkdirSync(join(merged, 'projects', 'p'), { recursive: true })
    writeFileSync(join(merged, 'projects', 'p', 'conv.jsonl'), 'keep me')
    buildMergedConfig([{ id: '1', name: 'PCB', path: overlay, createdAt: 0 }], merged, home)

    expect(readFileSync(join(merged, 'skills', 'base', 'SKILL.md'), 'utf8')).toBe('base')
    expect(readFileSync(join(merged, 'skills', 'pcb', 'SKILL.md'), 'utf8')).toBe('pcb')
    expect(existsSync(join(merged, 'commands', 'go.md'))).toBe(true)
    expect(JSON.parse(readFileSync(join(merged, 'settings.json'), 'utf8'))).toEqual({ permissions: { allow: ['b'] }, model: 'x', effort: 'high' })
    const md = readFileSync(join(merged, 'CLAUDE.md'), 'utf8')
    expect(md.startsWith('GLOBAL')).toBe(true)
    expect(md).toContain('# Конфіг: PCB')
    expect(md).toContain('OVERLAY')
    expect(readFileSync(join(merged, 'projects', 'p', 'conv.jsonl'), 'utf8')).toBe('keep me')
  })
})
