#!/usr/bin/env bash
# Register the built AppImage as a desktop application. Run after `npm run dist`.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APPIMAGE="${1:-$(ls -t "$REPO"/dist/*.AppImage 2>/dev/null | head -1 || true)}"
if [[ -z "${APPIMAGE}" || ! -f "${APPIMAGE}" ]]; then
  echo "AppImage not found. Build it first: npm run dist" >&2
  exit 1
fi
APPIMAGE="$(readlink -f "$APPIMAGE")"; chmod +x "$APPIMAGE"
# The icon runs scripts/launch.sh, not the versioned AppImage: the launcher picks the newest
# dist/*.AppImage at click time and repackages it when sources are newer, so a forgotten
# `npm run dist` or a version bump can no longer leave the icon on an old build.
LAUNCHER="$REPO/scripts/launch.sh"; chmod +x "$LAUNCHER"
APP_ID="conductor-pcb"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"; DESKTOP_DIR="$HOME/.local/share/applications"
mkdir -p "$ICON_DIR" "$DESKTOP_DIR"
cp "$REPO/build/icon.png" "$ICON_DIR/$APP_ID.png"
cat > "$DESKTOP_DIR/$APP_ID.desktop" <<EOD
[Desktop Entry]
Type=Application
Name=Conductor PCB
Comment=Проекти KiCad, чат з Claude і бібліотека правил трасування
Exec="$LAUNCHER" %U
Icon=$APP_ID
Terminal=false
Categories=Development;
StartupWMClass=conductor-pcb
EOD
chmod +x "$DESKTOP_DIR/$APP_ID.desktop"
update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
echo "installed: $DESKTOP_DIR/$APP_ID.desktop"
echo "exec: $LAUNCHER -> $APPIMAGE"
