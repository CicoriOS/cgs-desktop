"use strict";

const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

/** Write `data` to `file` via a temp file + rename (creating parent dirs); optional chmod `mode`. */
async function writeFileAtomic(file, data, mode) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(tmp, data, { mode });
    if (mode !== undefined) await fsp.chmod(tmp, mode);
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

module.exports = { writeFileAtomic };
