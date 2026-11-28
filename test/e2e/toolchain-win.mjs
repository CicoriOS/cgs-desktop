// Windows first-run toolchain, for real (ADR 0049): runs createToolchain().ensure() against the live mirrors with the bundled
// aria2c.exe and bun.exe, then asks every installed tool for its version. Meant for a Windows guest, run by the bundled bun:
//   bun.exe test/e2e/toolchain-win.mjs <tools dir> <scratch dir>
// `scratch` becomes LOCALAPPDATA and the home directory, so nothing outside it is touched. Exit code 0 only when every component
// installed and answered.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createToolchain } from "../../desktop/toolchain/install.mjs";
import { toolchainEnv } from "../../desktop/toolchain/manifest.mjs";

const [tools, scratch] = process.argv.slice(2);
if (!tools || !scratch) {
  console.error("usage: toolchain-win.mjs <tools dir> <scratch dir>");
  process.exit(2);
}
fs.mkdirSync(scratch, { recursive: true });
const env = { ...process.env, LOCALAPPDATA: path.join(scratch, "Local"), CGS_TOOLS_DIR: tools, PI_CONFIG_DIR: ".cgs" };
const home = path.join(scratch, "home");
fs.mkdirSync(home, { recursive: true });

const started = Date.now();
const stamp = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s`;
const toolchain = createToolchain({ env, home, resourcesPath: path.dirname(tools), fetch: (...args) => fetch(...args) });
let last = "";
toolchain.subscribe(() => {
  const line = toolchain
    .components()
    .map((item) => `${item.id}=${item.state}${item.state === "downloading" && item.total ? `:${Math.round((item.received / item.total) * 100)}%` : ""}`)
    .join(" ");
  if (line !== last) console.log(`${stamp()} ${line}`);
  last = line;
});

let pipResult;
try {
  const { pip } = await toolchain.ensure();
  console.log(`${stamp()} components installed; waiting for pip`);
  pipResult = await pip;
} catch (error) {
  console.log(`FAIL ${stamp()} ${error.code ?? ""} ${error.message}`);
  if (error.log) console.log(String(error.log).split("\n").slice(-25).join("\n"));
  process.exit(1);
}
console.log(`${stamp()} pip: ${JSON.stringify(pipResult.ok ? { ok: true } : pipResult)}`);

// Ask each tool as the agent would see it: through the environment the sidecar gets.
// The app's sidecar gets the bundled bun on PATH too (platform.sidecarEnv); the shims of bun-installed packages need it.
const agent = toolchainEnv({ env: { ...env, Path: `${tools};${env.Path ?? env.PATH ?? ""}` }, platform: "win32", home });
const run = (command, args) => {
  try {
    return execFileSync(command, args, { env: agent, encoding: "utf8", timeout: 120_000, windowsHide: true, shell: command.endsWith(".cmd") }).trim().split(/\r?\n/).find((line) => line.trim()) ?? "";
  } catch (error) {
    return `ERROR ${error.message.split("\n")[0]}`;
  }
};
const root = toolchain.root;
const checks = {
  git: run("git", ["--version"]),
  bash: run("bash", ["-c", "echo bash-ok; uname -s"]),
  python: run("python", ["--version"]),
  pip: run("python", ["-c", "import paramiko, numpy, scipy, sympy, psutil, requests; print('pip-packages-ok')"]),
  clang: run("clang", ["--version"]),
  clangd: run("clangd", ["--version"]),
  gcc: run("x86_64-w64-mingw32-gcc", ["--version"]),
  rustc: run("rustc", ["--version"]),
  cargo: run("cargo", ["--version"]),
  "rust-analyzer": run("rust-analyzer", ["--version"]),
  pyright: run("pyright", ["--version"]),
  tsls: run("typescript-language-server", ["--version"]),
  // chrome.exe is a GUI binary: it prints nothing for --version. Rendering a page headless proves the build runs.
  chromium: run(path.join(home, ".cgs", "puppeteer", "chrome", "win64-150.0.7871.24", "chrome-win64", "chrome.exe"), ["--headless=new", "--disable-gpu", "--no-sandbox", "--dump-dom", "data:text/html,<title>chrome-ok</title>"]),
};
let bad = 0;
for (const [name, answer] of Object.entries(checks)) {
  const ok = answer && !answer.startsWith("ERROR");
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name.padEnd(14)} ${answer}`);
}
// A C program through clang and a Rust program through cargo's linker prove the compiler pair, not just their --version.
try {
  const work = path.join(scratch, "build");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, "a.c"), '#include <stdio.h>\nint main(){puts("clang-ok");return 0;}\n');
  execFileSync("clang", [path.join(work, "a.c"), "-o", path.join(work, "a.exe")], { env: agent, windowsHide: true, timeout: 120_000 });
  console.log(`ok   clang-build    ${execFileSync(path.join(work, "a.exe"), { encoding: "utf8" }).trim()}`);
  fs.writeFileSync(path.join(work, "r.rs"), 'fn main(){println!("rustc-ok");}\n');
  execFileSync("rustc", [path.join(work, "r.rs"), "-o", path.join(work, "r.exe")], { env: agent, windowsHide: true, timeout: 180_000 });
  console.log(`ok   rustc-build    ${execFileSync(path.join(work, "r.exe"), { encoding: "utf8" }).trim()}`);
  fs.mkdirSync(path.join(work, "src"), { recursive: true });
  fs.writeFileSync(path.join(work, "Cargo.toml"), '[package]\nname = "hello"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.writeFileSync(path.join(work, "src", "main.rs"), 'fn main(){println!("cargo-ok");}\n');
  console.log(`ok   cargo-run      ${execFileSync("cargo", ["run", "--offline", "-q"], { cwd: work, env: agent, encoding: "utf8", timeout: 180_000, windowsHide: true }).trim()}`);
} catch (error) {
  bad += 1;
  console.log(`FAIL build ${String(error.stderr ?? error.message).split("\n").slice(0, 6).join(" | ")}`);
}
console.log(bad === 0 ? `PASS toolchain ${stamp()} root=${root}` : `FAIL ${bad} check(s)`);
process.exit(bad === 0 ? 0 : 1);
