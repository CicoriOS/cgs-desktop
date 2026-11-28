// Builds the Linux outer installer (ADR 0050 §2) from the inner AppImage electron-builder just produced:
//   dist-desktop/CGS-Desktop-<version>-x86_64.AppImage            inner: the app, what electron-updater replaces
//   dist-desktop/CGS-Desktop-Installer-<version>-x86_64.AppImage  outer: AppRun shell script + the inner one as payload
// electron-builder makes one AppImage per run, so the outer is assembled here: the inner AppImage's own runtime (the ELF
// before its squashfs) followed by a squashfs of installer/linux/ and the payload. No download and no appimagetool.
// `latest-linux.yml` stays electron-builder's, which names the inner file; this script refuses to continue if it does not.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = path.join(root, "installer", "linux");
const output = path.join(root, "dist-desktop");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const innerName = `CGS-Desktop-${version}-x86_64.AppImage`;
const outerName = `CGS-Desktop-Installer-${version}-x86_64.AppImage`;

/** Size of the AppImage runtime: the end of the ELF's section header table, which is where the squashfs starts. */
function runtimeSize(elfHeader) {
  if (elfHeader.readUInt32BE(0) !== 0x7f454c46 || elfHeader[4] !== 2) throw new Error("not a 64-bit ELF file");
  return Number(elfHeader.readBigUInt64LE(0x28)) + elfHeader.readUInt16LE(0x3a) * elfHeader.readUInt16LE(0x3c);
}

function fail(message) {
  console.error(`installer: ${message}`);
  process.exit(1);
}

const innerPath = path.join(output, innerName);
if (!fs.existsSync(innerPath)) fail(`${innerPath} not found; run electron-builder first`);

// The update feed must name the inner AppImage and only that.
const feed = fs.readFileSync(path.join(output, "latest-linux.yml"), "utf8");
if (!feed.includes(`path: ${innerName}`) || /installer/i.test(feed)) fail(`latest-linux.yml must point at ${innerName} and not mention the installer`);

const handle = fs.openSync(innerPath, "r");
const header = Buffer.alloc(64);
fs.readSync(handle, header, 0, 64, 0);
const offset = runtimeSize(header);
const runtime = Buffer.alloc(offset);
fs.readSync(handle, runtime, 0, offset, 0);
fs.closeSync(handle);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-installer-"));
try {
  const appDir = path.join(stage, "AppDir");
  const payload = path.join(appDir, "payload");
  fs.mkdirSync(path.join(payload, "icons"), { recursive: true });
  fs.copyFileSync(path.join(source, "AppRun"), path.join(appDir, "AppRun"));
  fs.chmodSync(path.join(appDir, "AppRun"), 0o755);
  fs.copyFileSync(path.join(source, "bootstrap.py"), path.join(payload, "bootstrap.py"));
  fs.copyFileSync(path.join(source, "uninstall.sh"), path.join(payload, "uninstall.sh"));
  fs.writeFileSync(path.join(payload, "VERSION"), `${version}\n`);
  fs.writeFileSync(path.join(payload, "bun-pin.json"), `${JSON.stringify(pkg.bunInstall)}\n`);
  for (const file of fs.readdirSync(path.join(root, "assets", "icons"))) fs.copyFileSync(path.join(root, "assets", "icons", file), path.join(payload, "icons", file));
  fs.copyFileSync(innerPath, path.join(payload, "CGS-Desktop.AppImage"));
  // What an AppImage tool expects to find; the installer itself shows nothing.
  fs.copyFileSync(path.join(root, "assets", "icons", "256.png"), path.join(appDir, "cgs-desktop-installer.png"));
  fs.copyFileSync(path.join(appDir, "cgs-desktop-installer.png"), path.join(appDir, ".DirIcon"));
  fs.writeFileSync(
    path.join(appDir, "cgs-desktop-installer.desktop"),
    `[Desktop Entry]\nType=Application\nName=CGS Desktop Installer\nExec=AppRun\nIcon=cgs-desktop-installer\nCategories=Development;\nX-AppImage-Version=${version}\n`,
  );
  // The payload is an AppImage already (compressed); compressing it again only costs time.
  const squashfs = path.join(stage, "installer.squashfs");
  execFileSync("mksquashfs", [appDir, squashfs, "-no-compression", "-noappend", "-root-owned", "-quiet"], { stdio: ["ignore", "inherit", "inherit"] });
  const target = path.join(output, outerName);
  fs.writeFileSync(target, runtime);
  fs.appendFileSync(target, fs.readFileSync(squashfs));
  fs.chmodSync(target, 0o755);
  console.log(`installer: wrote ${path.relative(root, target)} (${(fs.statSync(target).size / 1048576).toFixed(0)} MB, runtime ${offset} bytes)`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
