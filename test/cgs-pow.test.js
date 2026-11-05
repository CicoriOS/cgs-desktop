"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { solvePow, searchRange, checkNonce, hasLeadingZeroBits } = require("../src/cgs/pow");

const sha = (prefix, nonce) => crypto.createHash("sha256").update(`${prefix}:${nonce}`, "utf8").digest();
const bitString = buf => [...buf].map(b => b.toString(2).padStart(8, "0")).join("");

test("hasLeadingZeroBits: exact bit boundaries", () => {
  const d = Buffer.from([0x00, 0x0f, 0xff, 0xff]); // 12 leading zero bits
  assert.equal(hasLeadingZeroBits(d, 0), true);
  assert.equal(hasLeadingZeroBits(d, 8), true);
  assert.equal(hasLeadingZeroBits(d, 12), true);
  assert.equal(hasLeadingZeroBits(d, 13), false);
  assert.equal(hasLeadingZeroBits(Buffer.from([0x01]), 7), true);
  assert.equal(hasLeadingZeroBits(Buffer.from([0x01]), 8), false);
  assert.equal(hasLeadingZeroBits(Buffer.from([0x80]), 1), false);
  assert.equal(hasLeadingZeroBits(Buffer.from([0x00, 0x00, 0x7f]), 17), true);
  assert.equal(hasLeadingZeroBits(Buffer.from([0x00, 0x00, 0x7f]), 18), false);
  assert.equal(hasLeadingZeroBits(Buffer.from([0x00, 0x00]), 16), true);
});

test("solvePow returns the smallest valid decimal nonce for a known prefix/difficulty", async () => {
  const prefix = "9f3a0c1d7be24a55";
  const difficulty = 12;
  const nonce = await solvePow({ prefix, difficulty }, { chunkSize: 500 });
  assert.match(nonce, /^(0|[1-9]\d*)$/);
  assert.ok(bitString(sha(prefix, nonce)).startsWith("0".repeat(difficulty)));
  // nothing smaller satisfies the rule
  for (let n = 0; n < Number(nonce); n++) {
    assert.equal(checkNonce(prefix, String(n), difficulty), false, `nonce ${n} should not satisfy`);
  }
  // the same nonce fails a strictly harder rule only if its digest really has fewer zero bits
  const zeros = bitString(sha(prefix, nonce)).match(/^0*/)[0].length;
  assert.equal(checkNonce(prefix, nonce, zeros), true);
  assert.equal(checkNonce(prefix, nonce, zeros + 1), false);
});

test("solvePow difficulty 0 accepts the first nonce; searchRange honours its window", async () => {
  assert.equal(await solvePow({ prefix: "x", difficulty: 0 }), "0");
  const n = searchRange("window", 10, 0, 100000);
  assert.notEqual(n, null);
  assert.equal(searchRange("window", 10, Number(n), 1), n);
  assert.equal(searchRange("window", 10, Number(n) + 1, 0), null);
});

test("solvePow is abortable and yields to the event loop", async () => {
  const controller = new AbortController();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(solvePow({ prefix: "never", difficulty: 64 }, { signal: controller.signal, chunkSize: 2000 }), { name: "AbortError" });
  clearInterval(timer);
  assert.ok(ticks > 0, "timers must keep firing while solving");
});

test("solvePow rejects malformed challenges", async () => {
  await assert.rejects(solvePow({ prefix: 5, difficulty: 3 }), TypeError);
  await assert.rejects(solvePow({ prefix: "a", difficulty: 1.5 }), TypeError);
});
