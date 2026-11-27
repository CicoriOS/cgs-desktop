import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("the dev bridge forwards its child command when Bun strips the separator", async () => {
  const script = fileURLToPath(new URL("../bridge/server.ts", import.meta.url));
  const bridge = spawn("bun", [script, "--", "bun", "--version"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },
    timeout: 3000,
  });
  const closed = once(bridge, "close");
  let output = "";
  try {
    for await (const chunk of bridge.stdout) {
      output += chunk.toString();
      if (output.includes("\n")) break;
    }
    expect(output).toMatch(/rpc-web: http:\/\/127\.0\.0\.1:\d+\s+->\s+bun --version\b/);
  } finally {
    bridge.kill();
    await closed;
  }
});

test("a response over the protocol v1 limit reaches the page whole: the bridge asks the child for v2 and reassembles its chunks", async () => {
  const script = fileURLToPath(new URL("../bridge/server.ts", import.meta.url));
  const fake = fileURLToPath(new URL("./fixtures/fake-omp-v2.ts", import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
  const bridge = spawn("bun", [script, "--", "bun", fake], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: "0", AGENT_DIR: path.join(dir, "agent") },
  });
  const closed = once(bridge, "close");
  try {
    let output = "";
    for await (const chunk of bridge.stdout) {
      output += chunk.toString();
      if (output.includes("\n")) break;
    }
    const origin = /rpc-web: http:\/\/(127\.0\.0\.1:\d+)/.exec(output)?.[1];
    expect(origin).toBeDefined();
    const res = await fetch(`http://${origin}/api/children`, { method: "POST", body: JSON.stringify({ cwd: dir }) });
    const { id } = (await res.json()) as { id: string };

    const ws = new WebSocket(`ws://${origin}/ws?child=${id}`);
    const { promise, resolve, reject } = Promise.withResolvers<{ type: string; success?: boolean; error?: string; data?: { entries: { text: string }[] } }>();
    const types: string[] = [];
    const opened = Promise.withResolvers<void>();
    ws.onopen = () => opened.resolve();
    ws.onerror = () => {
      opened.reject(new Error("socket error"));
      reject(new Error("socket error"));
    };
    ws.onmessage = (e) => {
      const frame = JSON.parse(String(e.data));
      types.push(frame.type);
      if (frame.type === "response") resolve(frame);
    };
    await opened.promise;
    ws.send(JSON.stringify({ type: "get_entries", id: "e1" }));
    const frame = await promise;
    ws.close();

    expect(frame.error).toBeUndefined();
    expect(frame.data?.entries[0]?.text).toBe("é".repeat(1_500_000));
    expect(types).not.toContain("rpc_chunk");
  } finally {
    bridge.kill();
    await closed;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
