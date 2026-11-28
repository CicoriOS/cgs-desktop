// One child process, run to the end (CLI sync, toolchain installers): stdout and stderr are collected and each line is reported
// as it arrives. Never throws; a failure to start, a timeout and a non-zero exit all come back as data.
import { spawn as defaultSpawn } from "node:child_process";
import { spawnOptions } from "./platform.mjs";

const VERSION_TIMEOUT_MS = 20_000;

export function runProcess({ spawn = defaultSpawn, command, args = [], env = process.env, platform = process.platform, cwd, timeoutMs = VERSION_TIMEOUT_MS, onLine }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    const finish = (info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...info });
    };
    let timer;
    try {
      child = spawn(command, args, { ...spawnOptions(command, platform), env, ...(cwd ? { cwd } : {}), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      finish({ code: null, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ code: null, timedOut: true });
    }, timeoutMs);
    const collect = (stream, append) => {
      stream?.setEncoding("utf8");
      let rest = "";
      stream?.on("data", (chunk) => {
        append(chunk);
        rest += chunk;
        let index;
        while ((index = rest.indexOf("\n")) >= 0) {
          onLine?.(rest.slice(0, index).replace(/\r$/, ""));
          rest = rest.slice(index + 1);
        }
      });
      stream?.on("end", () => {
        if (rest) onLine?.(rest.replace(/\r$/, ""));
      });
      stream?.on("error", () => {});
    };
    collect(child.stdout, (chunk) => {
      stdout += chunk;
    });
    collect(child.stderr, (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ code: null, error: error.message }));
    child.on("close", (code, signal) => finish({ code, signal }));
  });
}
