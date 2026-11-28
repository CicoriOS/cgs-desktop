#!/bin/sh
# Removes CGS Desktop and everything the desktop put in the user's directories, including sign-in credentials and sessions:
# the installed AppImage, the launcher entry, the icons, the cgs CLI the desktop installed, the config root (~/.cgs, or
# $PI_CONFIG_DIR), Electron's userData ($XDG_CONFIG_HOME/CGS Desktop) and the updater cache. A bun installed by the desktop
# is removed too: its `<bun root>/.cgs-desktop-installed` marker is the only proof, so a bun the user had before is never
# touched. The paths follow from where this script sits: <data>/cgs-desktop/uninstall.sh.
#
# One question comes first, listing what will go: y/N on a terminal, zenity/kdialog otherwise. `--yes` skips it (the
# installer already asked); without a terminal, a dialog or --yes the script refuses and deletes nothing.
#
# POSIX sh: this also runs from the launcher entry's Uninstall action, where there is no terminal.
set -eu

DEST=$(dirname "$(readlink -f "$0")")
DATA=$(dirname "$DEST")
INNER=$DEST/CGS-Desktop.AppImage
ENTRY=$DATA/applications/cgs-desktop.desktop
ICON_SIZES="16 24 32 48 64 128 256 512"
YES=no
if [ "${1:-}" = "--yes" ]; then
  YES=yes
fi

if [ -z "${HOME:-}" ]; then
  printf '%s\n' "HOME 未设置，无法确定要删除的目录。" >&2
  exit 1
fi

BUN_ROOT=${BUN_INSTALL:-$HOME/.bun}
BUN_MARKER=$BUN_ROOT/.cgs-desktop-installed
GLOBAL_ROOT=$BUN_ROOT/install/global
XDG_CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}
XDG_CACHE=${XDG_CACHE_HOME:-$HOME/.cache}
USER_DATA="$XDG_CONFIG/CGS Desktop"
UPDATER_CACHE=$XDG_CACHE/cgs-desktop-updater

# The CLI resolves PI_CONFIG_DIR against HOME (a leading slash is joined, as Node's path.join does), and its default is .cgs.
CONFIG_DIR=${PI_CONFIG_DIR:-.cgs}
if [ -z "$CONFIG_DIR" ]; then
  CONFIG_DIR=.cgs
fi
case $CONFIG_DIR in
  /*) CONFIG_DIR=$HOME$CONFIG_DIR ;;
  *) CONFIG_DIR=$HOME/$CONFIG_DIR ;;
esac
if RESOLVED=$(readlink -f "$CONFIG_DIR" 2>/dev/null) && [ -n "$RESOLVED" ]; then
  CONFIG_DIR=$RESOLVED
fi
CONFIG_SKIP=no
case $CONFIG_DIR in
  "$HOME" | "/") CONFIG_SKIP=yes ;;
  "$HOME"/*) ;;
  *) CONFIG_SKIP=yes ;;
esac

removed() { printf '已删除：%s\n' "$*"; }

# What the confirmation lists and what the Desktop Action's dialog tells the user.
LIST="将删除以下内容：
  - 已安装的 CGS Desktop 程序：$INNER
  - 启动项和图标：$ENTRY、$DATA/icons/hicolor/*/apps/cgs-desktop.png
  - cgs 命令行工具：$BUN_ROOT/bin/cgs 及其全局安装目录 $GLOBAL_ROOT/node_modules/@cicori/cgs"
if [ -f "$BUN_MARKER" ]; then
  LIST="$LIST
  - 由本程序安装的 bun：$BUN_ROOT"
fi
if [ "$CONFIG_SKIP" = no ]; then
  LIST="$LIST
  - 配置与数据：$CONFIG_DIR（含登录凭据、所有会话和聊天记录）"
fi
LIST="$LIST
  - 应用设置和缓存：$USER_DATA、$UPDATER_CACHE
此操作不可撤销。"

ANSWER=
CONFIRM=no

ask_confirmation() {
  CONFIRM=no
  if [ "$YES" = yes ]; then
    CONFIRM=yes
    return 0
  fi
  if [ -t 0 ] || [ -t 2 ]; then
    printf '%s\n' "$LIST" >&2
    printf '确认卸载？[y/N] ' >&2
    if [ -r /dev/tty ]; then
      IFS= read -r ANSWER < /dev/tty || ANSWER=
    else
      IFS= read -r ANSWER || ANSWER=
    fi
    case $ANSWER in
      y | Y | yes | YES) CONFIRM=yes ;;
    esac
    return 0
  fi
  if command -v zenity >/dev/null 2>&1; then
    if LD_LIBRARY_PATH="" zenity --question --title="CGS Desktop" --no-markup --default-cancel --ok-label="卸载" --cancel-label="取消" --text="$LIST" 2>/dev/null; then
      CONFIRM=yes
    fi
    return 0
  fi
  if command -v kdialog >/dev/null 2>&1; then
    if LD_LIBRARY_PATH="" kdialog --title "CGS Desktop" --warningyesno "$LIST" --yes-label "卸载" --no-label "取消" 2>/dev/null; then
      CONFIRM=yes
    fi
    return 0
  fi
  CONFIRM=refuse
}

# --- Stopping what is running --------------------------------------------------------------------------------------

ppid_of() {
  [ -r "/proc/$1/stat" ] || return 1
  sed -e 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f2
}

proc_state() {
  [ -r "/proc/$1/stat" ] || return 1
  sed -e 's/^.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f1
}

# Kills the app started from the installed inner AppImage (`APPIMAGE` in its environment). The uninstaller and whatever
# started it are never touched: the process tree this script runs in is protected by PID.
stop_app() {
  PROTECTED=" $$ "
  PID=$$
  while :; do
    PARENT=$(ppid_of "$PID" 2>/dev/null) || break
    case $PARENT in
      '' | 0 | 1) break ;;
    esac
    PROTECTED="$PROTECTED$PARENT "
    PID=$PARENT
  done
  TARGETS=
  for DIR in /proc/[0-9]*; do
    PID=${DIR#/proc/}
    case $PROTECTED in
      *" $PID "*) continue ;;
    esac
    [ -r "$DIR/environ" ] || continue
    if tr '\0' '\n' < "$DIR/environ" 2>/dev/null | grep -qxF "APPIMAGE=$INNER"; then
      TARGETS="$TARGETS $PID"
    fi
  done
  if [ -n "$TARGETS" ]; then
    for PID in $TARGETS; do
      kill -TERM "$PID" 2>/dev/null || true
    done
    COUNT=0
    while [ "$COUNT" -lt 10 ]; do
      LEFT=
      for PID in $TARGETS; do
        if kill -0 "$PID" 2>/dev/null; then
          case $(proc_state "$PID" 2>/dev/null) in
            Z | '') ;;
            *) LEFT="$LEFT $PID" ;;
          esac
        fi
      done
      if [ -z "$LEFT" ]; then
        break
      fi
      TARGETS=$LEFT
      COUNT=$((COUNT + 1))
      sleep 0.2
    done
    for PID in $TARGETS; do
      kill -KILL "$PID" 2>/dev/null || true
    done
    TARGETS=
  fi
}

find_cgs() {
  for CANDIDATE in "$BUN_ROOT/bin/cgs" "$HOME/.bun/bin/cgs"; do
    if [ -x "$CANDIDATE" ]; then
      printf '%s\n' "$CANDIDATE"
      return 0
    fi
  done
  if command -v cgs >/dev/null 2>&1; then
    command -v cgs
    return 0
  fi
  return 1
}

# The daemon is stopped through the CLI's own hosted module, exactly like desktop/cli-sync.mjs does. A failure here is
# never fatal: the files below are removed either way.
stop_daemon() {
  CGS=$(find_cgs 2>/dev/null) || CGS=
  if [ -z "$CGS" ]; then
    return 0
  fi
  REAL=$(readlink -f "$CGS" 2>/dev/null) || REAL=$CGS
  ROOT=$(dirname "$(dirname "$REAL")")
  CONTROL=$ROOT/packages/connect/src/desktop/daemon-control.ts
  if [ ! -f "$CONTROL" ]; then
    return 0
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout 20 "$CGS" __cgs_worker_module "$CONTROL" shutdown >/dev/null 2>&1 || true
  else
    "$CGS" __cgs_worker_module "$CONTROL" shutdown >/dev/null 2>&1 || true
  fi
}

# --- Removing -----------------------------------------------------------------------------------------------------

find_bun() {
  if [ -n "${BUN_INSTALL:-}" ] && [ -x "$BUN_INSTALL/bin/bun" ]; then
    printf '%s\n' "$BUN_INSTALL/bin/bun"
    return 0
  fi
  if [ -x "$HOME/.bun/bin/bun" ]; then
    printf '%s\n' "$HOME/.bun/bin/bun"
    return 0
  fi
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  return 1
}

strip_package_json() {
  FILE=$1
  if [ ! -f "$FILE" ]; then
    return 0
  fi
  # Only Bun rewrites its lockfile. If Bun cannot run, remove the manifest entry without changing other packages.
  if ! python3 - "$FILE" <<'PY'
import json, os, sys, tempfile
path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
changed = False
for key in ("dependencies", "devDependencies", "optionalDependencies"):
    deps = data.get(key)
    if isinstance(deps, dict) and "@cicori/cgs" in deps:
        del deps["@cicori/cgs"]
        changed = True
if changed:
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=os.path.dirname(path), delete=False) as handle:
        temp = handle.name
        try:
            json.dump(data, handle, indent=2)
            handle.write("\n")
            handle.close()
            os.replace(temp, path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
PY
  then
    printf '无法更新 %s，保留原文件。\n' "$FILE" >&2
  fi
}

remove_cli() {
  BUN=$(find_bun 2>/dev/null) || BUN=
  if [ -n "$BUN" ]; then
    if command -v timeout >/dev/null 2>&1; then
      timeout 60 "$BUN" remove -g @cicori/cgs >/dev/null 2>&1 || true
    else
      "$BUN" remove -g @cicori/cgs >/dev/null 2>&1 || true
    fi
  fi
  # Whatever bun's own command left behind (or all of it when there is no bun) goes by hand.
  if [ -e "$GLOBAL_ROOT/node_modules/@cicori/cgs" ] || [ -L "$GLOBAL_ROOT/node_modules/@cicori/cgs" ]; then
    rm -rf "$GLOBAL_ROOT/node_modules/@cicori/cgs"
    removed "$GLOBAL_ROOT/node_modules/@cicori/cgs"
    rmdir "$GLOBAL_ROOT/node_modules/@cicori" 2>/dev/null || true
    rmdir "$GLOBAL_ROOT/node_modules" 2>/dev/null || true
  fi
  for SHIM in "$BUN_ROOT/bin/cgs" "$HOME/.bun/bin/cgs"; do
    if [ -e "$SHIM" ] || [ -L "$SHIM" ]; then
      rm -f "$SHIM"
      removed "$SHIM"
    fi
  done
  strip_package_json "$GLOBAL_ROOT/package.json"
}

# Only a bun this desktop installed is removed: the marker is written when the installer or the app downloaded it.
remove_bun() {
  if [ ! -f "$BUN_MARKER" ]; then
    return 0
  fi
  for FILE in "$BUN_ROOT/bin/bun" "$BUN_ROOT/bin/bunx"; do
    if [ -e "$FILE" ] || [ -L "$FILE" ]; then
      rm -f "$FILE"
      removed "$FILE"
    fi
  done
  if [ -e "$BUN_ROOT/install/cache" ]; then
    rm -rf "$BUN_ROOT/install/cache"
    removed "$BUN_ROOT/install/cache"
  fi
  rm -f "$BUN_MARKER"
  removed "$BUN_MARKER"
  # Empty directories only; a bun with anything else left in it is kept.
  rmdir "$BUN_ROOT/bin" 2>/dev/null || true
  rmdir "$GLOBAL_ROOT" 2>/dev/null || true
  rmdir "$BUN_ROOT/install" 2>/dev/null || true
  rmdir "$BUN_ROOT" 2>/dev/null || true
}

remove_path() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    rm -rf "$1"
    removed "$1"
  fi
}

# --- Main ---------------------------------------------------------------------------------------------------------

ask_confirmation
case $CONFIRM in
  yes) ;;
  refuse)
    printf '%s\n' "非交互环境，且没有可用的对话框；未删除任何内容。如需卸载，请加 --yes。" >&2
    exit 1
    ;;
  *)
    printf '%s\n' "已取消，未删除任何内容。" >&2
    exit 0
    ;;
esac

stop_app
stop_daemon
remove_cli
remove_bun

remove_path "$INNER"
remove_path "$ENTRY"
for SIZE in $ICON_SIZES; do
  remove_path "$DATA/icons/hicolor/${SIZE}x${SIZE}/apps/cgs-desktop.png"
done

if [ "$CONFIG_SKIP" = no ]; then
  remove_path "$CONFIG_DIR"
else
  printf '%s\n' "配置目录无法确定（$CONFIG_DIR），已跳过。" >&2
fi
remove_path "$USER_DATA"
remove_path "$UPDATER_CACHE"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DATA/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -f -t "$DATA/icons/hicolor" >/dev/null 2>&1 || true

# Last, the script and its directory: everything above must still be able to use them.
rm -f "$DEST/uninstall.sh"
rmdir "$DEST" 2>/dev/null || true

printf '%s\n' "CGS Desktop 已卸载。"
