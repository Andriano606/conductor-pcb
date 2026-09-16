import { create } from 'zustand'
import type { AppConfig, Category, CheckResult, ClaudeProfile, CustomPrompt, EffectiveRule, EnvVar, FindingsReport, KicadStatus, PcbProject, RuleOverride, RulesSnapshot, Severity, UsageWindow } from '@shared/types'
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
  /** The import modal's target: 'global' (user rules dir), a project id, or null when closed. */
  importScope: string | null
  /** The big global-rules window (opened from settings). */
  globalRulesOpen: boolean
  loaded: boolean
  // ---- Conductor PCB
  view: 'chat' | 'rules'
  /**
   * Whose rules the «Правила» tab shows and edits: the active project's id, or 'global' when
   * there is no project. Derived from `config.activeProjectId` by `refreshRules`.
   */
  ruleScope: string
  /** The global library (bundled + user rules with the global overrides), for the global-rules window. */
  globalRules: EffectiveRule[]
  /** The active project's own rules dir (from the scoped snapshot). */
  projectRulesDir: string
  projects: PcbProject[]
  kicad: Record<string, KicadStatus>
  checking: Record<string, boolean>
  /** The last finished «Перевірити плату» run, shown in CheckReportModal until closed. */
  checkResult: (CheckResult & { projectId: string }) | null
  addError: string | null
  customPrompts: CustomPrompt[]
  claudeProfiles: ClaudeProfile[]
  usage: UsageWindow[]
  confirm: { message: string; resolve: (ok: boolean) => void } | null
  /** Selected chat session (tab) per project id; App falls back to the first session when stale. */
  activeSessionByProject: Record<string, string>

  load: () => Promise<void>
  applySnapshot: (s: RulesSnapshot) => void
  select: (code: string) => void
  setQuery: (q: string) => void
  setCategory: (c: Category | 'all') => void
  setOnlyEnabled: (v: boolean) => void
  setSettingsOpen: (v: boolean) => void
  setImportScope: (scope: string | null) => void
  setGlobalRulesOpen: (v: boolean) => void
  /** Change enabled/severity/params of a rule in `scope` (default: the current `ruleScope`). */
  setOverride: (code: string, ov: RuleOverride, scope?: string) => Promise<void>
  resetOverride: (code: string, scope?: string) => Promise<void>
  /** Drop all of a project's overrides (every rule back to the global values). */
  resetProjectOverrides: (projectId: string) => Promise<void>
  /** Delete a user rule file (scope 'global') or a project's own rule (scope = project id). */
  deleteRule: (code: string, scope: string) => Promise<boolean>
  /** Re-fetch the scoped rules for the active project and the global library. */
  refreshRules: () => Promise<void>
  setConfig: (patch: Partial<AppConfig>) => Promise<void>
  setReport: (r: FindingsReport | null) => void
  reload: () => Promise<void>
  setView: (v: 'chat' | 'rules') => void
  setProjects: (p: PcbProject[]) => void
  addProject: () => Promise<void>
  deleteProject: (id: string) => Promise<void>
  selectProject: (id: string) => Promise<void>
  refreshKicad: (id: string) => Promise<void>
  runCheck: (id: string) => Promise<void>
  closeCheckResult: () => void
  createCustomPrompt: (title: string, content: string) => Promise<void>
  updateCustomPrompt: (p: CustomPrompt) => Promise<void>
  deleteCustomPrompt: (id: string) => Promise<void>
  createClaudeProfile: (name: string, path: string, env: EnvVar[]) => Promise<void>
  updateClaudeProfile: (p: ClaudeProfile) => Promise<void>
  deleteClaudeProfile: (id: string) => Promise<void>
  setProjectProfiles: (projectId: string, ids: string[]) => Promise<void>
  rebuildClaudeConfigs: () => Promise<void>
  setUsage: (w: UsageWindow[]) => void
  askConfirm: (message: string) => Promise<boolean>
  resolveConfirm: (ok: boolean) => void
  setActiveSession: (projectId: string, sessionId: string) => void
}

const ACTIVE_SESSION_KEY = 'conductor-pcb.activeSession'

function loadActiveSessions(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(ACTIVE_SESSION_KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, string>) : {}
  } catch {
    return {}
  }
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
  importScope: null,
  globalRulesOpen: false,
  loaded: false,
  view: (localStorage.getItem('conductor-pcb.view') as 'chat' | 'rules') || 'chat',
  ruleScope: 'global',
  globalRules: [],
  projectRulesDir: '',
  projects: [],
  kicad: {},
  checking: {},
  checkResult: null,
  addError: null,
  customPrompts: [],
  claudeProfiles: [],
  usage: [],
  confirm: null,
  activeSessionByProject: loadActiveSessions(),

  setActiveSession: (projectId, sessionId) => {
    const activeSessionByProject = { ...get().activeSessionByProject, [projectId]: sessionId }
    try {
      localStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify(activeSessionByProject))
    } catch {
    }
    set({ activeSessionByProject })
  },
  load: async () => {
    const [config, configPath, api, report, projects] = await Promise.all([
      window.api.getConfig(),
      window.api.configPath(),
      window.api.apiStatus(),
      window.api.lastFindings(),
      window.api.listProjects()
    ])
    const scope = scopeFor(config, projects)
    const [snap, global] = await Promise.all([window.api.getRules(scope === 'global' ? undefined : scope), window.api.getRules()])
    const selected = config.lastRuleCode && snap.rules.some((r) => r.code === config.lastRuleCode)
      ? config.lastRuleCode
      : (snap.rules[0]?.code ?? null)
    set({ ...snapToState(snap), globalRules: global.rules, ruleScope: scope, config, configPath, api, report, selected, projects, loaded: true,
      customPrompts: config.customPrompts ?? [], claudeProfiles: config.claudeProfiles ?? [], usage: config.lastUsage ?? [] })
  },
  refreshRules: async () => {
    const { config, projects } = get()
    if (!config) return
    const scope = scopeFor(config, projects)
    const [snap, global] = await Promise.all([window.api.getRules(scope === 'global' ? undefined : scope), window.api.getRules()])
    const { selected } = get()
    const stillThere = selected && snap.rules.some((r) => r.code === selected)
    set({ ...snapToState(snap), globalRules: global.rules, ruleScope: scope, selected: stillThere ? selected : (snap.rules[0]?.code ?? null) })
  },
  createCustomPrompt: async (title, content) => {
    await window.api.addPrompt(title, content)
    set({ customPrompts: await window.api.listPrompts() })
  },
  updateCustomPrompt: async (p) => {
    await window.api.updatePrompt(p)
    set({ customPrompts: await window.api.listPrompts() })
  },
  deleteCustomPrompt: async (id) => {
    await window.api.removePrompt(id)
    set({ customPrompts: await window.api.listPrompts() })
  },
  createClaudeProfile: async (name, path, env) => {
    await window.api.addProfile(name, path, env)
    set({ claudeProfiles: await window.api.listProfiles() })
  },
  updateClaudeProfile: async (p) => {
    await window.api.updateProfile(p)
    set({ claudeProfiles: await window.api.listProfiles() })
  },
  deleteClaudeProfile: async (id) => {
    await window.api.removeProfile(id)
    const [claudeProfiles, projects] = await Promise.all([window.api.listProfiles(), window.api.listProjects()])
    set({ claudeProfiles, projects })
  },
  setProjectProfiles: async (projectId, ids) => {
    await window.api.setProjectProfiles(projectId, ids)
    set({ projects: await window.api.listProjects() })
  },
  rebuildClaudeConfigs: async () => {
    await window.api.rebuildConfigs()
  },
  setUsage: (usage) => set({ usage }),
  askConfirm: (message) => new Promise<boolean>((resolve) => set({ confirm: { message, resolve } })),
  resolveConfirm: (ok) => {
    const c = get().confirm
    set({ confirm: null })
    c?.resolve(ok)
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
    await get().refreshRules()
  },
  deleteProject: async (id) => {
    await window.api.deleteProject(id)
    const [projects, config] = await Promise.all([window.api.listProjects(), window.api.getConfig()])
    set({ projects, config })
    await get().refreshRules()
  },
  selectProject: async (id) => {
    const config = await window.api.selectProject(id)
    set({ config, view: 'chat' })
    await get().refreshRules()
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
      if (r.ok) set({ checkResult: { ...r, projectId: id } })
      else set({ addError: r.error ?? 'перевірка не вдалася' })
    } finally {
      set({ checking: { ...get().checking, [id]: false } })
    }
  },
  closeCheckResult: () => set({ checkResult: null }),
  applySnapshot: (s) => {
    // The main process pushes the global snapshot on any file change; the tab shows the
    // active project's scope, so re-fetch that and keep the pushed one as the global library.
    set({ globalRules: s.rules, errors: s.errors, bundledDir: s.bundledDir, userRulesDir: s.userRulesDir })
    void get().refreshRules()
  },
  select: (code) => {
    set({ selected: code })
    void window.api.setConfig({ lastRuleCode: code }).then((config) => set({ config }))
  },
  setQuery: (query) => set({ query }),
  setCategory: (category) => set({ category }),
  setOnlyEnabled: (onlyEnabled) => set({ onlyEnabled }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setImportScope: (importScope) => set({ importScope }),
  setGlobalRulesOpen: (globalRulesOpen) => set({ globalRulesOpen }),
  setOverride: async (code, ov, scope = get().ruleScope) => {
    if (scope !== 'global') {
      await window.api.setProjectOverride(scope, code, ov)
      const config = await window.api.getConfig()
      set({ config, projects: config.projects })
    } else {
      // the main process re-prunes project overrides against the new global values
      const config = await window.api.setConfig({ overrides: { [code]: ov } })
      set({ config, projects: config.projects ?? get().projects })
    }
    await get().refreshRules()
  },
  resetOverride: async (code, scope = get().ruleScope) => {
    if (scope !== 'global') {
      await window.api.setProjectOverride(scope, code, null)
      const config = await window.api.getConfig()
      set({ config, projects: config.projects })
    } else {
      const cfg = get().config
      if (!cfg) return
      const overrides = { ...cfg.overrides }
      delete overrides[code]
      const config = await window.api.setConfig({ overrides: { [code]: null as unknown as RuleOverride } })
      set({ config: { ...config, overrides } })
    }
    await get().refreshRules()
  },
  resetProjectOverrides: async (projectId) => {
    await window.api.resetProjectOverrides(projectId)
    const config = await window.api.getConfig()
    set({ config, projects: config.projects })
    await get().refreshRules()
  },
  deleteRule: async (code, scope) => {
    const ok = await window.api.deleteUserRule(code, scope === 'global' ? undefined : scope)
    if (ok) await get().refreshRules()
    return ok
  },
  setConfig: async (patch) => {
    const config = await window.api.setConfig(patch)
    set({ config })
    await get().refreshRules()
  },
  setReport: (report) => set({ report }),
  reload: async () => {
    await window.api.reloadRules()
    await get().refreshRules()
  }
}))

/** The rules scope the «Правила» tab shows: the active project (or the first one), else global. */
export function scopeFor(config: Pick<AppConfig, 'activeProjectId'> | null, projects: PcbProject[]): string {
  const p = projects.find((x) => x.id === config?.activeProjectId) ?? projects[0]
  return p ? p.id : 'global'
}

function snapToState(s: RulesSnapshot): Pick<State, 'rules' | 'errors' | 'bundledDir' | 'userRulesDir' | 'projectRulesDir'> {
  return { rules: s.rules, errors: s.errors, bundledDir: s.bundledDir, userRulesDir: s.userRulesDir, projectRulesDir: s.projectRulesDir ?? '' }
}

export function severityRank(s: Severity): number {
  return s === 'error' ? 0 : s === 'warning' ? 1 : 2
}
