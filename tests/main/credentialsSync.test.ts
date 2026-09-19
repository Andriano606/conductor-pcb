import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { credentialFiles, credentialFreshness, syncCredentialFiles, syncCredentials } from '../../src/main/credentialsSync'

const login = (expiresAt: number, tag = 'a'): string =>
  JSON.stringify({ mcpOAuth: {}, claudeAiOauth: { accessToken: `sk-ant-oat01-${tag}`, refreshToken: `sk-ant-ort01-${tag}`, expiresAt } })
/** What the CLI leaves behind after a failed refresh. */
const wiped = JSON.stringify({ mcpOAuth: {}, claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } })

describe('credentialFreshness', () => {
  it('ranks by expiresAt and treats wiped, malformed or missing logins as unusable', () => {
    expect(credentialFreshness(login(500))).toBe(500)
    expect(credentialFreshness(wiped)).toBe(-1)
    expect(credentialFreshness('{')).toBe(-1)
    expect(credentialFreshness(undefined)).toBe(-1)
    expect(credentialFreshness(JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'y' } }))).toBe(0)
  })
})

describe('syncCredentialFiles', () => {
  it('copies the freshest login over stale and wiped copies, leaves identical ones alone', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cred-'))
    const g = join(tmp, 'global.json')
    const stale = join(tmp, 'stale.json')
    const gone = join(tmp, 'wiped.json')
    const same = join(tmp, 'same.json')
    writeFileSync(g, login(2000, 'new'))
    writeFileSync(stale, login(1000, 'old'))
    writeFileSync(gone, wiped)
    writeFileSync(same, login(2000, 'new'))
    const before = statSync(same).mtimeMs
    expect(syncCredentialFiles([g, stale, gone, same]).sort()).toEqual([gone, stale].sort())
    expect(readFileSync(stale, 'utf8')).toBe(login(2000, 'new'))
    expect(readFileSync(gone, 'utf8')).toBe(login(2000, 'new'))
    expect(statSync(same).mtimeMs).toBe(before)
    expect(statSync(stale).mode & 0o777).toBe(0o600)
  })
  it('the merged copy wins when the app-side CLI refreshed first, so ~/.claude gets the rotated token too', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cred-'))
    const g = join(tmp, 'global.json')
    const merged = join(tmp, 'merged.json')
    writeFileSync(g, login(1000, 'old'))
    writeFileSync(merged, login(3000, 'rotated'))
    expect(syncCredentialFiles([g, merged])).toEqual([g])
    expect(readFileSync(g, 'utf8')).toBe(login(3000, 'rotated'))
  })
  it('creates a missing file only when asked to and does nothing without a usable login', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cred-'))
    const g = join(tmp, 'global.json')
    const missing = join(tmp, 'missing.json')
    writeFileSync(g, login(1000))
    expect(syncCredentialFiles([g, missing])).toEqual([])
    expect(existsSync(missing)).toBe(false)
    expect(syncCredentialFiles([g, missing], [missing])).toEqual([missing])
    expect(readFileSync(missing, 'utf8')).toBe(login(1000))
    writeFileSync(g, wiped)
    writeFileSync(missing, wiped)
    expect(syncCredentialFiles([g, missing])).toEqual([])
  })
})

describe('syncCredentials', () => {
  it('finds ~/.claude and every merged config dir that has a copy, and heals a wiped merged copy', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cred-'))
    const home = join(tmp, 'home')
    const userData = join(tmp, 'userData')
    mkdirSync(join(home, '.claude'), { recursive: true })
    mkdirSync(join(userData, 'claude-configs', 'p1'), { recursive: true })
    mkdirSync(join(userData, 'claude-configs', 'p2'), { recursive: true }) // built without a login: left alone
    const g = join(home, '.claude', '.credentials.json')
    const p1 = join(userData, 'claude-configs', 'p1', '.credentials.json')
    writeFileSync(g, login(2000, 'fresh'))
    writeFileSync(p1, wiped)
    expect(credentialFiles(userData, home)).toEqual([g, p1])
    expect(syncCredentials(userData, [], home)).toEqual([p1])
    expect(readFileSync(p1, 'utf8')).toBe(login(2000, 'fresh'))
    expect(existsSync(join(userData, 'claude-configs', 'p2', '.credentials.json'))).toBe(false)
    // a chat spawn names its merged copy explicitly so a freshly built dir gets the login
    const p2 = join(userData, 'claude-configs', 'p2', '.credentials.json')
    expect(syncCredentials(userData, [p2], home)).toEqual([p2])
    expect(readFileSync(p2, 'utf8')).toBe(login(2000, 'fresh'))
  })
})
