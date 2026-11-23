// Builds vendor/<target>/cgs-agent/cgs-agent(.exe) from new-api's tunnelkit module (cmd/cgs-agent) with Go.
// Source: $CGS_NEWAPI_DIR, default ../new-api next to this repository. The production root keys are compiled into the
// agent (tunnelkit.ProductionRoots), so the binary must come from the same new-api revision the server runs.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GOOS = { "win-x64": "windows", "linux-x64": "linux" };

export async function buildAgent({ target, outDir }) {
  const src = path.resolve(process.env.CGS_NEWAPI_DIR || path.join(root, "..", "new-api"), "tunnelkit");
  if (!existsSync(path.join(src, "go.mod"))) throw new Error(`new-api tunnelkit not found at ${src} (set CGS_NEWAPI_DIR)`);
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: src, encoding: "utf8" }).trim();
  const version = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
  await mkdir(outDir, { recursive: true });
  const out = path.resolve(outDir, target === "win-x64" ? "cgs-agent.exe" : "cgs-agent");
  execFileSync("go", ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}+${commit.slice(0, 10)}`, "-o", out, "./cmd/cgs-agent"], {
    cwd: src,
    stdio: "inherit",
    env: { ...process.env, GOOS: GOOS[target], GOARCH: "amd64", CGO_ENABLED: "0" },
  });
  console.log(`cgs-agent: built from new-api ${commit.slice(0, 10)}`);
  return { commit, builtAt: new Date().toISOString() };
}
