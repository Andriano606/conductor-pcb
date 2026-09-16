import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, unlinkSync } from 'fs'
import type { FSWatcher } from 'fs'
import { join } from 'path'
import type { EffectiveRule, Rule, RulesSnapshot } from '../shared/types'
import { applyOverrides, sortRules, validateRule } from '../shared/rules'
import { getConfig } from './store'

/**
 * Rule files live in two places:
 *   bundled  — <app>/rules/*.json (shipped with the app, read-only)
 *   user     — config.userRulesDir/*.json (editable; same code overrides the bundled one)
 * Both directories are watched; any change re-reads everything and notifies listeners.
 */

let cache: { rules: Rule[]; errors: { file: string; message: string }[] } = { rules: [], errors: [] }
let watchers: FSWatcher[] = []
let listeners: (() => void)[] = []
let debounce: NodeJS.Timeout | null = null

export function bundledRulesDir(): string {
  // Packaged: extraResources puts it next to the asar. Dev: repo root.
  const packaged = join(process.resourcesPath ?? '', 'rules')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return join(app.getAppPath(), 'rules')
}

function readDir(dir: string, source: 'bundled' | 'user'): { rules: Rule[]; errors: { file: string; message: string }[] } {
  const rules: Rule[] = []
  const errors: { file: string; message: string }[] = []
  if (!existsSync(dir)) return { rules, errors }
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue
    const file = join(dir, name)
    try {
      if (!statSync(file).isFile()) continue
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const problems = validateRule(parsed)
      if (problems.length) {
        errors.push({ file, message: problems.join('; ') })
        continue
      }
      rules.push({ ...(parsed as Rule), source, file })
    } catch (e) {
      errors.push({ file, message: (e as Error).message })
    }
  }
  return { rules, errors }
}

export function reloadRules(): void {
  const cfg = getConfig()
  const b = readDir(bundledRulesDir(), 'bundled')
  const u = readDir(cfg.userRulesDir, 'user')
  const byCode = new Map<string, Rule>()
  for (const r of b.rules) byCode.set(r.code, r)
  for (const r of u.rules) byCode.set(r.code, r) // user file with the same code wins
  cache = { rules: sortRules([...byCode.values()]), errors: [...b.errors, ...u.errors] }
  for (const l of listeners) l()
}

/** Effective rules: global overrides, plus the project's own when `projectId` is given. */
export function getRules(projectId?: string): EffectiveRule[] {
  const cfg = getConfig()
  const proj = projectId ? cfg.projects.find((p) => p.id === projectId) : undefined
  return applyOverrides(cache.rules, cfg.overrides, proj?.ruleOverrides)
}

export function getRule(code: string, projectId?: string): EffectiveRule | undefined {
  return getRules(projectId).find((r) => r.code === code)
}

export function snapshot(projectId?: string): RulesSnapshot {
  return { rules: getRules(projectId), errors: cache.errors, bundledDir: bundledRulesDir(), userRulesDir: getConfig().userRulesDir }
}

/** Write (create or replace) a user rule file. Returns validation problems if any. */
export function saveUserRule(rule: Rule): string[] {
  const problems = validateRule(rule)
  if (problems.length) return problems
  const dir = getConfig().userRulesDir
  mkdirSync(dir, { recursive: true })
  const { source: _s, file: _f, ...clean } = rule
  writeFileSync(join(dir, `${rule.code}.json`), JSON.stringify(clean, null, 2))
  reloadRules()
  return []
}

export function deleteUserRule(code: string): boolean {
  const r = cache.rules.find((x) => x.code === code && x.source === 'user')
  if (!r?.file) return false
  unlinkSync(r.file)
  reloadRules()
  return true
}

export function onRulesChanged(fn: () => void): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

export function startWatching(): void {
  stopWatching()
  const dirs = [bundledRulesDir(), getConfig().userRulesDir]
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        continue
      }
    }
    try {
      const w = watch(dir, { persistent: false }, () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(reloadRules, 150)
      })
      watchers.push(w)
    } catch (e) {
      console.error('watch failed for', dir, e)
    }
  }
}

export function stopWatching(): void {
  for (const w of watchers) w.close()
  watchers = []
}
