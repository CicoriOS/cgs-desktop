"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { buildEnv } = require("../src/main/services");

const BASE = {
  PATH: ["/home/u/.local/bin", "/opt/cgs/resources/omp", "/usr/bin"].join(path.delimiter),
  HOME: "/home/u",
  PI_PROFILE: "work",
  PI_CODING_AGENT_DIR: "/home/u/.omp/agent",
  OMP_WEB_PORT: "1234",
  APPIMAGE: "/tmp/CGS.AppImage",
  APPDIR: "/tmp/.mount_CGS",
};
const input = {
  agentDir: "/home/u/.config/CGS Desktop/omp/agent",
  ompBin: "/opt/cgs/resources/omp/omp",
  chromeBin: "/opt/cgs/resources/chromium/chrome-linux64/chrome",
  baseEnv: BASE,
  platform: "linux",
};

test("buildEnv points omp at the bundled binary and agent dir and drops inherited omp settings", () => {
  const env = buildEnv(input);
  assert.equal(env.PI_CODING_AGENT_DIR, input.agentDir);
  assert.equal(env.OMP_WEB_OMP_BIN, input.ompBin);
  assert.equal(env.PUPPETEER_EXECUTABLE_PATH, input.chromeBin);
  for (const key of ["PI_PROFILE", "OMP_WEB_PORT", "APPIMAGE", "APPDIR"]) assert.equal(key in env, false, key);
  assert.equal(env.HOME, "/home/u");
});

test("buildEnv gives omp its own config root whatever the shell configured", () => {
  assert.equal(buildEnv(input).PI_CONFIG_DIR, ".cgs");
  assert.equal(buildEnv({ ...input, baseEnv: { ...BASE, PI_CONFIG_DIR: ".pi" } }).PI_CONFIG_DIR, ".cgs");
});

test("buildEnv puts the bundled omp first on PATH once and keeps the user's other entries", () => {
  const entries = buildEnv(input).PATH.split(path.delimiter);
  assert.deepEqual(entries, ["/opt/cgs/resources/omp", "/home/u/.local/bin", "/usr/bin"]);
});

test("buildEnv keeps a locally installed omp's XDG data layout out of reach on Linux only", () => {
  assert.equal(buildEnv(input).XDG_DATA_HOME, path.join("/home/u/.config/CGS Desktop/omp", "xdg-data"));
  assert.equal("XDG_DATA_HOME" in buildEnv({ ...input, platform: "win32" }), false);
});

test("buildEnv moves omp's hard-coded native-addon cache into the config root", () => {
  assert.equal(buildEnv({ ...input, home: "/home/u" }).PI_NATIVES_DIR, path.join("/home/u", ".cgs", "natives"));
});
