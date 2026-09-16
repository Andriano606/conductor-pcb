/**
 * Shared types: rule library, example diagrams, app config, and the API payloads.
 * Everything here is plain JSON-serialisable so the same shapes travel over IPC,
 * the local HTTP API, and the rule files on disk.
 */

export type Severity = 'error' | 'warning' | 'info'

export type Category =
  | 'power' // живлення й розв'язка
  | 'ground' // земля, зворотний струм, полігони
  | 'signal' // сигнальні траси
  | 'clock' // кварци, осцилятори
  | 'manufacturing' // технологічність, DFM
  | 'mechanical' // корпус, кріплення, край плати
  | 'drc' // вбудовані правила KiCad DRC

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'power', label: 'Живлення' },
  { id: 'ground', label: 'Земля' },
  { id: 'signal', label: 'Сигнали' },
  { id: 'clock', label: 'Тактування' },
  { id: 'manufacturing', label: 'Виробництво' },
  { id: 'mechanical', label: 'Механіка' },
  { id: 'drc', label: 'DRC KiCad' }
]

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: 'Помилка',
  warning: 'Попередження',
  info: 'Інформація'
}

/** Copper layer used in example diagrams. */
export type Layer = 'F' | 'B'

/**
 * A declarative "scene" the renderer turns into an SVG board snippet. Units are
 * millimetres in a local coordinate system; `w`/`h` set the viewBox.
 */
export interface Scene {
  w: number
  h: number
  verdict: 'bad' | 'good'
  caption: string
  items: SceneItem[]
}

export type SceneItem =
  | { t: 'board'; x: number; y: number; w: number; h: number }
  | { t: 'zone'; x: number; y: number; w: number; h: number; layer: Layer; net?: string; cut?: boolean }
  | { t: 'part'; x: number; y: number; w: number; h: number; label: string; kind?: 'ic' | 'cap' | 'xtal' | 'conn' | 'res' | 'generic' }
  | { t: 'pad'; x: number; y: number; w: number; h: number; net?: string; label?: string; th?: boolean }
  | { t: 'track'; pts: [number, number][]; w: number; layer: Layer; net?: string; bad?: boolean }
  | { t: 'via'; x: number; y: number; d?: number; net?: string; bad?: boolean }
  | { t: 'label'; x: number; y: number; text: string; size?: number; anchor?: 'start' | 'middle' | 'end' }
  | { t: 'dim'; x1: number; y1: number; x2: number; y2: number; text: string }
  | { t: 'mark'; x: number; y: number; r?: number; text?: string }
  | { t: 'arrow'; x1: number; y1: number; x2: number; y2: number; text?: string }
  | { t: 'keepout'; x: number; y: number; w: number; h: number; label?: string }

export interface RuleParam {
  /** Key in the checker's config (pcbagent CheckConfig field name). */
  key: string
  label: string
  unit?: string
  type?: 'number' | 'string' | 'boolean'
  default: number | string | boolean
  min?: number
  max?: number
  step?: number
  description?: string
}

export interface RuleReference {
  title: string
  url?: string
}

export interface RuleChecker {
  /** Which engine implements the check. `pcbagent` = our Python checker; `kicad-drc` = built into KiCad. */
  engine: 'pcbagent' | 'kicad-drc' | 'manual'
  /** Function / DRC rule name that produces this finding code. */
  function?: string
  /** Free-form note on what exactly is measured. */
  measures?: string
}

/**
 * What the checker runs for this rule. `kernel` names a measurement kernel in
 * pcbagent (`Checker.check_<kernel>`); `emits` is the internal finding code that kernel
 * produces which this rule owns (defaults to the rule code); `args` are extra checker
 * config overrides (selectors, regexes) that are not user-facing params.
 */
export interface RuleCheck {
  kernel: string
  emits?: string
  args?: Record<string, number | string | boolean>
}

export interface Rule {
  /** Stable machine id, equals the finding `code` the checker emits. */
  code: string
  title: string
  category: Category
  severity: Severity
  /** One sentence for the sidebar tooltip / list. */
  summary: string
  /** Markdown body: what the rule is. */
  description: string
  /** Markdown: why it matters physically. */
  why: string
  /** Markdown: how to fix a violation. */
  fix: string
  params: RuleParam[]
  checker: RuleChecker
  /** Engine binding (kernel + args). Required for engine `pcbagent`. */
  check?: RuleCheck
  tags: string[]
  references: RuleReference[]
  examples: { bad: Scene; good: Scene }
  /** Default enabled state; the user config can override. */
  enabled: boolean
  /**
   * Where this rule was loaded from (filled by the loader, not stored in the file):
   * `bundled` ships with the app, `user` is the global user rules dir, `project` is a rule
   * imported into one project only (`<userData>/project-rules/<projectId>/`).
   */
  source?: RuleSource
  file?: string
}

export type RuleSource = 'bundled' | 'user' | 'project'

/** Per-rule user overrides persisted in the config. */
export interface RuleOverride {
  enabled?: boolean
  severity?: Severity
  params?: Record<string, number | string | boolean>
}

export interface AppConfig {
  /** Extra directory with user rules (JSON files); bundled rules always load. */
  userRulesDir: string
  /** Local HTTP API. */
  api: { enabled: boolean; port: number; host: string }
  overrides: Record<string, RuleOverride>
  /** Sidebar filter state is UI-only, but the last selected rule survives a restart. */
  lastRuleCode?: string
  /** Optional path where "Експортувати конфіг" writes pcbagent.rules.json by default. */
  exportPath?: string
  // ---- Conductor PCB
  /** Registered KiCad projects (left sidebar). */
  projects: PcbProject[]
  activeProjectId?: string
  /** Extra args for the claude CLI (after the fixed stream-json set). */
  claudeArgs: string
  /** Directory of kicad-ai-layout (the Python checker/router/MCP server). */
  pcbagentDir: string
  /** Python interpreter with kicad-python + mcp installed (usually pcbagentDir/.venv/bin/python). */
  pythonPath: string
  /** kicad-cli binary (for DRC) and the KiCad launcher used to open pcbnew. */
  kicadCli: string
  kicadLauncher: string
  /** Prompt library (global). */
  customPrompts: CustomPrompt[]
  /** Claude config overlays (global list; enabled per project). */
  claudeProfiles: ClaudeProfile[]
  /** Last parsed /usage windows, so the meters render right after launch. */
  lastUsage: UsageWindow[]
}

/** A rule with the user's overrides applied. */
export interface EffectiveRule extends Rule {
  effective: {
    enabled: boolean
    severity: Severity
    params: Record<string, number | string | boolean>
  }
}

/** What the checker exports/consumes: flat thresholds + ignore list (pcbagent CheckConfig). */
export interface CheckerConfigExport {
  generated: string
  source: 'pcb-rules-library'
  ignore_codes: string[]
  severities: Record<string, Severity>
  [threshold: string]: unknown
}

/** One finding as the checker reports it (mirrors pcbagent.checks.Finding). */
export interface Finding {
  code: string
  severity: Severity
  title: string
  detail?: string
  fix?: string
  x?: number | null
  y?: number | null
  layer?: string
  items?: string[]
  net?: string
  source?: string
}

export interface FindingsReport {
  board: string
  generated: string
  summary?: Record<Severity, number>
  findings: Finding[]
}

/** What «Перевірити плату» resolves with: the checker's JSON report plus the files it wrote next to the board. */
export interface CheckResult {
  ok: boolean
  report?: FindingsReport
  /** `pcb_report.md` written by the checker into the project dir (absent when it was not written). */
  reportFile?: string
  /** `pcb_report.json`, same place. */
  reportJson?: string
  error?: string
}

export interface RulesSnapshot {
  rules: EffectiveRule[]
  errors: { file: string; message: string }[]
  bundledDir: string
  userRulesDir: string
  /** Scope the snapshot was taken for: a project id, or undefined for the global library. */
  projectId?: string
  /** That project's own rules dir (only with `projectId`). */
  projectRulesDir?: string
}

// ---------------------------------------------------------------- Conductor PCB: projects + chat

/** A KiCad project registered in the left sidebar. */
/**
 * One Claude chat session (a tab) inside a project. A project owns one or more of these;
 * each is an independent `claude` process with its own transcript. The session `id` is the
 * opaque chat key used everywhere (the entries Map in claudeChat.ts, the chats/<id>.json
 * transcript file, the chat IPC channels and the renderer chatStore). The first session of a
 * migrated project reuses the project id as its session id so existing transcripts keep working.
 * Same model as conductor-linux's ChatSession.
 */
export interface ChatSession {
  id: string
  /** User-chosen label; falls back to "Сесія N" by position when unset. */
  title?: string
  createdAt: number
  /** Claude session id from the CLI's init event, used for --resume after a restart. */
  claudeSessionId?: string
  /** Runtime knobs chosen in the chat toolbar (persisted, re-applied on respawn). */
  claudeModel?: string
  claudeEffort?: string
}

export interface PcbProject {
  id: string
  name: string
  /** Directory that holds the .kicad_pro / .kicad_pcb files. */
  dir: string
  proFile: string
  boardFile: string
  createdAt: number
  /** The chat sessions (tabs) of this project; never empty once loaded (see migrateSessions). */
  sessions: ChatSession[]
  /** @deprecated pre-tabs field, migrated into sessions[0] on load. */
  claudeSessionId?: string
  /** Last checker run summary, shown in the sidebar. */
  lastCheck?: { generated: string; summary: Record<Severity, number> }
  /**
   * The project's own rule state (enabled/severity/params per rule), applied on top of the
   * global values. Filled with a full copy of the global values when the project is created
   * (`rulesPinned`), so later global changes do not touch the project until the user applies
   * them with ↺ in the «Правила» tab. Rules that appear later inherit the global values.
   */
  ruleOverrides?: Record<string, RuleOverride>
  /** True once ruleOverrides holds that full copy (set on creation / one-off migration). */
  rulesPinned?: boolean
  /** @deprecated pre-tabs fields, migrated into sessions[0] on load. */
  claudeModel?: string
  claudeEffort?: string
  /** Ids of the ClaudeProfile(s) enabled for this project's chat (empty = plain ~/.claude). */
  claudeConfigProfileIds?: string[]
  /** The merged CLAUDE_CONFIG_DIR built for those profiles (set whenever at least one is enabled). */
  mergedConfigDir?: string
}

export interface ChatQuestionOption {
  label: string
  description?: string
}

export interface ChatQuestion {
  question: string
  header?: string
  options: ChatQuestionOption[]
  multiSelect?: boolean
}

export type ChatPending =
  | { kind: 'question'; requestId: string; questions: ChatQuestion[] }
  | { kind: 'permission'; requestId: string; toolName: string; summary: string }

export type ChatAnswer =
  | { kind: 'question'; requestId: string; answers: Record<string, string> }
  | { kind: 'permission'; requestId: string; allow: boolean; message?: string }

export interface ChatItem {
  id: string
  role: 'user' | 'assistant' | 'tool' | 'info'
  text: string
  /** Tool items: tool name; `done` flips when the tool_result arrives. */
  toolName?: string
  done?: boolean
  isError?: boolean
  output?: string
  /** User items that record an answer to a question (not typed text). */
  answer?: boolean
  /** User items: files attached to this message. */
  attachments?: ChatAttachment[]
  ts: number
  endTs?: number
}

export type ChatEvent =
  | { type: 'meta'; commands?: ChatCommand[]; modelState?: ChatModelState }
  | { type: 'push'; item: ChatItem }
  | { type: 'append'; itemId: string; text: string }
  | { type: 'update'; item: ChatItem }
  | { type: 'clear' }
  | { type: 'pending'; pending: ChatPending | null }
  | { type: 'busy'; busy: boolean }

export interface ChatEventPayload {
  id: string
  seq: number
  ev: ChatEvent
}

export interface ChatCommand {
  name: string
  description?: string
  argumentHint?: string
}

export interface ChatModelOption {
  value: string
  displayName: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: string[]
}

export interface ChatModelState {
  models: ChatModelOption[]
  model?: string
  effort?: string
}

export interface ChatAttachment {
  id: string
  kind: 'image' | 'file'
  name: string
  path: string
  mediaType?: string
}

export interface ChatSnapshot {
  items: ChatItem[]
  pending: ChatPending | null
  busy: boolean
  seq: number
  running: boolean
  commands?: ChatCommand[]
  modelState?: ChatModelState
}

export interface KicadStatus {
  /** pcbnew process for this board is running (best effort, by command line). */
  running: boolean
  /** The IPC API socket exists. */
  apiSocket: boolean
}

// ---------------------------------------------------------------- prompts, Claude config profiles, usage

export interface CustomPrompt {
  id: string
  title: string
  content: string
  createdAt: number
  updatedAt: number
}

export interface EnvVar {
  key: string
  value: string
}

/** A Claude config overlay (a folder with commands/skills/agents/CLAUDE.md/settings). */
export interface ClaudeProfile {
  id: string
  name: string
  /** Source config directory, read live at every (re)build. */
  path: string
  env?: EnvVar[]
  createdAt: number
  updatedAt?: number
}

export interface UsageWindow {
  key: string
  label: string
  percent: number
  resetText?: string
  resetsAt?: number
}
