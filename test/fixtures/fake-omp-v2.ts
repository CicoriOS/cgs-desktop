// A fake `omp --mode rpc-ui` for the bridge test. Under protocol v1 it fails a large response like omp does; after
// `negotiate_protocol` it sends it as `rpc_chunk` lines of 256 KiB.
import { Buffer } from "node:buffer";
import readline from "node:readline";

const CHUNK = 256 * 1024;
let v2 = false;
const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const cmd = JSON.parse(line) as { type: string; id?: string };
  const reply = (success: boolean, rest: Record<string, unknown>) => write({ type: "response", command: cmd.type, id: cmd.id, success, ...rest });
  if (cmd.type === "negotiate_protocol") {
    v2 = true;
    reply(true, { data: { protocolVersion: 2 } });
  } else if (cmd.type === "get_state") {
    reply(true, { data: {} });
  } else if (cmd.type === "get_entries") {
    if (!v2) {
      reply(false, { error: "RPC response exceeded the transport limit" });
      return;
    }
    // 3 MB of two-byte characters.
    const bytes = Buffer.from(JSON.stringify({ type: "response", command: "get_entries", id: cmd.id, success: true, data: { entries: [{ text: "é".repeat(1_500_000) }] } }));
    const count = Math.ceil(bytes.byteLength / CHUNK);
    for (let index = 0; index < count; index++) {
      write({ type: "rpc_chunk", chunkId: "c1", index, count, byteLength: bytes.byteLength, data: bytes.subarray(index * CHUNK, (index + 1) * CHUNK).toString("base64") });
    }
  } else {
    reply(false, { error: `unknown command ${cmd.type}` });
  }
});
