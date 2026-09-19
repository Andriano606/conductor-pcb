import { chmodSync, existsSync, readdirSync, readFileSync, watch, writeFileSync } from 'fs'
import type { FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Keeps every copy of `.credentials.json` on the same OAuth token.
 *
 * Each project chat runs `claude` with its own CLAUDE_CONFIG_DIR (`<userData>/claude-configs/<id>`), and the CLI
 * keeps its login in `<configDir>/.credentials.json` — a symlink to `~/.claude` is refused by the CLI's store, so
 * `buildMergedConfig` copies the file. Two CLIs with separate copies of the same login break each other: whoever
 * refreshes first rotates the refresh token, the other copy keeps the old one and its next refresh fails with
 * «OAuth session expired and could not be refreshed» although the user is still logged in. The CLI wipes its copy
 * then (`expiresAt: 0`, empty tokens). The remedy: the copy with the newest `claudeAiOauth.expiresAt` wins and is
 * written over the others — before every chat spawn and whenever one of the files changes (the CLI re-reads the
 * file before refreshing, so a running session picks the rotated token up).
 */
export const CREDENTIALS_FILE = '.credentials.json'

interface OauthBlock {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
}

/** `expiresAt` of the login stored in `text`, or -1 when it holds no usable token. */
export function credentialFreshness(text: string | undefined): number {
  if (!text) return -1
  try {
    const parsed = JSON.parse(text) as { claudeAiOauth?: OauthBlock }
    const o = parsed.claudeAiOauth
    if (!o || !o.accessToken || !o.refreshToken) return -1
    return typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt) ? o.expiresAt : 0
  } catch {
    return -1
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Copies the freshest login among `files` to every other file whose content differs. Missing files are created
 * only when `createMissing` lists them (a merged dir that was never built must stay untouched). Returns the files
 * written. Never throws: an unreadable or unwritable copy is skipped.
 */
export function syncCredentialFiles(files: string[], createMissing: string[] = []): string[] {
  const texts = new Map<string, string | undefined>()
  for (const f of files) texts.set(f, readText(f))
  let best: string | undefined
  let bestScore = -1
  for (const [f, text] of texts) {
    const score = credentialFreshness(text)
    if (score > bestScore) {
      bestScore = score
      best = f
    }
  }
  if (!best || bestScore < 0) return []
  const winner = texts.get(best)!
  const written: string[] = []
  for (const [f, text] of texts) {
    if (f === best || text === winner) continue
    if (text === undefined && !createMissing.includes(f)) continue
    try {
      writeFileSync(f, winner, { mode: 0o600 })
      chmodSync(f, 0o600)
      written.push(f)
    } catch {
    }
  }
  return written
}

/** `~/.claude/.credentials.json` plus the copy in every merged config dir that exists. */
export function credentialFiles(userData: string, home = homedir()): string[] {
  const out = [join(home, '.claude', CREDENTIALS_FILE)]
  const root = join(userData, 'claude-configs')
  if (!existsSync(root)) return out
  let dirs: string[] = []
  try {
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name))
  } catch {
    return out
  }
  for (const dir of dirs) if (existsSync(join(dir, CREDENTIALS_FILE))) out.push(join(dir, CREDENTIALS_FILE))
  return out
}

/** One sync pass over the global file and every merged copy (`extra` adds files not discoverable yet). */
export function syncCredentials(userData: string, extra: string[] = [], home = homedir()): string[] {
  const files = credentialFiles(userData, home)
  for (const f of extra) if (!files.includes(f)) files.push(f)
  return syncCredentialFiles(files, extra)
}

/**
 * Watches `~/.claude` and every merged config dir for `.credentials.json` changes and re-syncs (debounced).
 * New merged dirs are picked up on the next pass because the `claude-configs` root is watched too.
 */
export function startCredentialsSync(userData: string, home = homedir()): () => void {
  const watchers = new Map<string, FSWatcher>()
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  const schedule = (): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      try {
        syncCredentials(userData, [], home)
      } catch {
      }
      attach()
    }, 300)
  }
  const watchDir = (dir: string, onlyCredentials: boolean): void => {
    if (watchers.has(dir) || !existsSync(dir)) return
    try {
      const w = watch(dir, { persistent: false }, (_ev, name) => {
        if (!onlyCredentials || name === CREDENTIALS_FILE || name === null) schedule()
      })
      w.on('error', () => {
        watchers.delete(dir)
      })
      watchers.set(dir, w)
    } catch {
    }
  }
  const attach = (): void => {
    if (stopped) return
    watchDir(join(home, '.claude'), true)
    const root = join(userData, 'claude-configs')
    watchDir(root, false)
    if (existsSync(root)) {
      try {
        for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory()) watchDir(join(root, d.name), true)
      } catch {
      }
    }
  }
  try {
    syncCredentials(userData, [], home)
  } catch {
  }
  attach()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    for (const w of watchers.values()) w.close()
    watchers.clear()
  }
}
