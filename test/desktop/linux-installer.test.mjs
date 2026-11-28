// The Linux outer installer (ADR 0050 §2): AppRun and bootstrap.py run for real against a fake inner AppImage (a shell script
// that answers `--appimage-extract` like the real runtime and records how it was started). HOME and XDG_DATA_HOME are temporary,
// so nothing here touches the machine's real install, bun or launcher entries.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";

const run = promisify(execFile);
const SOURCE = path.resolve(import.meta.dirname, "..", "..", "installer", "linux");
const ICONS = path.resolve(import.meta.dirname, "..", "..", "assets", "icons");
const dirs = [];
const servers = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cgs-installer-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
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

function setup({ bundled = "0.3.0", pin = { version: "1.4.4", sha256: {} } } = {}) {
  const root = tempDir();
  const appdir = path.join(root, "AppDir");
  mkdirSync(path.join(appdir, "payload"), { recursive: true });
  cpSync(path.join(SOURCE, "AppRun"), path.join(appdir, "AppRun"));
  chmodSync(path.join(appdir, "AppRun"), 0o755);
  for (const name of ["bootstrap.py", "uninstall.sh"]) cpSync(path.join(SOURCE, name), path.join(appdir, "payload", name));
  cpSync(ICONS, path.join(appdir, "payload", "icons"), { recursive: true });
  writeFileSync(path.join(appdir, "payload", "VERSION"), `${bundled}\n`);
  writeFileSync(path.join(appdir, "payload", "bun-pin.json"), JSON.stringify(pin));
  const log = path.join(root, "starts.log");
  fakeAppImage(path.join(appdir, "payload", "CGS-Desktop.AppImage"), bundled, log);
  const home = path.join(root, "home");
  const data = path.join(root, "data");
  mkdirSync(home, { recursive: true });
  const installed = path.join(data, "cgs-desktop", "CGS-Desktop.AppImage");
  const env = (extra = {}) => ({
    // System directories only: the runner's own PATH can carry a bun, which the installer would rightly leave alone.
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_DATA_HOME: data,
    APPDIR: appdir,
    // Nothing from the developer's machine may decide the result.
    BUN_INSTALL: path.join(home, ".bun"),
    ...extra,
  });
  const start = (args = [], extra = {}) => run(path.join(appdir, "AppRun"), args, { env: env(extra) }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
  const starts = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { root, appdir, home, data, installed, log, env, start, starts };
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

const bootstrap = (...args) => run("python3", [path.join(SOURCE, "bootstrap.py"), ...args]).then(({ stdout }) => stdout.trim());

test("versions order like semver, a pre-release below its release", async () => {
  expect(await bootstrap("compare", "0.3.0", "0.3.0")).toBe("0");
  expect(await bootstrap("compare", "0.3.1", "0.3.0")).toBe("1");
  expect(await bootstrap("compare", "0.10.0", "0.9.0")).toBe("1");
  expect(await bootstrap("compare", "0.3.0-next", "0.3.0")).toBe("-1");
  expect(await bootstrap("compare", "0.3.0-next.2", "0.3.0-next.10")).toBe("-1");
  expect(await bootstrap("compare", "1.3", "1.3.0")).toBe("0");
});

test("a first run installs the app, the launcher entry, the icons and the uninstaller, then starts the installed app", async () => {
  const bun = await bunHost();
  const t = setup({ pin: bun.pin });
  const result = await t.start(["--flag"], { CGS_BUN_BASE_URL: bun.base });
  expect(result.code).toBe(0);
  expect(t.starts()).toEqual(["started 0.3.0 extract=no args=--flag"]);
  const entry = readFileSync(path.join(t.data, "applications", "cgs-desktop.desktop"), "utf8");
  expect(entry).toContain("Name=CGS Desktop");
  expect(entry).toContain("Icon=cgs-desktop");
  expect(entry).toContain("StartupWMClass=CGS Desktop");
  expect(entry).toContain(`Exec="${t.installed}" %U`);
  for (const size of [16, 256, 512]) expect(existsSync(path.join(t.data, "icons", "hicolor", `${size}x${size}`, "apps", "cgs-desktop.png"))).toBe(true);
  expect(existsSync(path.join(t.data, "cgs-desktop", "uninstall.sh"))).toBe(true);
  // bun came from the host named by CGS_BUN_BASE_URL, into $BUN_INSTALL/bin.
  expect(bun.hits).toHaveLength(1);
  expect(existsSync(path.join(t.home, ".bun", "bin", "bun"))).toBe(true);
});

test("an existing bun is never replaced or downloaded", async () => {
  const bun = await bunHost();
  const t = setup({ pin: bun.pin });
  const mine = path.join(t.home, ".bun", "bin", "bun");
  mkdirSync(path.dirname(mine), { recursive: true });
  writeFileSync(mine, "#!/bin/sh\necho mine\n");
  chmodSync(mine, 0o755);
  expect((await t.start([], { CGS_BUN_BASE_URL: bun.base })).code).toBe(0);
  expect(bun.hits).toEqual([]);
  expect(readFileSync(mine, "utf8")).toContain("echo mine");
});

test("a download that does not match the pinned checksum installs no bun, and the app still starts", async () => {
  const bun = await bunHost();
  const wrong = { ...bun.pin, sha256: Object.fromEntries(Object.keys(bun.pin.sha256).map((name) => [name, "0".repeat(64)])) };
  const t = setup({ pin: wrong });
  const result = await t.start([], { CGS_BUN_BASE_URL: bun.base });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("does not match the pinned checksum");
  expect(existsSync(path.join(t.home, ".bun", "bin", "bun"))).toBe(false);
  expect(t.starts()).toHaveLength(1);
});

test("a second run starts the installed app without copying it again", async () => {
  const t = setup();
  const env = { CGS_BUN_BASE_URL: "http://127.0.0.1:9" };
  await t.start([], env);
  const before = readFileSync(t.installed, "utf8");
  // The app updated itself in the meantime: the installed file is newer than the bundled one.
  fakeAppImage(t.installed, "0.4.0", t.log);
  const result = await t.start([], env);
  expect(result.code).toBe(0);
  expect(readFileSync(t.installed, "utf8")).not.toBe(before);
  expect(readFileSync(t.installed, "utf8")).toContain("0.4.0");
  expect(t.starts().at(-1)).toContain("started 0.4.0");
});

test("a newer installer replaces an older installed app, and a damaged one is repaired", async () => {
  const t = setup({ bundled: "0.5.0" });
  const env = { CGS_BUN_BASE_URL: "http://127.0.0.1:9" };
  mkdirSync(path.dirname(t.installed), { recursive: true });
  fakeAppImage(t.installed, "0.4.0", t.log);
  expect((await t.start([], env)).stderr).toContain("(upgrade)");
  expect(t.starts().at(-1)).toContain("started 0.5.0");
  writeFileSync(t.installed, "garbage");
  chmodSync(t.installed, 0o755);
  expect((await t.start([], env)).stderr).toContain("(repair)");
  expect(t.starts().at(-1)).toContain("started 0.5.0");
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

test("paths with spaces and quotes stay one argument in the launcher entry", async () => {
  const t = setup();
  const odd = path.join(t.root, 'data "x" $y');
  const result = await t.start([], { XDG_DATA_HOME: odd, CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  expect(result.code).toBe(0);
  const entry = readFileSync(path.join(odd, "applications", "cgs-desktop.desktop"), "utf8");
  expect(entry).toContain(`Exec="${path.join(odd, "cgs-desktop", "CGS-Desktop.AppImage").replace(/\\/g, "\\\\\\\\").replace(/["`$]/g, "\\\\$&")}" %U`);
});

test("the uninstaller removes the app, the entry and the icons but leaves user data", async () => {
  const t = setup();
  await t.start([], { CGS_BUN_BASE_URL: "http://127.0.0.1:9" });
  mkdirSync(path.join(t.home, ".cgs"), { recursive: true });
  writeFileSync(path.join(t.home, ".cgs", "keep"), "x");
  await run("sh", [path.join(t.data, "cgs-desktop", "uninstall.sh")], { env: t.env() });
  expect(existsSync(t.installed)).toBe(false);
  expect(existsSync(path.join(t.data, "cgs-desktop"))).toBe(false);
  expect(existsSync(path.join(t.data, "applications", "cgs-desktop.desktop"))).toBe(false);
  expect(existsSync(path.join(t.data, "icons", "hicolor", "256x256", "apps", "cgs-desktop.png"))).toBe(false);
  expect(existsSync(path.join(t.home, ".cgs", "keep"))).toBe(true);
});
