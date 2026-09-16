import { describe, expect, it, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

// scripts/launch.sh is what the application-manager icon runs. It must always start the
// newest dist/*.AppImage and repackage first when sources are newer than that AppImage.
const launcher = resolve(__dirname, '../../scripts/launch.sh')

let repo: string
let home: string

function fakeRepo(): void {
  const root = mkdtempSync(join(tmpdir(), 'launch-'))
  repo = join(root, 'repo')
  home = join(root, 'home')
  for (const d of ['scripts', 'dist', 'src', 'rules', 'schema', 'build', 'node_modules', 'bin']) {
    mkdirSync(join(repo, d), { recursive: true })
  }
  mkdirSync(home)
  // The launcher resolves the repo from its own (symlink-resolved) location: copy it in.
  execFileSync('cp', [launcher, join(repo, 'scripts', 'launch.sh')])
  const old = Date.now() / 1000 - 1000
  for (const f of ['package.json', 'electron-builder.yml', 'electron.vite.config.ts']) {
    writeFileSync(join(repo, f), '')
    utimesSync(join(repo, f), old, old)
  }
  // A fake "$SHELL -ilc <cmd>": run <cmd> with our fake npm on PATH.
  writeFileSync(
    join(repo, 'bin', 'shell'),
    `#!/bin/bash\nshift\nexport PATH="${join(repo, 'bin')}:$PATH"\nexec bash -c "$@"\n`
  )
  // Fake npm: `npm run dist` writes a fresh AppImage (or fails when asked to).
  writeFileSync(
    join(repo, 'bin', 'npm'),
    `#!/bin/bash\necho "npm $*" >> "${join(repo, 'npm.log')}"\n` +
      `[ -e "${join(repo, 'FAIL')}" ] && exit 1\n` +
      `cat > "${join(repo, 'dist', 'Conductor PCB-9.9.9.AppImage')}" <<'X'\n#!/bin/bash\necho "new $*"\nX\n` +
      `chmod +x "${join(repo, 'dist', 'Conductor PCB-9.9.9.AppImage')}"\n`
  )
  execFileSync('chmod', ['+x', join(repo, 'bin', 'shell'), join(repo, 'bin', 'npm')])
}

function appImage(name: string, ageSec: number): string {
  const p = join(repo, 'dist', name)
  writeFileSync(p, '#!/bin/bash\necho "old $*"\n')
  execFileSync('chmod', ['+x', p])
  const t = Date.now() / 1000 - ageSec
  utimesSync(p, t, t)
  return p
}

function run(env: Record<string, string> = {}): string {
  return execFileSync('bash', [join(repo, 'scripts', 'launch.sh'), '--flag'], {
    env: { PATH: process.env.PATH ?? '', HOME: home, SHELL: join(repo, 'bin', 'shell'), ...env },
    encoding: 'utf8'
  })
}

beforeEach(fakeRepo)

describe('scripts/launch.sh', () => {
  it('launches the newest AppImage with --no-sandbox when it is up to date', () => {
    appImage('Conductor PCB-0.1.0.AppImage', 100)
    appImage('Conductor PCB-0.2.0.AppImage', 50)
    writeFileSync(join(repo, 'src', 'index.ts'), '')
    const t = Date.now() / 1000 - 1000
    utimesSync(join(repo, 'src', 'index.ts'), t, t)
    expect(run()).toBe('old --no-sandbox --flag\n')
    expect(existsSync(join(repo, 'npm.log'))).toBe(false)
  })

  it('repackages first when a source file is newer than the AppImage', () => {
    appImage('Conductor PCB-0.1.0.AppImage', 100)
    writeFileSync(join(repo, 'src', 'index.ts'), '')
    expect(run()).toBe('new --no-sandbox --flag\n')
    expect(readFileSync(join(repo, 'npm.log'), 'utf8')).toBe('npm run dist\n')
    expect(existsSync(join(home, '.cache', 'conductor-pcb', 'rebuild.log'))).toBe(true)
  })

  it('falls back to the old AppImage when the rebuild fails', () => {
    appImage('Conductor PCB-0.1.0.AppImage', 100)
    writeFileSync(join(repo, 'src', 'index.ts'), '')
    writeFileSync(join(repo, 'FAIL'), '')
    expect(run()).toBe('old --no-sandbox --flag\n')
  })

  it('skips the staleness check with CONDUCTOR_PCB_NO_AUTOBUILD=1', () => {
    appImage('Conductor PCB-0.1.0.AppImage', 100)
    writeFileSync(join(repo, 'src', 'index.ts'), '')
    expect(run({ CONDUCTOR_PCB_NO_AUTOBUILD: '1' })).toBe('old --no-sandbox --flag\n')
    expect(existsSync(join(repo, 'npm.log'))).toBe(false)
  })
})
