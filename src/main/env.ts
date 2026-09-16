import { delimiter, join } from 'path'

/** Environment for spawned CLIs: strip AppImage leak vars, make sure ~/.local/bin is on PATH. */
export function buildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  delete env.ARGV0
  delete env.APPIMAGE
  delete env.APPDIR
  delete env.OWD
  const home = env.HOME ?? ''
  const wanted = [join(home, '.local', 'bin'), '/usr/local/bin']
  const parts = (env.PATH ?? '').split(delimiter)
  for (const w of wanted) if (!parts.includes(w)) parts.unshift(w)
  env.PATH = parts.join(delimiter)
  return env
}
