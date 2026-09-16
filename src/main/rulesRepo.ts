import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync, unlinkSync } from 'fs'
import type { FSWatcher } from 'fs'
import { join } from 'path'
import type { EffectiveRule, Rule, RuleSource, RulesSnapshot } from '../shared/types'
import { applyOverrides, sortRules, validateRule } from '../shared/rules'
import { getConfig } from './store'

/**
 * Rule files live in three places:
 *  - the bundled `rules/` dir (ships with the app),
 *  - the global user rules dir (`config.userRulesDir`): rules for every project, a file with
 *    the same code as a bundled one replaces it,
 *  - per-project dirs under `<userData>/project-rules/<projectId>/`: rules imported into one
 *    project only. They are merged on top of the global library for that project's scope.
 * Which rules are *enabled* is a separate layer: global overrides (`config.overrides`, the
 * defaults for all projects) and per-project overrides (`PcbProject.ruleOverrides`).
 */

type Loaded = { rules: Rule[]; errors: { file: string; message: string }[] }

let cache: Loaded = { rules: [], errors: [] }
let projectCache = new Map<string, Loaded>()
let watchers: FSWatcher[] = []
let listeners: (() => void)[] = []
let debounce: NodeJS.Timeout | null = null
let projectRulesRootOverride: string | null = null

export function bundledRulesDir(): string {
  const packaged = join(process.resourcesPath ?? '', 'rules')
  if (app.isPackaged && existsSync(packaged)) return packaged
  return join(app.getAppPath(), 'rules')
}

/** Root of the per-project rule dirs; tests point it elsewhere. */
export function projectRulesRoot(): string {
  return projectRulesRootOverride ?? join(app.getPath('userData'), 'project-rules')
}
export function setProjectRulesRoot(dir: string | null): void {
  projectRulesRootOverride = dir
}
export function projectRulesDir(projectId: string): string {
  return join(projectRulesRoot(), projectId)
}

function readDir(dir: string, source: RuleSource): Loaded {
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

function readProjectDirs(): Map<string, Loaded> {
  const root = projectRulesRoot()
  const out = new Map<string, Loaded>()
  if (!existsSync(root)) return out
  for (const id of readdirSync(root)) {
    const dir = join(root, id)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const loaded = readDir(dir, 'project')
    if (loaded.rules.length || loaded.errors.length) out.set(id, loaded)
  }
  return out
}

export function reloadRules(): void {
  const cfg = getConfig()
  const b = readDir(bundledRulesDir(), 'bundled')
  const u = readDir(cfg.userRulesDir, 'user')
  const byCode = new Map<string, Rule>()
  for (const r of b.rules) byCode.set(r.code, r)
  for (const r of u.rules) byCode.set(r.code, r) // user file with the same code wins
  cache = { rules: sortRules([...byCode.values()]), errors: [...b.errors, ...u.errors] }
  projectCache = readProjectDirs()
  for (const l of listeners) l()
}

/** Global rules (bundled + user) plus, for a project, its own rules (same code: project wins). */
export function loadedRules(projectId?: string): Rule[] {
  const own = projectId ? projectCache.get(projectId) : undefined
  if (!own?.rules.length) return cache.rules
  const byCode = new Map<string, Rule>()
  for (const r of cache.rules) byCode.set(r.code, r)
  for (const r of own.rules) byCode.set(r.code, r)
  return sortRules([...byCode.values()])
}

/** Effective rules: global overrides, plus the project's own rules and overrides when `projectId` is given. */
export function getRules(projectId?: string): EffectiveRule[] {
  const cfg = getConfig()
  const proj = projectId ? cfg.projects.find((p) => p.id === projectId) : undefined
  return applyOverrides(loadedRules(projectId), cfg.overrides, proj?.ruleOverrides)
}

export function getRule(code: string, projectId?: string): EffectiveRule | undefined {
  return getRules(projectId).find((r) => r.code === code)
}

export function snapshot(projectId?: string): RulesSnapshot {
  const errors = [...cache.errors, ...(projectId ? (projectCache.get(projectId)?.errors ?? []) : [])]
  return {
    rules: getRules(projectId),
    errors,
    bundledDir: bundledRulesDir(),
    userRulesDir: getConfig().userRulesDir,
    ...(projectId ? { projectId, projectRulesDir: projectRulesDir(projectId) } : {})
  }
}

/**
 * Write (create or replace) a rule file: into the global user rules dir, or, with `projectId`,
 * into that project's own dir. Returns validation problems if any.
 */
export function saveUserRule(rule: Rule, projectId?: string): string[] {
  const problems = validateRule(rule)
  if (problems.length) return problems
  const dir = projectId ? projectRulesDir(projectId) : getConfig().userRulesDir
  mkdirSync(dir, { recursive: true })
  const { source: _s, file: _f, ...clean } = rule
  writeFileSync(join(dir, `${rule.code}.json`), JSON.stringify(clean, null, 2))
  reloadRules()
  return []
}

/** Delete a user rule file (global), or with `projectId` that project's own copy of the rule. */
export function deleteUserRule(code: string, projectId?: string): boolean {
  const pool = projectId ? (projectCache.get(projectId)?.rules ?? []) : cache.rules
  const r = pool.find((x) => x.code === code && x.source === (projectId ? 'project' : 'user'))
  if (!r?.file) return false
  unlinkSync(r.file)
  reloadRules()
  return true
}

/** Remove a deleted project's rules dir. */
export function deleteProjectRules(projectId: string): void {
  const dir = projectRulesDir(projectId)
  if (!existsSync(dir)) return
  rmSync(dir, { recursive: true, force: true })
  reloadRules()
}

export function onRulesChanged(fn: () => void): () => void {
  listeners.push(fn)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

export function startWatching(): void {
  stopWatching()
  const dirs: { dir: string; recursive: boolean }[] = [
    { dir: bundledRulesDir(), recursive: false },
    { dir: getConfig().userRulesDir, recursive: false },
    { dir: projectRulesRoot(), recursive: true }
  ]
  for (const { dir, recursive } of dirs) {
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        continue
      }
    }
    try {
      const w = watch(dir, { persistent: false, recursive }, () => {
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
