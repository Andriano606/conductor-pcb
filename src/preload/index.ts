import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppConfig, RuleOverride, ChatAttachment, ChatAnswer, ChatEventPayload, ChatSnapshot, CheckerConfigExport, FindingsReport, KicadStatus, PcbProject, Rule, RulesSnapshot } from '../shared/types'

export interface ApiStatus {
  running: boolean
  url: string
  error?: string
}

const api = {
  // rules
  getRules: (projectId?: string): Promise<RulesSnapshot> => ipcRenderer.invoke('rules:snapshot', projectId),
  setProjectOverride: (projectId: string, code: string, ov: RuleOverride | null): Promise<RulesSnapshot> => ipcRenderer.invoke('rules:setProjectOverride', projectId, code, ov),
  reloadRules: (): Promise<RulesSnapshot> => ipcRenderer.invoke('rules:reload'),
  saveUserRule: (rule: Rule): Promise<string[]> => ipcRenderer.invoke('rules:saveUser', rule),
  deleteUserRule: (code: string): Promise<boolean> => ipcRenderer.invoke('rules:deleteUser', code),
  openRuleFile: (file: string): Promise<string> => ipcRenderer.invoke('rules:openFile', file),
  showDir: (dir: string): Promise<string> => ipcRenderer.invoke('rules:showDir', dir),
  onRulesChanged: (fn: (s: RulesSnapshot) => void): (() => void) => {
    const h = (_e: unknown, s: RulesSnapshot): void => fn(s)
    ipcRenderer.on('rules:changed', h)
    return () => ipcRenderer.removeListener('rules:changed', h)
  },
  // config
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (patch: Partial<AppConfig>): Promise<AppConfig> => ipcRenderer.invoke('config:set', patch),
  configPath: (): Promise<string> => ipcRenderer.invoke('config:path'),
  onConfigChanged: (fn: (c: AppConfig) => void): (() => void) => {
    const h = (_e: unknown, c: AppConfig): void => fn(c)
    ipcRenderer.on('config:changed', h)
    return () => ipcRenderer.removeListener('config:changed', h)
  },
  pickDir: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('dialog:pickDir', defaultPath),
  pickJsonFile: (): Promise<{ name: string; content: string } | null> => ipcRenderer.invoke('dialog:pickJsonFile'),
  // api + export
  apiStatus: (): Promise<ApiStatus> => ipcRenderer.invoke('api:status'),
  onApiStatus: (fn: (s: ApiStatus) => void): (() => void) => {
    const h = (_e: unknown, s: ApiStatus): void => fn(s)
    ipcRenderer.on('api:status', h)
    return () => ipcRenderer.removeListener('api:status', h)
  },
  exportChecker: (projectId?: string): Promise<CheckerConfigExport> => ipcRenderer.invoke('export:checker', projectId),
  saveExport: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('export:save', defaultPath),
  // findings pushed by the checker
  lastFindings: (): Promise<FindingsReport | null> => ipcRenderer.invoke('findings:last'),
  clearFindings: (): Promise<void> => ipcRenderer.invoke('findings:clear'),
  onFindings: (fn: (r: FindingsReport) => void): (() => void) => {
    const h = (_e: unknown, r: FindingsReport): void => fn(r)
    ipcRenderer.on('findings:new', h)
    return () => ipcRenderer.removeListener('findings:new', h)
  },
  // projects
  listProjects: (): Promise<PcbProject[]> => ipcRenderer.invoke('projects:list'),
  addProject: (): Promise<PcbProject | { error: string } | null> => ipcRenderer.invoke('projects:add'),
  addProjectDir: (dir: string): Promise<PcbProject | null> => ipcRenderer.invoke('projects:addDir', dir),
  deleteProject: (id: string): Promise<void> => ipcRenderer.invoke('projects:delete', id),
  updateProject: (id: string, patch: Partial<PcbProject>): Promise<PcbProject | undefined> => ipcRenderer.invoke('projects:update', id, patch),
  selectProject: (id: string): Promise<AppConfig> => ipcRenderer.invoke('projects:select', id),
  openKicad: (id: string): Promise<boolean> => ipcRenderer.invoke('projects:openKicad', id),
  kicadStatus: (id: string): Promise<KicadStatus> => ipcRenderer.invoke('projects:kicadStatus', id),
  checkProject: (id: string): Promise<{ ok: boolean; report?: unknown; error?: string }> => ipcRenderer.invoke('projects:check', id),
  onProjectsChanged: (fn: (p: PcbProject[]) => void): (() => void) => {
    const h = (_e: unknown, p: PcbProject[]): void => fn(p)
    ipcRenderer.on('projects:changed', h)
    return () => ipcRenderer.removeListener('projects:changed', h)
  },
  // chat
  attachChat: (id: string): Promise<ChatSnapshot> => ipcRenderer.invoke('chat:attach', id),
  sendChat: (id: string, text: string, attachments?: ChatAttachment[]): void => ipcRenderer.send('chat:send', id, text, attachments),
  setChatModel: (id: string, model: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('chat:setModel', id, model),
  setChatEffort: (id: string, effort: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('chat:setEffort', id, effort),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke('dialog:pickFiles'),
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  answerChat: (id: string, answer: ChatAnswer): void => ipcRenderer.send('chat:answer', id, answer),
  interruptChat: (id: string): void => ipcRenderer.send('chat:interrupt', id),
  restartChat: (id: string): Promise<boolean> => ipcRenderer.invoke('chat:restart', id),
  clearChat: (id: string): Promise<void> => ipcRenderer.invoke('chat:clear', id),
  onChatEvent: (fn: (p: ChatEventPayload) => void): (() => void) => {
    const h = (_e: unknown, p: ChatEventPayload): void => fn(p)
    ipcRenderer.on('chat:event', h)
    return () => ipcRenderer.removeListener('chat:event', h)
  },
  onSetView: (fn: (v: 'chat' | 'rules') => void): (() => void) => {
    const h = (_e: unknown, v: 'chat' | 'rules'): void => fn(v)
    ipcRenderer.on('ui:setView', h)
    return () => ipcRenderer.removeListener('ui:setView', h)
  },
  copyText: (text: string): void => ipcRenderer.send('sys:copy', text),
  openExternal: (url: string): void => ipcRenderer.send('sys:openExternal', url)
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
