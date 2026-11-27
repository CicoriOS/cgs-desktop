// CLI sync (ADR 0046 §3): version order, shadow detection, the install plan, and the real install path against fake
// bun/cgs shell scripts in a temporary PATH. Nothing here touches the machine's real bun install or ~/.cgs.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  classifyInstallFailure,
  compareCgsVersions,
  createCliSync,
  detectDaemon,
  inspectInstall,
  markerPath,
  parseVersionOutput,
  planCliSync,
} from "../../desktop/cli-sync.mjs";

const dirs = [];
function tempDir(prefix = "cgs-cli-sync-") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BOUND = "19.2.1-cgs.5.4";

test("version order follows the omp base, then N, then M", () => {
  expect(compareCgsVersions("19.2.1-cgs.5.4", "19.2.1-cgs.5.3")).toBe(1);
  expect(compareCgsVersions("19.2.1-cgs.5.3", "19.2.1-cgs.5.4")).toBe(-1);
  expect(compareCgsVersions("19.2.1-cgs.5.4", "19.2.1-cgs.5.4")).toBe(0);
  expect(compareCgsVersions("19.2.1-cgs.6", "19.2.1-cgs.5.9")).toBe(1);
  expect(compareCgsVersions("20.0.0-cgs.1", "19.2.1-cgs.9")).toBe(1);
  expect(compareCgsVersions("19.2.1-cgs.5.4", "19.2.1-cgs.5")).toBe(1);
  expect(() => compareCgsVersions("19.2.1", BOUND)).toThrow();
});

test("the version is read from cgs/<version> or a bare version", () => {
  expect(parseVersionOutput("cgs/19.2.1-cgs.5.3")).toBe("19.2.1-cgs.5.3");
  expect(parseVersionOutput("19.2.1-cgs.5.3\n")).toBe("19.2.1-cgs.5.3");
  expect(parseVersionOutput("something else")).toBeUndefined();
});

/** statSync/accessSync over a fixed set of files; realpathSync maps the paths a fixture wants. */
function fakeFs({ files = [], links = {} } = {}) {
  const set = new Set(files);
  return {
    statSync(candidate) {
      if (!set.has(candidate)) throw new Error("ENOENT");
      return { isFile: () => true };
    },
    accessSync(candidate) {
      if (!set.has(candidate)) throw new Error("EACCES");
    },
    realpathSync(candidate) {
      return links[candidate] ?? candidate;
    },
    existsSync(candidate) {
      return set.has(candidate);
    },
  };
}

test("every executable cgs is found; the bun-global one is the overwritable copy", () => {
  const found = inspectInstall({
    env: { BUN_INSTALL: "/opt/bun", PATH: "/usr/local/bin:/opt/bun/bin" },
    home: "/home/u",
    fs: fakeFs({
      files: ["/opt/bun/bin/cgs", "/home/u/.bun/bin/cgs", "/usr/local/bin/cgs"],
      links: {
        "/opt/bun/bin/cgs": "/opt/bun/install/global/node_modules/@cicori/cgs/scripts/cgs.ts",
        "/home/u/.bun/bin/cgs": "/home/u/.bun/install/global/node_modules/@cicori/cgs/scripts/cgs.ts",
        "/usr/local/bin/cgs": "/usr/local/bin/cgs",
      },
    }),
  });
  expect(found.winner.path).toBe("/opt/bun/bin/cgs");
  expect(found.winner.bunGlobal).toBe(true);
  expect(found.shadowed).toEqual(["/home/u/.bun/bin/cgs", "/usr/local/bin/cgs"]);
  const second = found.entries.find((entry) => entry.path === "/home/u/.bun/bin/cgs");
  expect(second?.bunGlobal).toBe(false);
});

test("the plan refuses only a newer major, upgrades an older bun copy and leaves a foreign copy alone", () => {
  const bunGlobal = { path: "/opt/bun/bin/cgs", bunGlobal: true };
  const foreign = { path: "/usr/local/bin/cgs", bunGlobal: false };
  expect(planCliSync({ found: undefined, installed: undefined, bound: BOUND, bun: "/opt/bun/bin/bun" })).toEqual({ action: "install" });
  expect(planCliSync({ found: undefined, installed: undefined, bound: BOUND, bun: undefined })).toEqual({ action: "error", code: "bun_missing" });
  expect(planCliSync({ found: bunGlobal, installed: "19.2.1-cgs.5.3", bound: BOUND, bun: "/opt/bun/bin/bun" })).toEqual({ action: "upgrade" });
  expect(planCliSync({ found: foreign, installed: "19.2.1-cgs.5.3", bound: BOUND, bun: "/opt/bun/bin/bun" })).toEqual({ action: "error", code: "cgs_not_managed" });
  expect(planCliSync({ found: bunGlobal, installed: "19.2.1-cgs.6.1", bound: BOUND, bun: "/opt/bun/bin/bun" })).toEqual({ action: "refuse", code: "cgs_too_new" });
  expect(planCliSync({ found: bunGlobal, installed: "19.2.1-cgs.5.4", bound: BOUND, bun: "/opt/bun/bin/bun" })).toEqual({ action: "use", managed: true });
  expect(planCliSync({ found: bunGlobal, installed: "19.2.1-cgs.5.9", bound: BOUND, bun: undefined })).toEqual({ action: "use", managed: true });
  expect(planCliSync({ found: foreign, installed: "19.2.1-cgs.5.4", bound: BOUND, bun: undefined })).toEqual({ action: "use", managed: false });
});

test("offline installs are told apart from other failures", () => {
  expect(classifyInstallFailure("error: Failed to fetch @cicori/cgs: ENOTFOUND registry.npmjs.org")).toBe("offline");
  expect(classifyInstallFailure("error: EACCES: permission denied")).toBe("install_failed");
});

test("a daemon needs its lock and db, and then a listening socket", async () => {
  const root = tempDir();
  const daemonDir = path.join(root, ".cgs", "run", "daemon");
  mkdirSync(daemonDir, { recursive: true });
  const env = {};
  const home = root;
  expect((await detectDaemon({ home, env, fs: fakeFs(), probe: async () => true })).running).toBe(false);
  writeFileSync(path.join(daemonDir, "daemon.lock"), "");
  writeFileSync(path.join(daemonDir, "daemon.db"), "");
  expect((await detectDaemon({ home, env, fs: fakeFs({ files: [path.join(daemonDir, "daemon.lock"), path.join(daemonDir, "daemon.db")] }), probe: async () => true })).running).toBe(true);
  expect((await detectDaemon({ home, env, fs: fakeFs({ files: [path.join(daemonDir, "daemon.lock"), path.join(daemonDir, "daemon.db")] }), probe: async () => false })).running).toBe(false);
});

// --- fake executables ----------------------------------------------------------------------------------------------

/** A fake bun install: `<root>/bin/{bun,cgs}` shell scripts, plus whatever `cgs` prints for --version. */
function fakeInstall({ version, bun = true } = {}) {
  const root = tempDir();
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const cgs = path.join(bin, "cgs");
  if (version) {
    writeFileSync(cgs, `#!/bin/sh\necho cgs/${version}\n`);
    chmodSync(cgs, 0o755);
  }
  if (bun) {
    writeFileSync(
      path.join(bin, "bun"),
      `#!/bin/sh
log="$BUN_INSTALL/bun.log"
echo "$@" >> "$log"
if [ "$1" = "add" ] && [ "$2" = "-g" ]; then
  printf '#!/bin/sh\\necho cgs/19.2.1-cgs.5.4\\n' > "$BUN_INSTALL/bin/cgs"
  chmod +x "$BUN_INSTALL/bin/cgs"
  echo "installed $3"
  exit 0
fi
exit 1
`,
    );
    chmodSync(path.join(bin, "bun"), 0o755);
  }
  return { root, bin, cgs, env: { HOME: root, BUN_INSTALL: root, PATH: `${bin}:/usr/bin:/bin`, PI_CONFIG_DIR: ".cgs" } };
}

const app = { getVersion: () => "0.3.0", getPath: (key) => (key === "exe" ? "/opt/cgs-desktop" : tempDir()) };

test("a missing CLI is installed with bun and the marker is written", async () => {
  const fake = fakeInstall({ version: undefined });
  const sync = createCliSync({ app, env: fake.env, home: fake.root, boundVersion: BOUND });
  const state = await sync.start();
  expect(state.phase).toBe("ready");
  expect(state.version).toBe(BOUND);
  expect(state.cgs).toBe(fake.cgs);
  expect(readFileSync(path.join(fake.root, "bun.log"), "utf8")).toContain("add -g @cicori/cgs@19.2.1-cgs.5.4");
  const marker = JSON.parse(readFileSync(markerPath({ home: fake.root, env: fake.env }), "utf8"));
  expect(marker).toMatchObject({ desktop: "/opt/cgs-desktop", version: "0.3.0" });
});

test("an older bun-global CLI is upgraded", async () => {
  const fake = fakeInstall({ version: "19.2.1-cgs.5.3" });
  const sync = createCliSync({ app, env: fake.env, home: fake.root, boundVersion: BOUND });
  const state = await sync.start();
  expect(state.phase).toBe("ready");
  expect(state.version).toBe(BOUND);
  expect(state.progress?.join("\n")).toContain("installed @cicori/cgs@19.2.1-cgs.5.4");
});

test("a newer major refuses to start and installs nothing", async () => {
  const fake = fakeInstall({ version: "19.2.1-cgs.6.1" });
  const sync = createCliSync({ app, env: fake.env, home: fake.root, boundVersion: BOUND });
  const state = await sync.start();
  expect(state.phase).toBe("refused");
  expect(state.code).toBe("cgs_too_new");
  expect(() => readFileSync(path.join(fake.root, "bun.log"))).toThrow();
});

test("no bun and no CLI is bun_missing with the instructions detail", async () => {
  const fake = fakeInstall({ version: undefined, bun: false });
  const sync = createCliSync({ app, env: fake.env, home: fake.root, boundVersion: BOUND });
  const state = await sync.start();
  expect(state.phase).toBe("error");
  expect(state.code).toBe("bun_missing");
  expect(state.detail).toContain("Install bun");
});
