"use strict";
// electron-builder never copies `node_modules` directories through extraResources, but the ompweb release ships
// node_modules/katex next to its binary (its static root). Copy it into the packaged app verbatim.
const fs = require("node:fs");
const path = require("node:path");

const VENDOR_TARGETS = { win32: "win-x64", linux: "linux-x64" };

exports.default = async function afterPack(context) {
  const target = VENDOR_TARGETS[context.electronPlatformName];
  if (!target) throw new Error(`No vendor build for ${context.electronPlatformName}`);
  const source = path.join(context.packager.projectDir, "vendor", target, "ompweb", "node_modules");
  const dest = path.join(context.appOutDir, "resources", "ompweb", "node_modules");
  if (!fs.existsSync(source)) throw new Error(`Missing ${source}; run "npm run fetch${target === "win-x64" ? ":win" : ":linux"}" first`);
  fs.cpSync(source, dest, { recursive: true });
};
