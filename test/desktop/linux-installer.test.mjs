// The Linux outer installer (ADR 0050 §2, with the uninstall/reinstall prompt): AppRun, bootstrap.py and uninstall.sh run for
// real against a fake inner AppImage (a shell script that answers `--appimage-extract` like the real runtime and records how
// it was started). HOME and the XDG directories are temporary, and PATH points at a directory of symlinks to the tools the
// scripts need, so a zenity/kdialog on the developer's machine can never decide a test.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";

const run = promisify(execFile);
const SOURCE = path.resolve(import.meta.dirname, "..", "..", "installer", "linux");
const ICONS = path.resolve(import.meta.dirname, "..", "..", "assets", "icons");
// The scripts call only these; anything else on PATH (zenity, kdialog, a developer's bun) must not exist for the tests.
const TOOLS = ["awk", "cat", "chmod", "cp", "cut", "dirname", "grep", "kill", "mkdir", "mv", "readlink", "rm", "rmdir", "sed", "sh", "sleep", "timeout", "tr"];
const dirs = [];
const servers = [];
const children = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cgs-installer-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fake AppImage: `--appimage-extract` writes the desktop entry with `version`; any other start records its arguments. */
function fakeAppImage(file, version, log) {
  writeFileSync(
    file,
    `#!/bin/sh
if [ "$1" = "--appimage-extract" ]; then
  mkdir -p squashfs-root
  printf '[Desktop Entry]\\nX-AppImage-Version=${version}\\n' > squashfs-root/cgs-desktop.desktop
  exit 0
fi
echo "started ${version} extract=\${APPIMAGE_EXTRACT_AND_RUN:-no} args=$*" >> "${log}"
`,
  );
  chmodSync(file, 0o755);
}

/** The tools the scripts use, as symlinks; fuse is kept when the machine has it so the launcher entry stays FUSE-capable. */
function toolPath(root) {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of [...TOOLS, "python3", "fusermount", "fusermount3"]) {
    for (const dir of ["/usr/bin", "/bin"]) {
      const from = path.join(dir, tool);
      if (!existsSync(from)) continue;
      symlinkSync(from, path.join(bin, tool));
      break;
    }
  }
  return bin;
}

function setup({ bundled = "0.3.0", pin = { version: "1.4.4", sha256: {} } } = {}) {
  const root = tempDir();
  const appdir = path.join(root, "AppDir");
  mkdirSync(path.join(appdir, "payload"), { recursive: true });
  cpSync(path.join(SOURCE, "AppRun"), path.join(appdir, "AppRun"));
  chmodSync(path.join(appdir, "AppRun"), 0o755);
  cpSync(path.join(SOURCE, "bootstrap.py"), path.join(appdir, "payload", "bootstrap.py"));
  cpSync(path.join(SOURCE, "uninstall.sh"), path.join(appdir, "payload", "uninstall.sh"));
  cpSync(ICONS, path.join(appdir, "payload", "icons"), { recursive: true });
  writeFileSync(path.join(appdir, "payload", "VERSION"), `${bundled}\n`);
  writeFileSync(path.join(appdir, "payload", "bun-pin.json"), JSON.stringify(pin));
  const log = path.join(root, "starts.log");
  fakeAppImage(path.join(appdir, "payload", "CGS-Desktop.AppImage"), bundled, log);
  const bin = toolPath(root);
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  const config = path.join(root, "config");
  const cache = path.join(root, "cache");
  mkdirSync(home, { recursive: true });
  const installed = path.join(data, "cgs-desktop", "CGS-Desktop.AppImage");
  const bunRoot = path.join(home, ".bun");
  const env = (extra = {}) => ({
    PATH: bin,
    HOME: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    APPDIR: appdir,
    // Nothing from the developer's machine may decide the result.
    BUN_INSTALL: bunRoot,
    ...extra,
  });
  const start = (args = [], extra = {}) => run(path.join(appdir, "AppRun"), args, { env: env(extra) }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
  const starts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const uninstall = (args = [], extra = {}) => run("sh", [path.join(data, "cgs-desktop", "uninstall.sh"), ...args], { env: env(extra) }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
  const fuse = existsSync("/dev/fuse") && (existsSync(path.join(bin, "fusermount")) || existsSync(path.join(bin, "fusermount3")));
  return {
    root,
    appdir,
    bin,
    home,
    data,
    config,
    cache,
    installed,
    bunRoot,
    log,
    fuse,
    // What the fake app records: an AppImage without FUSE is started through its extraction mode instead.
    extract: fuse ? "no" : "1",
    launch: fuse ? "" : "env APPIMAGE_EXTRACT_AND_RUN=1 ",
    env,
    start,
    starts,
    uninstall,
  };
}

/** A zenity that answers the next --list/--question itself (recording its arguments), so the dialog paths run without a display. */
function fakeZenity(bin, body) {
  const file = path.join(bin, "zenity");
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' "$@" > "${path.join(bin, "zenity.args")}"\n${body}\n`);
  chmodSync(file, 0o755);
}

/** A release host for one bun asset; a zip with `<asset>/bun` deflated, and the matching pin. */
async function bunHost(script = "#!/bin/sh\necho 1.4.4\n") {
  const asset = os.arch() === "arm64" ? "bun-linux-aarch64" : null;
  const assets = asset ? [asset] : ["bun-linux-x64", "bun-linux-x64-baseline"];
  const zipOf = (name, data) => {
    const raw = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    const localPart = Buffer.concat([local, nameBuf, raw]);
    const centralPart = Buffer.concat([central, nameBuf]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(centralPart.length, 12);
    end.writeUInt32LE(localPart.length, 16);
    return Buffer.concat([localPart, centralPart, end]);
  };
  const zips = new Map(assets.map((name) => [name, zipOf(`${name}/bun`, Buffer.from(script))]));
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const name = /\/(bun-[a-z0-9-]+)\.zip$/.exec(req.url ?? "")?.[1];
    const zip = zips.get(name);
    if (!zip) return void res.writeHead(404).end();
    res.writeHead(200, { "content-length": zip.length }).end(zip);
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const pin = { version: "1.4.4", sha256: Object.fromEntries([...zips].map(([name, zip]) => [name, createHash("sha256").update(zip).digest("hex")])) };
  return { base: `http://127.0.0.1:${server.address().port}`, pin, hits };
}

/** A user-data tree an installed, used desktop leaves behind. */
function userState(t) {
  mkdirSync(path.join(t.home, ".cgs", "agent", "cgs"), { recursive: true });
  writeFileSync(path.join(t.home, ".cgs", "agent", "cgs", "credentials.json"), "{}");
  mkdirSync(path.join(t.home, ".cgs", "sessions"), { recursive: true });
  writeFileSync(path.join(t.home, ".cgs", "sessions", "s1.jsonl"), "{}");
  mkdirSync(path.join(t.home, ".cgs", "run", "daemon"), { recursive: true });
  writeFileSync(path.join(t.home, ".cgs", "run", "daemon", "daemon.sock"), "");
  writeFileSync(path.join(t.home, ".cgs", "desktop.json"), "{}");
  mkdirSync(path.join(t.config, "CGS Desktop", "Cache"), { recursive: true });
  writeFileSync(path.join(t.config, "CGS Desktop", "Preferences"), "{}");
  mkdirSync(path.join(t.config, "Unrelated"), { recursive: true });
  writeFileSync(path.join(t.config, "Unrelated", "keep"), "x");
  mkdirSync(path.join(t.cache, "cgs-desktop-updater", "pending"), { recursive: true });
  writeFileSync(path.join(t.cache, "cgs-desktop-updater", "pending", "update"), "x");
}

const bootstrap = (...args) => run("python3", [path.join(SOURCE, "bootstrap.py"), ...args]).then(({ stdout }) => stdout.trim());

test("versions order like semver, a pre-release below its release", async () => {
  expect(await bootstrap("compare", "0.3.0", "0.3.0")).toBe("0");
  expect(await bootstrap("compare", "0.3.1", "0.3.0")).toBe("1");
  expect(await bootstrap("compare", "0.10.0", "0.9.0")).toBe("1");
  expect(await bootstrap("compare", "0.3.0-next", "0.3.0")).toBe("-1");
  expect(await bootstrap("compare", "0.3.0-next.2", "0.3.0-next.10")).toBe("-1");
  expect(await bootstrap("compare", "1.3", "1.3.0")).toBe("0");
});

test("decide names the relationship to the installed app, and installed prints its version", async () => {
  const t = setup();
  mkdirSync(path.dirname(t.installed), { recursive: true });
  fakeAppImage(t.installed, "0.3.0", t.log);
  expect(await bootstrap("installed", t.installed)).toBe("0.3.0");
  expect(await bootstrap("decide", "0.3.0", t.installed)).toBe("same");
  expect(await bootstrap("decide", "0.4.0", t.installed)).toBe("upgrade");
  expect(await bootstrap("decide", "0.2.0", t.installed)).toBe("older");
  expect(await bootstrap("decide", "0.3.0", path.join(t.root, "missing.AppImage"))).toBe("install");
});

test("a first run installs the app, the launcher entry, the icons and the uninstaller, then starts the installed app", async () => {
  const bun = await bunHost();
  const t = setup({ pin: bun.pin });
  const result = await t.start(["--flag"], { CGS_BUN_BASE_URL: bun.base });
  expect(result.code).toBe(0);
  expect(t.starts()).toEqual([`started 0.3.0 extract=${t.extract} args=--flag`]);
  const entry = readFileSync(path.join(t.data, "applications", "cgs-desktop.desktop"), "utf8");
  expect(entry).toContain("Name=CGS Desktop");
  expect(entry).toContain("Icon=cgs-desktop");
  expect(entry).toContain("StartupWMClass=CGS Desktop");
  expect(entry).toContain(`Exec=${t.launch}"${t.installed}" %U`);
  // The launcher's Uninstall action must ask: only the installer's own choice passes --yes.
  expect(entry).toContain(`Exec=sh "${path.join(t.data, "cgs-desktop", "uninstall.sh")}"`);
  expect(entry).not.toContain("uninstall.sh\" --yes");
  for (const size of [16, 256, 512]) expect(existsSync(path.join(t.data, "icons", "hicolor", `${size}x${size}`, "apps", "cgs-desktop.png"))).toBe(true);
  expect(existsSync(path.join(t.data, "cgs-desktop", "uninstall.sh"))).toBe(true);
  // bun came from the host named by CGS_BUN_BASE_URL, into $BUN_INSTALL/bin, and left its installation marker.
  expect(bun.hits).toHaveLength(1);
  expect(existsSync(path.join(t.bunRoot, "bin", "bun"))).toBe(true);
  expect(JSON.parse(readFileSync(path.join(t.bunRoot, ".cgs-desktop-installed"), "utf8"))).toEqual({ version: "1.4.4" });
});

test("an existing bun is never replaced, downloaded or marked as installed by the desktop", async () => {
  const bun = await bunHost();
  const t = setup({ pin: bun.pin });
  const mine = path.join(t.bunRoot, "bin", "bun");
  mkdirSync(path.dirname(mine), { recursive: true });
  writeFileSync(mine, "#!/bin/sh\necho mine\n");
  chmodSync(mine, 0o755);
  expect((await t.start([], { CGS_BUN_BASE_URL: bun.base })).code).toBe(0);
  expect(bun.hits).toEqual([]);
  expect(readFileSync(mine, "utf8")).toContain("echo mine");
  expect(existsSync(path.join(t.bunRoot, ".cgs-desktop-installed"))).toBe(false);
});

test("a download that does not match the pinned checksum installs no bun, leaves no marker, and the app still starts", async () => {
  const bun = await bunHost();
  const wrong = { ...bun.pin, sha256: Object.fromEntries(Object.keys(bun.pin.sha256).map((name) => [name, "0".repeat(64)])) };
  const t = setup({ pin: wrong });
  const result = await t.start([], { CGS_BUN_BASE_URL: bun.base });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("does not match the pinned checksum");
  expect(existsSync(path.join(t.bunRoot, "bin", "bun"))).toBe(false);
  expect(existsSync(path.join(t.bunRoot, ".cgs-desktop-installed"))).toBe(false);
  expect(t.starts()).toHaveLength(1);
});

test("the same version asks: reinstall copies the bundled app over the installed one and starts it", async () => {
  const bun = await bunHost();
  const t = setup({ pin: bun.pin });
  await t.start([], { CGS_BUN_BASE_URL: bun.base });
  const bundled = readFileSync(t.installed, "utf8");
  writeFileSync(t.installed, `${bundled}# a local edit\n`);
  const result = await t.start([], { CGS_INSTALLER_ACTION: "reinstall", CGS_BUN_BASE_URL: bun.base });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("(reinstall)");
  expect(readFileSync(t.installed, "utf8")).toBe(bundled);
  expect(t.starts()).toHaveLength(2);
  expect(t.starts().at(-1)).toContain("started 0.3.0");
});

test("the same version asks: cancel exits 0, changes nothing and does not start the app", async () => {
  const bun = await bunHost();
  const t = setup({ pin: bun.pin });
  await t.start([], { CGS_BUN_BASE_URL: bun.base });
  const before = readFileSync(t.installed, "utf8");
  const result = await t.start([], { CGS_INSTALLER_ACTION: "cancel", CGS_BUN_BASE_URL: bun.base });
  expect(result.code).toBe(0);
  expect(readFileSync(t.installed, "utf8")).toBe(before);
  expect(t.starts()).toHaveLength(1);
});

test("the same version asks: uninstall removes the app, entry, icons, config root, userData, updater cache and the CLI", async () => {
  const bun = await bunHost();
  const t = setup({ pin: bun.pin });
  await t.start([], { CGS_BUN_BASE_URL: bun.base });
  userState(t);
  mkdirSync(path.join(t.bunRoot, "install", "global", "node_modules", "@cicori", "cgs"), { recursive: true });
  writeFileSync(path.join(t.bunRoot, "install", "global", "node_modules", "@cicori", "cgs", "package.json"), "{}");
  writeFileSync(path.join(t.bunRoot, "install", "global", "package.json"), JSON.stringify({ dependencies: { "@cicori/cgs": "^1.0.0" } }));
  writeFileSync(path.join(t.bunRoot, "bin", "cgs"), "#!/bin/sh\n");
  chmodSync(path.join(t.bunRoot, "bin", "cgs"), 0o755);
  writeFileSync(path.join(t.bunRoot, "bin", "bunx"), "#!/bin/sh\n");
  chmodSync(path.join(t.bunRoot, "bin", "bunx"), 0o755);
  const result = await t.start([], { CGS_INSTALLER_ACTION: "uninstall", CGS_BUN_BASE_URL: bun.base });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("CGS Desktop 已卸载");
  // Uninstall never starts the app: the only start is the one from the install above.
  expect(t.starts()).toHaveLength(1);
  expect(existsSync(t.installed)).toBe(false);
  expect(existsSync(path.join(t.data, "cgs-desktop"))).toBe(false);
  expect(existsSync(path.join(t.data, "applications", "cgs-desktop.desktop"))).toBe(false);
  expect(existsSync(path.join(t.data, "icons", "hicolor", "256x256", "apps", "cgs-desktop.png"))).toBe(false);
  expect(existsSync(path.join(t.home, ".cgs"))).toBe(false);
  expect(existsSync(path.join(t.config, "CGS Desktop"))).toBe(false);
  expect(existsSync(path.join(t.cache, "cgs-desktop-updater"))).toBe(false);
  expect(existsSync(path.join(t.config, "Unrelated", "keep"))).toBe(true);
  expect(existsSync(path.join(t.bunRoot, "install", "global", "node_modules", "@cicori", "cgs"))).toBe(false);
  expect(existsSync(path.join(t.bunRoot, "bin", "cgs"))).toBe(false);
  expect(readFileSync(path.join(t.bunRoot, "install", "global", "package.json"), "utf8")).not.toContain("@cicori/cgs");
  // The marker says the desktop installed bun, so its binary goes too; the global directory keeps the files of others.
  expect(existsSync(path.join(t.bunRoot, "bin", "bun"))).toBe(false);
  expect(existsSync(path.join(t.bunRoot, "bin", "bunx"))).toBe(false);
  expect(existsSync(path.join(t.bunRoot, ".cgs-desktop-installed"))).toBe(false);
});

test("uninstall from the installer runs this installer's uninstaller, not the older installed copy", async () => {
  const t = setup();
  await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  writeFileSync(path.join(t.data, "cgs-desktop", "uninstall.sh"), `#!/bin/sh\ntouch "${path.join(t.root, "old-uninstaller-ran")}"\n`);
  const result = await t.start([], { CGS_INSTALLER_ACTION: "uninstall", CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(result.code).toBe(0);
  expect(existsSync(path.join(t.root, "old-uninstaller-ran"))).toBe(false);
  expect(existsSync(t.installed)).toBe(false);
});

test("the same version asks: closing the dialog cancels, and choosing uninstall uninstalls", async () => {
  const bun = await bunHost();
  const t = setup({ pin: bun.pin });
  await t.start([], { CGS_BUN_BASE_URL: bun.base });
  userState(t);
  fakeZenity(t.bin, "exit 1");
  const canceled = await t.start([], { CGS_BUN_BASE_URL: bun.base });
  expect(canceled.code).toBe(0);
  expect(existsSync(t.installed)).toBe(true);
  expect(existsSync(path.join(t.home, ".cgs", "desktop.json"))).toBe(true);
  expect(t.starts()).toHaveLength(1);
  const dialogArgs = readFileSync(path.join(t.bin, "zenity.args"), "utf8");
  expect(dialogArgs).toContain("--radiolist");
  expect(dialogArgs).toContain("--print-column=2");
  expect(dialogArgs).toContain("登录凭据");
  // The dialog's choice is the whole answer; the uninstaller then runs without asking again.
  fakeZenity(t.bin, "printf '卸载（删除程序、登录凭据、所有会话和聊天记录）\\n'");
  const removed = await t.start([], { CGS_BUN_BASE_URL: bun.base });
  expect(removed.code).toBe(0);
  expect(existsSync(t.installed)).toBe(false);
  expect(existsSync(path.join(t.home, ".cgs"))).toBe(false);
  expect(t.starts()).toHaveLength(1);
});

test("a newer installer offers upgrade in the dialog; choosing it (or CGS_INSTALLER_ACTION) upgrades", async () => {
  const t = setup({ bundled: "0.5.0" });
  mkdirSync(path.dirname(t.installed), { recursive: true });
  fakeAppImage(t.installed, "0.4.0", t.log);
  fakeZenity(t.bin, "printf '升级（从 0.4.0 到 0.5.0）\\n'");
  const chosen = await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(chosen.code).toBe(0);
  expect(readFileSync(path.join(t.bin, "zenity.args"), "utf8")).toContain("升级");
  expect(chosen.stderr).toContain("(upgrade)");
  expect(readFileSync(t.installed, "utf8")).toContain("0.5.0");
  expect(t.starts().at(-1)).toContain("started 0.5.0");
  // The same choice without a dialog.
  fakeAppImage(t.installed, "0.4.0", t.log);
  const fromEnv = await t.start([], { CGS_INSTALLER_ACTION: "upgrade", CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(fromEnv.code).toBe(0);
  expect(fromEnv.stderr).toContain("(upgrade)");
  expect(readFileSync(t.installed, "utf8")).toContain("0.5.0");
  expect(t.starts().at(-1)).toContain("started 0.5.0");
});

test("KDialog displays action labels and returns the selected action key", async () => {
  const t = setup({ bundled: "0.5.0" });
  mkdirSync(path.dirname(t.installed), { recursive: true });
  fakeAppImage(t.installed, "0.4.0", t.log);
  // Model KDialog's documented key/label/default triples and the user's choice of the Chinese upgrade label.
  writeFileSync(path.join(t.bin, "kdialog"), `#!/bin/sh
shift 4
while [ "$#" -ge 3 ]; do
  case "$2" in 升级*) printf '%s\\n' "$1"; exit 0 ;; esac
  shift 3
done
exit 1
`, { mode: 0o755 });
  const result = await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(result.code).toBe(0);
  expect(t.starts().at(-1)).toContain("started 0.5.0");
});

test("an older bundled app offers reinstall, labelled as replacing the newer installed one", async () => {
  const t = setup({ bundled: "0.3.0" });
  mkdirSync(path.dirname(t.installed), { recursive: true });
  fakeAppImage(t.installed, "0.5.0", t.log);
  // No terminal, no dialog and no choice: today's behaviour keeps the newer app and starts it.
  const kept = await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(kept.code).toBe(0);
  expect(t.starts().at(-1)).toContain("started 0.5.0");
  const reinstalled = await t.start([], { CGS_INSTALLER_ACTION: "reinstall", CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(reinstalled.code).toBe(0);
  expect(reinstalled.stderr).toContain("(reinstall)");
  expect(readFileSync(t.installed, "utf8")).toContain("0.3.0");
  expect(t.starts().at(-1)).toContain("started 0.3.0");
});

test("without a terminal or a dialog tool the run keeps today's behaviour and says how to uninstall", async () => {
  const same = setup();
  await same.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  const kept = await same.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(kept.code).toBe(0);
  expect(kept.stderr).toContain(path.join(same.data, "cgs-desktop", "uninstall.sh"));
  expect(kept.stderr).toContain("CGS_INSTALLER_ACTION=uninstall");
  expect(same.starts()).toHaveLength(2);

  const newer = setup({ bundled: "0.5.0" });
  mkdirSync(path.dirname(newer.installed), { recursive: true });
  fakeAppImage(newer.installed, "0.4.0", newer.log);
  const upgraded = await newer.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(upgraded.code).toBe(0);
  expect(upgraded.stderr).toContain("(upgrade)");
  expect(upgraded.stderr).toContain("CGS_INSTALLER_ACTION=uninstall");
  expect(newer.starts().at(-1)).toContain("started 0.5.0");
});

test("upgrade is not offered when the bundled app is not newer, and an invalid action fails", async () => {
  const t = setup();
  await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  const notNewer = await t.start([], { CGS_INSTALLER_ACTION: "upgrade", CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(notNewer.code).not.toBe(0);
  expect(notNewer.stderr).toContain("只在安装包版本较新时可用");
  const bogus = await t.start([], { CGS_INSTALLER_ACTION: "bogus", CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(bogus.code).not.toBe(0);
  expect(bogus.stderr).toContain("CGS_INSTALLER_ACTION 的值无效");
  expect(t.starts()).toHaveLength(1);
});

test("the uninstaller refuses to delete anything without --yes when it cannot ask", async () => {
  const t = setup();
  await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  userState(t);
  const result = await t.uninstall();
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("未删除任何内容");
  expect(result.stderr).toContain("--yes");
  expect(existsSync(t.installed)).toBe(true);
  expect(existsSync(path.join(t.data, "cgs-desktop", "uninstall.sh"))).toBe(true);
  expect(existsSync(path.join(t.home, ".cgs", "agent", "cgs", "credentials.json"))).toBe(true);
});

test("the uninstaller removes a bun only when the desktop installed it", async () => {
  const kept = setup();
  await kept.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  const mine = path.join(kept.bunRoot, "bin", "bun");
  mkdirSync(path.dirname(mine), { recursive: true });
  writeFileSync(mine, "#!/bin/sh\nexit 0\n");
  chmodSync(mine, 0o755);
  expect((await kept.uninstall(["--yes"])).code).toBe(0);
  expect(existsSync(mine)).toBe(true);

  const bun = await bunHost();
  const removed = setup({ pin: bun.pin });
  await removed.start([], { CGS_BUN_BASE_URL: bun.base });
  expect(existsSync(path.join(removed.bunRoot, ".cgs-desktop-installed"))).toBe(true);
  expect((await removed.uninstall(["--yes"])).code).toBe(0);
  expect(existsSync(removed.bunRoot)).toBe(false);
});

test("without Bun or Python, uninstall removes the CLI files without damaging other packages' metadata", async () => {
  const t = setup();
  const result = await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(result.code).toBe(0);
  rmSync(path.join(t.bin, "python3"));
  const global = path.join(t.bunRoot, "install", "global");
  const cli = path.join(global, "node_modules", "@cicori", "cgs");
  mkdirSync(cli, { recursive: true });
  const manifest = JSON.stringify({ dependencies: { "@cicori/cgs": "1.0.0", "other-package": "2.0.0" } });
  const lock = JSON.stringify({ packages: { "@cicori/cgs": [], "other-package": [] } });
  writeFileSync(path.join(global, "package.json"), manifest);
  writeFileSync(path.join(global, "bun.lock"), lock);
  expect((await t.uninstall(["--yes"])).code).toBe(0);
  expect(existsSync(cli)).toBe(false);
  expect(readFileSync(path.join(global, "package.json"), "utf8")).toBe(manifest);
  expect(readFileSync(path.join(global, "bun.lock"), "utf8")).toBe(lock);
});

test("the uninstaller asks through a dialog when there is no terminal, and declines without deleting", async () => {
  const t = setup();
  await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  userState(t);
  fakeZenity(t.bin, "exit 1");
  const declined = await t.uninstall();
  expect(declined.code).toBe(0);
  expect(readFileSync(path.join(t.bin, "zenity.args"), "utf8")).toContain("--question");
  expect(readFileSync(path.join(t.bin, "zenity.args"), "utf8")).toContain("登录凭据");
  expect(existsSync(t.installed)).toBe(true);
  expect(existsSync(path.join(t.home, ".cgs", "agent", "cgs", "credentials.json"))).toBe(true);
  // Saying yes in the dialog deletes without a second question.
  fakeZenity(t.bin, "printf 'yes\n'");
  const confirmed = await t.uninstall();
  expect(confirmed.code).toBe(0);
  expect(existsSync(t.installed)).toBe(false);
  expect(existsSync(path.join(t.home, ".cgs"))).toBe(false);
});

test("the uninstaller shuts the daemon down through the installed CLI's own module", async () => {
  const t = setup();
  await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  const pkg = path.join(t.bunRoot, "install", "global", "node_modules", "@cicori", "cgs");
  const control = path.join(pkg, "packages", "connect", "src", "desktop", "daemon-control.ts");
  mkdirSync(path.dirname(control), { recursive: true });
  writeFileSync(control, "// fake hosted module\n");
  mkdirSync(path.join(pkg, "bin"), { recursive: true });
  const cli = path.join(pkg, "bin", "cgs");
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$@" > "${path.join(t.root, "cgs-args")}"\n`);
  chmodSync(cli, 0o755);
  mkdirSync(path.join(t.bunRoot, "bin"), { recursive: true });
  symlinkSync(cli, path.join(t.bunRoot, "bin", "cgs"));
  expect((await t.uninstall(["--yes"])).code).toBe(0);
  expect(readFileSync(path.join(t.root, "cgs-args"), "utf8").trim().split("\n")).toEqual(["__cgs_worker_module", control, "shutdown"]);
});

test("the uninstaller stops the app started from the installed image, and only that one", async () => {
  const t = setup();
  await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  const sleeping = () => {
    const child = spawn("sleep", ["300"], { env: { ...t.env(), APPIMAGE: t.installed }, stdio: "ignore" });
    children.push(child);
    return child;
  };
  const victim = sleeping();
  const unrelated = spawn("sleep", ["300"], { env: { ...t.env(), APPIMAGE: "/somewhere/else.AppImage" }, stdio: "ignore" });
  children.push(unrelated);
  // Let both processes exist before the scan.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const result = await t.uninstall(["--yes"]);
  expect(result.code).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(victim.signalCode).toBe("SIGTERM");
  expect(unrelated.exitCode).toBe(null);
  expect(unrelated.signalCode).toBe(null);
  unrelated.kill("SIGKILL");
});

test("the uninstaller honours a PI_CONFIG_DIR relative to HOME", async () => {
  const t = setup();
  await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  const dir = path.join(t.home, "custom-cgs");
  mkdirSync(path.join(dir, "agent"), { recursive: true });
  writeFileSync(path.join(dir, "agent", "credentials.json"), "{}");
  const result = await t.uninstall(["--yes"], { PI_CONFIG_DIR: "custom-cgs" });
  expect(result.code).toBe(0);
  expect(existsSync(dir)).toBe(false);
});

test("a Python below 3.8 stops the install with the version it found, and nothing is written", async () => {
  const t = setup();
  const old = path.join(t.root, "python-old");
  writeFileSync(old, "#!/bin/sh\necho 3.7.9\n");
  chmodSync(old, 0o755);
  const result = await t.start([], { CGS_INSTALLER_PYTHON: old });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("系统自带的 Python 版本太旧，请先更新 Python 后再继续");
  expect(result.stderr).toContain("3.7.9");
  expect(existsSync(path.join(t.data, "cgs-desktop"))).toBe(false);
  expect(t.starts()).toEqual([]);
});

test("a missing Python is reported, not mistaken for an old one", async () => {
  const t = setup();
  const result = await t.start([], { CGS_INSTALLER_PYTHON: "python-that-does-not-exist" });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("未找到系统自带的 Python");
});

test("a damaged installed app is repaired without asking", async () => {
  const t = setup({ bundled: "0.5.0" });
  mkdirSync(path.dirname(t.installed), { recursive: true });
  writeFileSync(t.installed, "garbage");
  chmodSync(t.installed, 0o755);
  const result = await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("(repair)");
  expect(t.starts().at(-1)).toContain("started 0.5.0");
});

test("paths with spaces and quotes stay one argument in the launcher entry", async () => {
  const t = setup();
  const odd = path.join(t.root, 'data "x" $y');
  const result = await t.start([], { XDG_DATA_HOME: odd, CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(result.code).toBe(0);
  const entry = readFileSync(path.join(odd, "applications", "cgs-desktop.desktop"), "utf8");
  expect(entry).toContain(`Exec=${t.launch}"${path.join(odd, "cgs-desktop", "CGS-Desktop.AppImage").replace(/\\/g, "\\\\\\\\").replace(/["`$]/g, "\\\\$&")}" %U`);
});
