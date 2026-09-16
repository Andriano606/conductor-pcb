import { create } from 'zustand'
import type { AppConfig, Category, EffectiveRule, FindingsReport, KicadStatus, PcbProject, RuleOverride, RulesSnapshot, Severity } from '@shared/types'
import type { ApiStatus } from '../../preload'

interface State {
  rules: EffectiveRule[]
  errors: RulesSnapshot['errors']
  bundledDir: string
  userRulesDir: string
  config: AppConfig | null
  configPath: string
  api: ApiStatus
  report: FindingsReport | null
  selected: string | null
  query: string
  category: Category | 'all'
  onlyEnabled: boolean
  settingsOpen: boolean
  importOpen: boolean
  loaded: boolean
  // ---- Conductor PCB
  view: 'chat' | 'rules'
  /** Whose thresholds the rules view edits: 'global' or a project id. */
  ruleScope: string
  projects: PcbProject[]
  kicad: Record<string, KicadStatus>
  checking: Record<string, boolean>
  addError: string | null

  load: () => Promise<void>
  applySnapshot: (s: RulesSnapshot) => void
  select: (code: string) => void
  setQuery: (q: string) => void
  setCategory: (c: Category | 'all') => void
  setOnlyEnabled: (v: boolean) => void
  setSettingsOpen: (v: boolean) => void
  setImportOpen: (v: boolean) => void
  setOverride: (code: string, ov: RuleOverride) => Promise<void>
  resetOverride: (code: string) => Promise<void>
  setConfig: (patch: Partial<AppConfig>) => Promise<void>
  setReport: (r: FindingsReport | null) => void
  reload: () => Promise<void>
  setView: (v: 'chat' | 'rules') => void
  setRuleScope: (scope: string) => Promise<void>
  setProjects: (p: PcbProject[]) => void
  addProject: () => Promise<void>
  deleteProject: (id: string) => Promise<void>
  selectProject: (id: string) => Promise<void>
  refreshKicad: (id: string) => Promise<void>
  runCheck: (id: string) => Promise<void>
}

export const useStore = create<State>((set, get) => ({
  rules: [],
  errors: [],
  bundledDir: '',
  userRulesDir: '',
  config: null,
  configPath: '',
  api: { running: false, url: '' },
  report: null,
  selected: null,
  query: '',
  category: 'all',
  onlyEnabled: false,
  settingsOpen: false,
  importOpen: false,
  loaded: false,
  view: (localStorage.getItem('conductor-pcb.view') as 'chat' | 'rules') || 'chat',
  ruleScope: 'global',
  projects: [],
  kicad: {},
  checking: {},
  addError: null,

  load: async () => {
    const [snap, config, configPath, api, report, projects] = await Promise.all([
      window.api.getRules(),
      window.api.getConfig(),
      window.api.configPath(),
      window.api.apiStatus(),
      window.api.lastFindings(),
      window.api.listProjects()
    ])
    const selected = config.lastRuleCode && snap.rules.some((r) => r.code === config.lastRuleCode)
      ? config.lastRuleCode
      : (snap.rules[0]?.code ?? null)
    set({ ...snapToState(snap), config, configPath, api, report, selected, projects, loaded: true })
  },
  setView: (view) => {
    localStorage.setItem('conductor-pcb.view', view)
    set({ view })
  },
  setProjects: (projects) => set({ projects }),
  addProject: async () => {
    const r = await window.api.addProject()
    if (!r) return
    if ('error' in r) {
      set({ addError: r.error })
      setTimeout(() => set({ addError: null }), 5000)
      return
    }
    const [projects, config] = await Promise.all([window.api.listProjects(), window.api.getConfig()])
    set({ projects, config, view: 'chat' })
  },
  deleteProject: async (id) => {
    await window.api.deleteProject(id)
    const [projects, config] = await Promise.all([window.api.listProjects(), window.api.getConfig()])
    set({ projects, config })
  },
  selectProject: async (id) => {
    const config = await window.api.selectProject(id)
    set({ config, view: 'chat' })
  },
  refreshKicad: async (id) => {
    const st = await window.api.kicadStatus(id)
    set({ kicad: { ...get().kicad, [id]: st } })
  },
  runCheck: async (id) => {
    set({ checking: { ...get().checking, [id]: true } })
    try {
      const r = await window.api.checkProject(id)
      const projects = await window.api.listProjects()
      const report = await window.api.lastFindings()
      set({ projects, report })
      if (!r.ok) set({ addError: r.error ?? 'перевірка не вдалася' })
    } finally {
      set({ checking: { ...get().checking, [id]: false } })
    }
  },
  applySnapshot: (s) => {
    const { selected } = get()
    const stillThere = selected && s.rules.some((r) => r.code === selected)
    set({ ...snapToState(s), selected: stillThere ? selected : (s.rules[0]?.code ?? null) })
  },
  select: (code) => {
    set({ selected: code })
    void window.api.setConfig({ lastRuleCode: code }).then((config) => set({ config }))
  },
  setQuery: (query) => set({ query }),
  setCategory: (category) => set({ category }),
  setOnlyEnabled: (onlyEnabled) => set({ onlyEnabled }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setImportOpen: (importOpen) => set({ importOpen }),
  setOverride: async (code, ov) => {
    const scope = get().ruleScope
    if (scope !== 'global') {
      const snap = await window.api.setProjectOverride(scope, code, ov)
      const config = await window.api.getConfig()
      set({ config, projects: config.projects, ...snapToState(snap) })
      return
    }
    const config = await window.api.setConfig({ overrides: { [code]: ov } })
    const snap = await window.api.getRules()
    set({ config, ...snapToState(snap) })
  },
  resetOverride: async (code) => {
    const scope = get().ruleScope
    if (scope !== 'global') {
      const snap = await window.api.setProjectOverride(scope, code, null)
      const config = await window.api.getConfig()
      set({ config, projects: config.projects, ...snapToState(snap) })
      return
    }
    const cfg = get().config
    if (!cfg) return
    const overrides = { ...cfg.overrides }
    delete overrides[code]
    const config = await window.api.setConfig({ overrides: { [code]: null as unknown as RuleOverride } })
    const snap = await window.api.getRules()
    set({ config: { ...config, overrides }, ...snapToState(snap) })
  },
  setRuleScope: async (ruleScope) => {
    const snap = await window.api.getRules(ruleScope === 'global' ? undefined : ruleScope)
    set({ ruleScope, ...snapToState(snap) })
  },
  setConfig: async (patch) => {
    const config = await window.api.setConfig(patch)
    const scope = get().ruleScope
    const snap = await window.api.getRules(scope === 'global' ? undefined : scope)
    set({ config, ...snapToState(snap) })
  },
  setReport: (report) => set({ report }),
  reload: async () => {
    await window.api.reloadRules()
    const scope = get().ruleScope
    const snap = await window.api.getRules(scope === 'global' ? undefined : scope)
    get().applySnapshot(snap)
  }
}))

function snapToState(s: RulesSnapshot): Pick<State, 'rules' | 'errors' | 'bundledDir' | 'userRulesDir'> {
  return { rules: s.rules, errors: s.errors, bundledDir: s.bundledDir, userRulesDir: s.userRulesDir }
}

export function severityRank(s: Severity): number {
  return s === 'error' ? 0 : s === 'warning' ? 1 : 2
}
