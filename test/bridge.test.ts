import { spawn } from "node:child_process";
import { once } from "node:events";
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
    expect(output).toMatch(/rpc-web: http:\/\/127\.0\.0\.1:\d+\s+->\s+bun --version\s+\(cwd /);
  } finally {
    bridge.kill();
    await closed;
  }
});
