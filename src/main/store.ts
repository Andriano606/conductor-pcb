import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { randomUUID } from 'crypto'
import type { AppConfig, ClaudeProfile, CustomPrompt, EnvVar } from '../shared/types'
import { defaultConfig, mergeConfig } from '../shared/rules'
import { migrateSessionProfiles, migrateSessions } from '../shared/projects'

let configPath = ''
let config: AppConfig

/** Load config from <userData>/config.json (created with defaults on first run). */
export function initStore(dir: string = app.getPath('userData')): AppConfig {
  configPath = join(dir, 'config.json')
  config = defaultConfig(app.getPath('home'))
  // One-shot migration from the app's previous name (pcb-rules-library).
  const legacy = join(app.getPath('home'), '.config', 'pcb-rules-library', 'config.json')
  if (!existsSync(configPath) && existsSync(legacy)) {
    try {
      const raw = JSON.parse(readFileSync(legacy, 'utf8')) as Partial<AppConfig>
      if (raw.userRulesDir?.includes('pcb-rules-library')) delete raw.userRulesDir
      config = mergeConfig(config, raw)
    } catch (e) {
      console.error('legacy config unreadable:', e)
    }
  }
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Partial<AppConfig>
      config = mergeConfig(config, raw)
    } catch (e) {
      console.error('config.json unreadable, using defaults:', e)
    }
  }
  // Pre-tabs configs kept the Claude session on the project itself; give every project its sessions list.
  config = { ...config, projects: config.projects.map(migrateSessions).map(migrateSessionProfiles) }
  persist()
  return config
}

export function getConfig(): AppConfig {
  return config
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  config = mergeConfig(config, patch)
  persist()
  return config
}

// ---- prompt library
export function addCustomPrompt(title: string, content: string): CustomPrompt {
  const now = Date.now()
  const prompt: CustomPrompt = { id: randomUUID(), title, content, createdAt: now, updatedAt: now }
  setConfig({ customPrompts: [...config.customPrompts, prompt] })
  return prompt
}
export function updateCustomPrompt(prompt: CustomPrompt): void {
  setConfig({ customPrompts: config.customPrompts.map((p) => (p.id === prompt.id ? { ...prompt, updatedAt: Date.now() } : p)) })
}
export function removeCustomPrompt(id: string): void {
  setConfig({ customPrompts: config.customPrompts.filter((p) => p.id !== id) })
}
// ---- Claude config profiles
export function addClaudeProfile(name: string, path: string, env: EnvVar[] = []): ClaudeProfile {
  const now = Date.now()
  const profile: ClaudeProfile = { id: randomUUID(), name, path, env, createdAt: now, updatedAt: now }
  setConfig({ claudeProfiles: [...config.claudeProfiles, profile] })
  return profile
}
export function updateClaudeProfile(profile: ClaudeProfile): void {
  setConfig({ claudeProfiles: config.claudeProfiles.map((p) => (p.id === profile.id ? { ...profile, updatedAt: Date.now() } : p)) })
}
export function removeClaudeProfile(id: string): void {
  setConfig({
    claudeProfiles: config.claudeProfiles.filter((p) => p.id !== id),
    projects: config.projects.map((pr) => ({
      ...pr,
      ...(pr.newSessionProfileIds?.includes(id) ? { newSessionProfileIds: pr.newSessionProfileIds.filter((x) => x !== id) } : {}),
      sessions: pr.sessions.map((s) => (s.claudeConfigProfileIds?.includes(id) ? { ...s, claudeConfigProfileIds: s.claudeConfigProfileIds.filter((x) => x !== id) } : s))
    }))
  })
}

export function getConfigPath(): string {
  return configPath
}

function persist(): void {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2))
}
