import type {
  AppConfig,
  CheckerConfigExport,
  EffectiveRule,
  PcbProject,
  Rule,
  RuleOverride,
  Scene,
  SceneItem,
  Severity
} from './types'
import { CATEGORIES } from './types'

const SEVERITIES: Severity[] = ['error', 'warning', 'info']
const CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/

/** Validate a parsed rule file. Returns a list of human-readable problems (empty = valid). */
export function validateRule(r: unknown): string[] {
  const p: string[] = []
  if (!r || typeof r !== 'object') return ['правило має бути JSON-об’єктом']
  const o = r as Record<string, unknown>
  if (typeof o.code !== 'string' || !CODE_RE.test(o.code)) p.push('code: великі літери, цифри, підкреслення, 3–64 символи')
  for (const k of ['title', 'summary', 'description', 'why', 'fix']) {
    if (typeof o[k] !== 'string' || !(o[k] as string).trim()) p.push(`${k}: обов’язковий текст`)
  }
  if (!CATEGORIES.some((c) => c.id === o.category)) p.push(`category: одне з ${CATEGORIES.map((c) => c.id).join(', ')}`)
  if (!SEVERITIES.includes(o.severity as Severity)) p.push('severity: error | warning | info')
  if (!Array.isArray(o.params)) p.push('params: масив (може бути порожнім)')
  else {
    ;(o.params as unknown[]).forEach((prm, i) => {
      const q = prm as Record<string, unknown>
      if (!q || typeof q.key !== 'string' || !q.key) p.push(`params[${i}].key: обов’язковий`)
      if (!q || typeof q.label !== 'string') p.push(`params[${i}].label: обов’язковий`)
      if (!q || q.default === undefined) p.push(`params[${i}].default: обов’язковий`)
    })
  }
  if (!o.checker || typeof o.checker !== 'object') p.push('checker: об’єкт {engine, function?}')
  else {
    const eng = (o.checker as Record<string, unknown>).engine
    if (!['pcbagent', 'kicad-drc', 'manual'].includes(eng as string)) p.push('checker.engine: pcbagent | kicad-drc | manual')
  }
  const eng = o.checker && typeof o.checker === 'object' ? (o.checker as Record<string, unknown>).engine : undefined
  if (o.check !== undefined) {
    const c = o.check as Record<string, unknown>
    if (!c || typeof c !== 'object' || typeof c.kernel !== 'string' || !c.kernel) p.push('check.kernel: назва ядра перевірки (рядок)')
    else if (!/^[a-z][a-z0-9_]*$/.test(c.kernel)) p.push('check.kernel: малі літери, цифри, підкреслення')
    if (c && c.emits !== undefined && (typeof c.emits !== 'string' || !CODE_RE.test(c.emits))) p.push('check.emits: код знахідки у форматі коду правила')
    if (c && c.args !== undefined && (typeof c.args !== 'object' || Array.isArray(c.args))) p.push('check.args: об’єкт ключ → значення')
  } else if (eng === 'pcbagent') {
    p.push('check: для рушія pcbagent потрібен блок {kernel, emits?, args?}')
  }
  if (!Array.isArray(o.tags)) p.push('tags: масив рядків')
  if (!Array.isArray(o.references)) p.push('references: масив {title, url?}')
  const ex = o.examples as Record<string, unknown> | undefined
  if (!ex || typeof ex !== 'object') p.push('examples: {bad, good}')
  else {
    for (const k of ['bad', 'good']) p.push(...validateScene(ex[k], `examples.${k}`))
  }
  if (typeof o.enabled !== 'boolean') p.push('enabled: true | false')
  return p
}

export function validateScene(s: unknown, path: string): string[] {
  const p: string[] = []
  if (!s || typeof s !== 'object') return [`${path}: об’єкт сцени`]
  const o = s as Record<string, unknown>
  if (typeof o.w !== 'number' || typeof o.h !== 'number' || o.w <= 0 || o.h <= 0) p.push(`${path}.w/h: додатні числа`)
  if (o.verdict !== 'bad' && o.verdict !== 'good') p.push(`${path}.verdict: bad | good`)
  if (typeof o.caption !== 'string') p.push(`${path}.caption: рядок`)
  if (!Array.isArray(o.items)) p.push(`${path}.items: масив`)
  else {
    ;(o.items as SceneItem[]).forEach((it, i) => {
      if (!it || typeof it !== 'object' || typeof (it as { t?: unknown }).t !== 'string') p.push(`${path}.items[${i}]: елемент з полем t`)
      else if (it.t === 'track' && (!Array.isArray(it.pts) || it.pts.length < 2)) p.push(`${path}.items[${i}]: track потребує >= 2 точок`)
    })
  }
  return p
}

/** Apply user overrides to a rule. */
export function applyOverride(rule: Rule, ov: RuleOverride | undefined): EffectiveRule {
  const params: Record<string, number | string | boolean> = {}
  for (const prm of rule.params) params[prm.key] = prm.default
  if (ov?.params) {
    for (const [k, v] of Object.entries(ov.params)) {
      if (k in params) params[k] = v
    }
  }
  return {
    ...rule,
    effective: {
      enabled: ov?.enabled ?? rule.enabled,
      severity: ov?.severity ?? rule.severity,
      params
    }
  }
}

export function applyOverrides(rules: Rule[], overrides: AppConfig['overrides'], projectOverrides?: Record<string, RuleOverride>): EffectiveRule[] {
  return rules.map((r) => applyOverride(r, mergeOverride(overrides[r.code], projectOverrides?.[r.code])))
}

/** Project override on top of the global one (params merge key by key). */
export function mergeOverride(global: RuleOverride | undefined, project: RuleOverride | undefined): RuleOverride | undefined {
  if (!global && !project) return undefined
  return { ...(global ?? {}), ...(project ?? {}), params: { ...(global?.params ?? {}), ...(project?.params ?? {}) } }
}

/** Set/merge one project's override for a rule; `null` removes it. */
export function withProjectOverride(projects: PcbProject[], projectId: string, code: string, ov: RuleOverride | null): PcbProject[] {
  return projects.map((p) => {
    if (p.id !== projectId) return p
    const next = { ...(p.ruleOverrides ?? {}) }
    if (ov === null) delete next[code]
    else next[code] = { ...(next[code] ?? {}), ...ov, params: { ...(next[code]?.params ?? {}), ...(ov.params ?? {}) } }
    return { ...p, ruleOverrides: next }
  })
}

/** Sort: category order, then severity, then code. */
export function sortRules<T extends Rule>(rules: T[]): T[] {
  const cat = new Map(CATEGORIES.map((c, i) => [c.id, i]))
  const sev = new Map(SEVERITIES.map((s, i) => [s, i]))
  return [...rules].sort(
    (a, b) =>
      (cat.get(a.category) ?? 99) - (cat.get(b.category) ?? 99) ||
      (sev.get(a.severity) ?? 9) - (sev.get(b.severity) ?? 9) ||
      a.code.localeCompare(b.code)
  )
}

/** Case-insensitive search over code, title, summary, tags. */
export function filterRules<T extends Rule>(rules: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return rules
  return rules.filter((r) =>
    [r.code, r.title, r.summary, ...r.tags].some((s) => s.toLowerCase().includes(q))
  )
}

/**
 * Flatten effective rules into what the Python checker (pcbagent.checks.CheckConfig)
 * reads: threshold keys at top level, disabled rule codes in `ignore_codes`, and
 * severity overrides in `severities`. Later rules never overwrite an earlier
 * value for the same key unless it differs from the default (first explicit wins).
 */
export function exportCheckerConfig(rules: EffectiveRule[], now = new Date()): CheckerConfigExport {
  const out: CheckerConfigExport = {
    generated: now.toISOString(),
    source: 'pcb-rules-library',
    ignore_codes: [],
    severities: {}
  }
  const setKeys = new Set<string>()
  for (const r of rules) {
    if (!r.effective.enabled) out.ignore_codes.push(r.code)
    if (r.effective.severity !== r.severity) out.severities[r.code] = r.effective.severity
    for (const prm of r.params) {
      const v = r.effective.params[prm.key]
      const explicit = v !== prm.default
      if (!setKeys.has(prm.key) || explicit) {
        out[prm.key] = v
        if (explicit) setKeys.add(prm.key)
      }
    }
  }
  out.ignore_codes.sort()
  return out
}

/** Merge a partial config into the current one (shallow, with nested api/overrides merge). */
export function mergeConfig(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
  const next: AppConfig = {
    ...base,
    ...patch,
    api: { ...base.api, ...(patch.api ?? {}) },
    overrides: { ...base.overrides }
  }
  if (patch.overrides) {
    for (const [code, ov] of Object.entries(patch.overrides)) {
      if (ov === null || ov === undefined) delete next.overrides[code]
      else next.overrides[code] = { ...(base.overrides[code] ?? {}), ...ov, params: { ...(base.overrides[code]?.params ?? {}), ...(ov.params ?? {}) } }
    }
  }
  if (!Number.isInteger(next.api.port) || next.api.port < 1 || next.api.port > 65535) next.api.port = base.api.port
  if (!Array.isArray(next.projects)) next.projects = base.projects ?? []
  if (!Array.isArray(next.customPrompts)) next.customPrompts = base.customPrompts ?? []
  if (!Array.isArray(next.claudeProfiles)) next.claudeProfiles = base.claudeProfiles ?? []
  if (!Array.isArray(next.lastUsage)) next.lastUsage = base.lastUsage ?? []
  return next
}

export function defaultConfig(homeDir: string): AppConfig {
  return {
    userRulesDir: `${homeDir}/.config/conductor-pcb/rules`,
    api: { enabled: true, port: 4817, host: '127.0.0.1' },
    overrides: {},
    projects: [],
    claudeArgs: '--dangerously-skip-permissions',
    pcbagentDir: `${homeDir}/Documents/Embedded/kicad-ai-layout`,
    pythonPath: `${homeDir}/Documents/Embedded/kicad-ai-layout/.venv/bin/python`,
    kicadCli: `${homeDir}/.local/bin/kicad-cli`,
    kicadLauncher: `${homeDir}/Applications/kicad-10.0.6-x86_64.AppImage`,
    customPrompts: [],
    claudeProfiles: [],
    lastUsage: []
  }
}

/** Bounding box helper for scenes (used by tests and the renderer's auto-fit). */
export function sceneBounds(s: Scene): { w: number; h: number } {
  return { w: s.w, h: s.h }
}
