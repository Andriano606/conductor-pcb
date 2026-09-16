#!/usr/bin/env bash
# Launcher used by the application-manager icon (see install-desktop.sh).
#
# Why this exists: the icon used to point straight at dist/Conductor PCB-<ver>.AppImage,
# so after a `npm run build`/commit without `npm run dist` (or after a version bump) the
# icon kept starting the OLD packaged build. This script:
#   1. picks the newest AppImage in dist/ at launch time (version bumps never break the icon);
#   2. if any source file is newer than that AppImage, repackages it first (npm run dist),
#      showing desktop notifications while it works; on failure it launches the old build;
#   3. execs the AppImage with the same flags the desktop entry used.
# Set CONDUCTOR_PCB_NO_AUTOBUILD=1 to skip the staleness check.
set -uo pipefail
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
LOG_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/conductor-pcb"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/rebuild.log"

notify() { command -v notify-send >/dev/null && notify-send -a "Conductor PCB" "$@" || true; }
newest_appimage() { ls -t "$REPO"/dist/*.AppImage 2>/dev/null | head -1 || true; }

# Source inputs of the packaged build. Keep in sync with what electron-builder bundles.
stale() {
  local appimage="$1"
  [[ -n "$appimage" && -f "$appimage" ]] || return 0
  find "$REPO/src" "$REPO/rules" "$REPO/schema" "$REPO/build" \
       "$REPO/package.json" "$REPO/electron-builder.yml" "$REPO/electron.vite.config.ts" \
       -newer "$appimage" -type f -print -quit 2>/dev/null | grep -q .
}

APPIMAGE="$(newest_appimage)"
if [[ -z "${CONDUCTOR_PCB_NO_AUTOBUILD:-}" && -d "$REPO/node_modules" ]] && stale "$APPIMAGE"; then
  notify "Збірка застаріла — перепаковую AppImage…" "Це займе близько хвилини. Лог: $LOG"
  {
    echo "=== $(date -Is) auto rebuild (stale: ${APPIMAGE:-none})"
    # Login+interactive shell so nvm's node/npm are on PATH under the GUI session.
    (cd "$REPO" && "${SHELL:-/bin/bash}" -ilc 'npm run dist')
  } >>"$LOG" 2>&1
  NEW="$(newest_appimage)"
  if [[ -n "$NEW" && -f "$NEW" ]] && ! stale "$NEW"; then
    APPIMAGE="$NEW"
    notify "Свіжу збірку запущено" "$(basename "$APPIMAGE")"
  else
    notify -u critical "Перепакувати не вдалося — запускаю стару збірку" "Дивись $LOG"
  fi
fi

if [[ -z "$APPIMAGE" || ! -f "$APPIMAGE" ]]; then
  notify -u critical "AppImage не знайдено" "Збери: cd $REPO && npm run dist"
  exit 1
fi
chmod +x "$APPIMAGE" 2>/dev/null || true
exec "$APPIMAGE" --no-sandbox "$@"
