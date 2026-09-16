import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import type { ClaudeProfile } from '../shared/types'

/**
 * Merge engine for per-project CLAUDE_CONFIG_DIRs (ported from conductor-linux): the global
 * ~/.claude is always the base layer; every enabled profile's source dir is overlaid in list
 * order, a later layer winning conflicts. The merged dir keeps its own conversation state.
 */
export const ASSET_SUBDIRS = ['commands', 'skills', 'agents', 'hooks', 'plugins']
export const DEEP_MERGE_FILES = ['settings.json', 'settings.local.json', '.credentials.json']
const CONVERSATION_SUBDIRS = ['projects', 'sessions', 'todos']
/** Something that makes a folder look like a Claude config dir. */
export const CLAUDE_CONFIG_MARKERS = ['CLAUDE.md', 'settings.json', 'settings.local.json', ...ASSET_SUBDIRS]

export function isClaudeConfigDir(dir: string): boolean {
  if (!dir || !existsSync(dir)) return false
  return CLAUDE_CONFIG_MARKERS.some((m) => existsSync(join(dir, m)))
}

function stashConversation(dir: string): Array<[string, string]> {
  const stash: Array<[string, string]> = []
  for (const sub of CONVERSATION_SUBDIRS) {
    const cur = join(dir, sub)
    if (!existsSync(cur)) continue
    const bak = join(dirname(dir), `.${basename(dir)}.${sub}.bak`)
    rmSync(bak, { recursive: true, force: true })
    renameSync(cur, bak)
    stash.push([bak, cur])
  }
  return stash
}

function restoreConversation(stash: Array<[string, string]>): void {
  for (const [bak, dest] of stash) {
    rmSync(dest, { recursive: true, force: true })
    renameSync(bak, dest)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Recursive JSON merge: objects key-by-key, everything else replaced by the overlay. */
export function deepMerge(base: unknown, overlay: unknown): unknown {
  if (overlay === undefined) return base
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(overlay)) out[key] = key in base ? deepMerge(base[key], value) : value
    return out
  }
  return overlay
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function buildClaudeJson(layers: ClaudeProfile[], mergedDir: string, home: string): void {
  type Cfg = { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> }
  try {
    const base = (readJson(join(home, '.claude.json')) as Cfg) ?? {}
    for (const p of layers) {
      const cfg = readJson(join(p.path, '.claude.json')) as Cfg | undefined
      if (!cfg) continue
      if (cfg.mcpServers) base.mcpServers = { ...base.mcpServers, ...cfg.mcpServers }
      if (cfg.projects) {
        base.projects = base.projects ?? {}
        for (const [repo, proj] of Object.entries(cfg.projects)) {
          if (!proj?.mcpServers) continue
          const existing = base.projects[repo] ?? {}
          base.projects[repo] = { ...existing, mcpServers: { ...existing.mcpServers, ...proj.mcpServers } }
        }
      }
    }
    writeFileSync(join(mergedDir, '.claude.json'), JSON.stringify(base, null, 2))
  } catch {
    /* best effort */
  }
}

function buildClaudeMd(layers: ClaudeProfile[], mergedDir: string, globalDir: string): void {
  const parts: string[] = []
  try {
    const globalMd = join(globalDir, 'CLAUDE.md')
    if (existsSync(globalMd)) parts.push(readFileSync(globalMd, 'utf8'))
    for (const p of layers) {
      const file = join(p.path, 'CLAUDE.md')
      if (!existsSync(file)) continue
      parts.push(`---\n\n# Конфіг: ${p.name}\n\n${readFileSync(file, 'utf8')}`)
    }
    if (parts.length) writeFileSync(join(mergedDir, 'CLAUDE.md'), parts.join('\n\n'))
  } catch {
    /* best effort */
  }
}

/** Build (or rebuild in place) a merged CLAUDE_CONFIG_DIR from ~/.claude + the profiles. */
export function buildMergedConfig(profiles: ClaudeProfile[], mergedDir: string, home = homedir()): void {
  if (!profiles.length) return
  const globalDir = join(home, '.claude')
  const overlays = profiles.filter((p) => resolve(p.path) !== resolve(globalDir))
  const stash = stashConversation(mergedDir)
  rmSync(mergedDir, { recursive: true, force: true })
  mkdirSync(mergedDir, { recursive: true })
  const layerDirs = [globalDir, ...overlays.map((p) => p.path)]
  for (const dir of layerDirs) {
    for (const sub of ASSET_SUBDIRS) {
      const src = join(dir, sub)
      if (!existsSync(src)) continue
      try {
        cpSync(src, join(mergedDir, sub), { recursive: true })
      } catch {
        /* skip unreadable */
      }
    }
  }
  for (const file of DEEP_MERGE_FILES) {
    let merged: unknown
    let found = false
    for (const dir of layerDirs) {
      const layer = readJson(join(dir, file))
      if (layer === undefined) continue
      merged = found ? deepMerge(merged, layer) : layer
      found = true
    }
    if (!found) continue
    try {
      writeFileSync(join(mergedDir, file), JSON.stringify(merged, null, 2))
    } catch {
      /* best effort */
    }
  }
  buildClaudeJson(overlays, mergedDir, home)
  buildClaudeMd(overlays, mergedDir, globalDir)
  restoreConversation(stash)
}
