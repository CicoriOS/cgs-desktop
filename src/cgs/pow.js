"use strict";
// Proof of work: find a decimal-string nonce such that sha256(prefix + ":" + nonce)
// (UTF-8) has at least `difficulty` leading zero bits.

const crypto = require("node:crypto");

const CHUNK = 20000;

/** True when the raw digest has at least `bits` leading zero bits. */
function hasLeadingZeroBits(digest, bits) {
  const fullBytes = bits >> 3;
  for (let i = 0; i < fullBytes; i++) if (digest[i] !== 0) return false;
  const rem = bits & 7;
  if (rem === 0) return true;
  return (digest[fullBytes] >> (8 - rem)) === 0;
}

function checkNonce(prefix, nonce, difficulty) {
  const digest = crypto.createHash("sha256").update(`${prefix}:${nonce}`, "utf8").digest();
  return hasLeadingZeroBits(digest, difficulty);
}

/** Synchronous search from `start` (inclusive) over `count` nonces; returns the nonce string or null. */
function searchRange(prefix, difficulty, start, count) {
  for (let n = start; n < start + count; n++) {
    const nonce = String(n);
    if (checkNonce(prefix, nonce, difficulty)) return nonce;
  }
  return null;
}

/**
 * Async, abortable solver: hashes in chunks and yields to the event loop between chunks so the
 * Electron main process (and its UI) stays responsive.
 */
async function solvePow({ prefix, difficulty }, { signal, chunkSize = CHUNK } = {}) {
  if (typeof prefix !== "string" || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > 256) {
    throw new TypeError("invalid proof-of-work challenge");
  }
  let start = 0;
  for (;;) {
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    const found = searchRange(prefix, difficulty, start, chunkSize);
    if (found !== null) return found;
    start += chunkSize;
    await new Promise(resolve => setImmediate(resolve));
  }
}

module.exports = { solvePow, searchRange, checkNonce, hasLeadingZeroBits };
