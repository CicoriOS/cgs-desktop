// `bun run desktop`: Vite dev server (HMR) plus an Electron window on it. Edits under src/ show up in the window at once; closing it stops both.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { createServer, normalizePath } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lockfile = normalizePath(path.join(root, "bun.lock"));
const server = await createServer({
  root,
  server: { host: "127.0.0.1", port: 5173 },
  plugins: [{
    name: "cgs-desktop-refresh-dependencies",
    async hotUpdate({ file, server }) {
      if (file !== lockfile || this.environment.name !== "client") return;
      // Bun installs before writing the lockfile. Clear cached resolutions (including misses)
      // once the dependencies are in place. Vite reloads the window when its socket reconnects.
      await server.restart();
      return [];
    },
  }],
});
await server.listen();
const base = server.resolvedUrls?.local[0];
if (!base) throw new Error("Vite did not report its address");
console.log(`CGS Desktop dev shell: Vite on ${base}`);

// Linux: Chromium's sandbox helper must be root-owned and setuid. A dev checkout rarely has that; without it Electron refuses to start.
const args = [path.join(root, "desktop/main.mjs")];
if (process.platform === "linux") {
  const helper = statSync(path.join(path.dirname(String(electron)), "chrome-sandbox"));
  if (helper.uid !== 0 || (helper.mode & 0o4000) === 0) args.push("--no-sandbox");
}

const child = spawn(String(electron), args, { stdio: "inherit", env: { ...process.env, CGS_DEV_URL: `${base}?demo` } });
const stop = async (code) => {
  await server.close();
  process.exit(code ?? 0);
};
child.on("exit", stop);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
