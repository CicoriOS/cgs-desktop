#!/bin/sh
# Removes what the CGS Desktop installer put in the user's directories (ADR 0050 §6): the installed AppImage, the launcher
# entry and the icons, then this script and its directory. User data (~/.cgs and the like) is never touched.
# The paths follow from where this script sits: <data>/cgs-desktop/uninstall.sh.
set -eu

DEST=$(dirname "$(readlink -f "$0")")
DATA=$(dirname "$DEST")

rm -f "$DEST/CGS-Desktop.AppImage" "$DATA/applications/cgs-desktop.desktop"
for size in 16 24 32 48 64 128 256 512; do
  rm -f "$DATA/icons/hicolor/${size}x${size}/apps/cgs-desktop.png"
done
rm -f "$DEST/uninstall.sh"
rmdir "$DEST" 2>/dev/null || true

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -f -t "$DATA/icons/hicolor" >/dev/null 2>&1 || true
echo "CGS Desktop removed. Your data (~/.cgs) was left in place."
