import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { AppConfig } from '../shared/types'
import { defaultConfig, mergeConfig } from '../shared/rules'

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

export function getConfigPath(): string {
  return configPath
}

function persist(): void {
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2))
}
