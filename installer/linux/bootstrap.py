#!/usr/bin/env python3
# Helpers for the Linux outer installer's AppRun (ADR 0050 §2). Runs on the system Python (3.8+); nothing here is bundled
# with a Python of its own, and nothing is downloaded except the pinned bun.
#
#   bootstrap.py compare <a> <b>        prints -1, 0 or 1 (semver order, a pre-release is lower than its release)
#   bootstrap.py decide <bundled> <installed-appimage>
#                                       prints install | upgrade | repair | keep
#   bootstrap.py ensure-bun <pin.json>  finds bun, or downloads the pinned one into $BUN_INSTALL/bin (default ~/.bun/bin)
#
# `ensure-bun` mirrors desktop/bun-install.mjs (the app runs the same step at first launch): same candidates, same assets,
# same checksum rule, same `CGS_BUN_BASE_URL` mirror override. The pin is package.json's `bunInstall`, copied in at build time.
import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

DEFAULT_BASE = "https://github.com/oven-sh/bun/releases/download"
PROGRESS_STEP = 8 * 1024 * 1024
TIMEOUT = 300

_VERSION = re.compile(r"v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?")


def parse_version(text):
    match = _VERSION.fullmatch(text.strip())
    if not match:
        raise ValueError("not a version: %r" % text)
    major, minor, patch, pre = match.groups()
    return (int(major), int(minor or 0), int(patch or 0)), (pre.split(".") if pre else None)


def _identifier_key(part):
    # Numeric identifiers sort below alphanumeric ones, as in semver.
    return (0, int(part), "") if part.isdigit() else (1, 0, part)


def compare_versions(a, b):
    (core_a, pre_a), (core_b, pre_b) = parse_version(a), parse_version(b)
    if core_a != core_b:
        return -1 if core_a < core_b else 1
    if pre_a == pre_b:
        return 0
    if pre_a is None:
        return 1
    if pre_b is None:
        return -1
    key_a, key_b = [_identifier_key(p) for p in pre_a], [_identifier_key(p) for p in pre_b]
    if key_a == key_b:
        return 0
    return -1 if key_a < key_b else 1


def installed_version(appimage):
    """The version of an installed AppImage, read from the desktop entry inside it; None when it cannot be read."""
    if not (os.path.isfile(appimage) and os.access(appimage, os.X_OK)):
        return None
    with tempfile.TemporaryDirectory(prefix="cgs-installer-") as scratch:
        try:
            subprocess.run([appimage, "--appimage-extract", "cgs-desktop.desktop"], cwd=scratch, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=True)
            with open(os.path.join(scratch, "squashfs-root", "cgs-desktop.desktop"), encoding="utf-8") as handle:
                match = re.search(r"^X-AppImage-Version=(.+)$", handle.read(), re.M)
        except (OSError, subprocess.SubprocessError):
            return None
    return match.group(1).strip() if match else None


def decide(bundled, appimage):
    """What the installer does: install (nothing there), upgrade (older there), repair (unreadable) or keep (as new or newer)."""
    if not os.path.lexists(appimage):
        return "install"
    installed = installed_version(appimage)
    if installed is None:
        return "repair"
    try:
        return "upgrade" if compare_versions(bundled, installed) > 0 else "keep"
    except ValueError:
        return "repair"


def find_bun(env, home):
    candidates = []
    if env.get("BUN_INSTALL"):
        candidates.append(os.path.join(env["BUN_INSTALL"], "bin", "bun"))
    candidates.append(os.path.join(home, ".bun", "bin", "bun"))
    candidates.extend(os.path.join(d, "bun") for d in env.get("PATH", "").split(os.pathsep) if d)
    for candidate in candidates:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def cpu_has_avx2():
    try:
        with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as handle:
            return re.search(r"^flags\s*:.*\bavx2\b", handle.read(), re.M | re.I) is not None
    except OSError:
        return False  # unreadable: the baseline build is the safe side


def bun_asset(machine, avx2):
    if machine in ("x86_64", "amd64"):
        return "bun-linux-x64" if avx2 else "bun-linux-x64-baseline"
    if machine in ("aarch64", "arm64"):
        return "bun-linux-aarch64"
    return None


def log(message):
    sys.stderr.write(message + "\n")
    sys.stderr.flush()


def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "cgs-desktop-installer"})
    chunks, received, reported = [], 0, 0
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        total = int(response.headers.get("Content-Length") or 0)
        while True:
            chunk = response.read(256 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
            received += len(chunk)
            if received - reported >= PROGRESS_STEP:
                reported = received
                log("downloading bun: %d%s MB" % (received // 1048576, " / %d" % (total // 1048576) if total else ""))
    return b"".join(chunks)


def ensure_bun(pin_file, env=None, home=None, machine=None, avx2=None):
    env = os.environ if env is None else env
    home = home or os.path.expanduser("~")
    found = find_bun(env, home)
    if found:
        log("bun found at %s; not touched" % found)
        return 0
    with open(pin_file, encoding="utf-8") as handle:
        pin = json.load(handle)
    import platform

    asset = bun_asset(machine or platform.machine(), cpu_has_avx2() if avx2 is None else avx2)
    if not asset:
        log("bun is not installed automatically on this machine type")
        return 1
    expected = (pin.get("sha256") or {}).get(asset)
    if not pin.get("version") or not expected:
        log("bun-pin.json has no checksum for %s" % asset)
        return 1
    base = (env.get("CGS_BUN_BASE_URL") or DEFAULT_BASE).strip().rstrip("/")
    url = "%s/bun-v%s/%s.zip" % (base, pin["version"], asset)
    log("downloading bun %s (%s)" % (pin["version"], asset))
    try:
        data = download(url)
    except Exception as error:  # urllib raises several unrelated types for network trouble
        log("could not download %s: %s" % (url, error))
        return 1
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        log("%s.zip does not match the pinned checksum (got %s)" % (asset, actual))
        return 1
    try:
        binary = zipfile.ZipFile(io.BytesIO(data)).read("%s/bun" % asset)
    except (zipfile.BadZipFile, KeyError) as error:
        log("bad bun archive: %s" % error)
        return 1
    bin_dir = os.path.join(env.get("BUN_INSTALL") or os.path.join(home, ".bun"), "bin")
    target = os.path.join(bin_dir, "bun")
    temp = "%s.%d.tmp" % (target, os.getpid())
    try:
        os.makedirs(bin_dir, exist_ok=True)
        with open(temp, "wb") as handle:
            handle.write(binary)
        os.chmod(temp, 0o755)
        os.replace(temp, target)
    except OSError as error:
        log("could not write %s: %s" % (target, error))
        try:
            os.remove(temp)
        except OSError:
            pass
        return 1
    log("bun %s installed at %s" % (pin["version"], target))
    return 0


def main(argv):
    if len(argv) == 4 and argv[1] == "compare":
        try:
            print(compare_versions(argv[2], argv[3]))
        except ValueError as error:
            log(str(error))
            return 2
        return 0
    if len(argv) == 4 and argv[1] == "decide":
        print(decide(argv[2], argv[3]))
        return 0
    if len(argv) == 3 and argv[1] == "ensure-bun":
        return ensure_bun(argv[2])
    log("usage: bootstrap.py compare <a> <b> | decide <bundled> <appimage> | ensure-bun <pin.json>")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
