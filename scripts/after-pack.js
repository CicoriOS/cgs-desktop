"use strict";
// electron-builder never copies `node_modules` directories through extraResources, but the ompweb release ships
// node_modules/katex next to its binary (its static root). Copy it into the packaged app verbatim.
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const source = path.join(context.packager.projectDir, "vendor", "win-x64", "ompweb", "node_modules");
  const dest = path.join(context.appOutDir, "resources", "ompweb", "node_modules");
  if (!fs.existsSync(source)) throw new Error(`Missing ${source}; run "npm run fetch" first`);
  fs.cpSync(source, dest, { recursive: true });
};
