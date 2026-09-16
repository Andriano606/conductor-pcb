---
name: rebuild-and-restart-app
description: Run AFTER finishing work on a feature in conductor-pcb. Repackages the AppImage (npm run dist), points the application-manager icon at the fresh build (scripts/install-desktop.sh), and restarts the running app so the icon launches the new build. Use whenever a feature/change is done and the user runs the app from the installed icon/AppImage, or asks to "restart the app/icon", "перезапусти білд", "онови іконку", "перебілди застосунок".
---

# Rebuild & restart the app (update the icon)

`npm run build` only refreshes `out/` — it does **not** repackage the AppImage.
The user launches Conductor from the **application-manager icon**, whose
`.desktop` entry runs `scripts/launch.sh`. That launcher picks the newest
`dist/Conductor PCB-*.AppImage` and, if any file under `src/`, `rules/`,
`schema/`, `build/` or the build configs is newer than it, runs `npm run dist`
itself before starting (desktop notifications + `~/.cache/conductor-pcb/rebuild.log`).
`npm run dist` also has a `postdist` hook that re-runs `scripts/install-desktop.sh`.
So a forgotten repackage no longer leaves the icon on an old build — but the
user then waits ~1 min at click time. After finishing a feature you should still
**repackage the AppImage and restart the running instance** so the next click
is instant and the running app is the new code.

## When to run

After a feature/change is complete and verified (tests + `npm run build` green),
and the user runs the app from the icon — or whenever the user asks to restart
the app / update the icon / rebuild the packaged app.

Order: finish the work → [[verify-before-commit]] gates (tests + build) → this
skill (repackage + restart).

## Steps

### 1. Repackage the AppImage
```bash
npm run dist
```
This rebuilds `out/`, writes a fresh
`dist/Conductor PCB-<version>.AppImage` (+ `.deb`). Wait for it to finish.

### 2. Point the application-manager icon at the fresh build
```bash
bash scripts/install-desktop.sh
```
`npm run dist` already runs this via `postdist`; run it again only if the
`.desktop` file is missing or was edited by hand. The script rewrites
`~/.local/share/applications/conductor-pcb.desktop` (`Exec` → `scripts/launch.sh`),
copies the icon, and refreshes the desktop & icon caches. Idempotent and cheap.
Confirm the reported `exec:` line names the launcher and the newest
`dist/*.AppImage`.

### 3. Restart the running instance

The app runs **outside** the Bash tool's sandbox, in the user's GUI session.
Two gotchas, both handled below:

- **`pkill -f '<AppImage name>'` kills this very script** — the running command
  line contains the same literal string, so pkill matches and kills itself
  (exit 144) before touching the app. **Never** `pkill -f` a pattern that also
  appears in your command. Collect pids with `pgrep` into a variable built from
  concatenated pieces, or kill by explicit pid.
- **The sandbox can't signal the GUI app.** A normal Bash call's `kill` returns
  0 but does nothing to the out-of-sandbox app. Run the kill/relaunch with
  **`dangerouslyDisableSandbox: true`**.

```bash
# Build the match pattern from pieces so this script's own argv can't match it.
# Include the binary name: a bare '.mount_Conduc' also matches Conductor Linux
# (another AppImage the user runs, mounted as /tmp/.mount_Conduc*/conductor-linux).
pat=$(printf '%s' '.mount_' 'Conduc' '.*/conductor-pcb')

# Kill the running instance (main + helper procs). xargs -r, NOT `kill $pids`:
# the tool shell is zsh, which does not word-split an unquoted variable, so
# `kill -9 $pids` would pass "pid1 pid2" as one bogus argument and kill nothing.
pgrep -f "$pat" | xargs -r kill -9
sleep 2
# Re-kill any orphaned gpu/network helpers left over from the old mount.
pgrep -f "$pat" | xargs -r kill -9

# A stale SingletonLock makes the relaunch attach to a dead instance (старий
# білд). Explicit paths, NO globs — a non-matching glob ("Singleton*") makes
# zsh abort the whole script with "no matches found" before the relaunch runs.
rm -f "$HOME/.config/Conductor PCB/SingletonLock" "$HOME/.config/conductor-pcb/SingletonLock"

# Relaunch the freshly packaged AppImage the way the desktop icon does,
# fully detached so it outlives this shell.
APPIMAGE="$(ls -t "$PWD"/dist/*.AppImage | head -1)"
chmod +x "$APPIMAGE"
setsid "$APPIMAGE" --no-sandbox >/dev/null 2>&1 < /dev/null &
disown 2>/dev/null || true
sleep 6
```
Run that block with `dangerouslyDisableSandbox: true`. Then ALWAYS verify (step
4) — if the pids/mount suffix did not change, the kill silently failed and the
icon/app is still the old build.

### 4. Verify the new instance is up
```bash
pgrep -af '.mount_'"Conduc"'.*/conductor-pcb' | head -3
```
Confirm a process with a **new** `/tmp/.mount_Conduc<XXXX>/` path is running
(different suffix from the old one). Kill any orphan helpers still pointing at
the **old** mount suffix.

## Notes

- The app self-heals on launch: chat transcripts are persisted per project and
  the `claude` process is respawned with `--resume` on the first message, so a
  hard restart is safe.
- Step 2 (`scripts/install-desktop.sh`) also (re)copies `build/icon.png`, so it
  covers an icon-image change too — no separate step needed.
- Killing the user's running app is an outward, hard-to-reverse action — only do
  it when restarting was explicitly requested or is the clear intent of "rebuild
  and update the icon".
