// A minimal JSONL sidecar for desktop/sidecar.mjs tests and the Xvfb smoke. Modes:
//   serve (default) — hello, answers req/call, echoes, exits on shutdown; `{"type":"crash"}` exits with code 3
//   old             — announces protocol 0 (the supervisor must report "upgrade" and stop)
//   mute            — says nothing (the handshake never completes)
// FAKE_SIDECAR_LOG appends one line per request for the smoke test to assert on.
import { appendFileSync } from "node:fs";

const mode = process.argv[2] ?? "serve";
const logFile = process.env.FAKE_SIDECAR_LOG;

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const note = (line) => {
  if (logFile) appendFileSync(logFile, `${line}\n`);
};

process.stdin.on("end", () => process.exit(0));

if (mode === "old") {
  write({ type: "hello", protocol: 0, cli: "fake-0.0.1" });
} else if (mode === "mute") {
  // Nothing at all: the supervisor's handshake timeout or its restart logic has to deal with it.
} else {
  write({ type: "hello", protocol: 1, cli: "fake-1.0.0" });
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        note(`unparsable ${line.slice(0, 40)}`);
        continue;
      }
      handle(message);
    }
  });
}

function handle(message) {
  switch (message.type) {
    case "shutdown":
      process.exit(0);
    case "crash":
      process.exit(3);
    case "req": {
      note(`req ${message.path} id=${message.id}`);
      const known = {
        "/api/info": { cwd: "" },
        "/api/sessions": { workspaces: [] },
        "/api/children": { children: [] },
      };
      const body = Object.hasOwn(known, message.path) ? known[message.path] : { error: "not_found" };
      write({ type: "res", id: message.id, status: message.path === "/api/account" || !Object.hasOwn(known, message.path) ? 404 : 200, body });
      return;
    }
    case "open":
      note(`open ${message.cid} ${message.path}`);
      write({ type: "ready", cid: message.cid });
      return;
    case "call":
      note(`call ${message.method}`);
      if (message.method === "state") {
        const phase = process.env.FAKE_SIDECAR_PHASE ?? "ready";
        write({ type: "callres", id: message.id, ok: true, result: { phase, protocol: 1, cli: "fake-1.0.0" } });
      } else if (message.method === "echo") {
        write({ type: "callres", id: message.id, ok: true, result: message.params ?? null });
      } else if (message.method === "hang") {
        // Never answered: tests the supervisor rejecting pending calls when the process dies.
      } else {
        write({ type: "callres", id: message.id, ok: false, error: "unknown_method", message: message.method });
      }
      return;
    default:
      note(`ignored ${message.type ?? "?"}`);
  }
}
