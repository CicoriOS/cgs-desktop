"use strict";
// Rasterizes the default omp logo (vendor/src/ompweb/public/icon.svg) and the CGS logo
// (~/new-api/web/public/logo.svg, cached as assets/cgs-logo.svg) into 512x512 PNGs and
// multi-size Windows ICO files (16, 24, 32, 48, 64, 128, 256) under assets/.
//
// Run via: npx electron scripts/build-icons.js --no-sandbox

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const ASSETS_DIR = path.join(ROOT, "assets");
const OMP_SVG_SRC = path.join(ROOT, "vendor", "src", "ompweb", "public", "icon.svg");
const CGS_SVG_SRC = path.join(os.homedir(), "new-api", "web", "public", "logo.svg");

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildIco(pngBuffersBySize) {
  const entries = ICO_SIZES.map((size) => {
    const data = pngBuffersBySize.get(size);
    if (!data) throw new Error(`missing PNG buffer for size ${size}`);
    return { size, data };
  });
  const headerSize = 6 + entries.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(entries.length, 4);

  let offset = headerSize;
  entries.forEach(({ size, data }, i) => {
    const pos = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, pos); // width (0 means 256)
    header.writeUInt8(size >= 256 ? 0 : size, pos + 1); // height (0 means 256)
    header.writeUInt8(0, pos + 2); // color palette
    header.writeUInt8(0, pos + 3); // reserved
    header.writeUInt16LE(1, pos + 4); // color planes
    header.writeUInt16LE(32, pos + 6); // bits per pixel
    header.writeUInt32LE(data.length, pos + 8);
    header.writeUInt32LE(offset, pos + 12);
    offset += data.length;
  });

  return Buffer.concat([header, ...entries.map((e) => e.data)]);
}

async function rasterizeSvg(win, rawSvgText, sizes) {
  const svgText = rawSvgText.replace(/<svg\b([^>]*)>/i, (match, attrs) => {
    if (/\bwidth\s*=/.test(attrs)) return match;
    return `<svg width="512" height="512"${attrs}>`;
  });
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svgText, "utf8").toString("base64")}`;
  const results = await win.webContents.executeJavaScript(
    `(${async (url, targetSizes) => {
      const img = new Image();
      img.decoding = "sync";
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("failed to load SVG into Image"));
        img.src = url;
      });
      const out = {};
      for (const size of targetSizes) {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(img, 0, 0, size, size);
        const pngUrl = canvas.toDataURL("image/png");
        out[size] = pngUrl.replace(/^data:image\/png;base64,/, "");
      }
      return out;
    }})(${JSON.stringify(dataUrl)}, ${JSON.stringify(sizes)})`,
  );
  const map = new Map();
  for (const size of sizes) {
    map.set(size, Buffer.from(results[size], "base64"));
  }
  return map;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    if (fs.existsSync(OMP_SVG_SRC)) {
      fs.copyFileSync(OMP_SVG_SRC, path.join(ASSETS_DIR, "omp-logo.svg"));
    }
    if (fs.existsSync(CGS_SVG_SRC)) {
      fs.copyFileSync(CGS_SVG_SRC, path.join(ASSETS_DIR, "cgs-logo.svg"));
    }

    const ompSvg = fs.readFileSync(path.join(ASSETS_DIR, "omp-logo.svg"), "utf8");
    const cgsSvg = fs.readFileSync(path.join(ASSETS_DIR, "cgs-logo.svg"), "utf8");

    const win = new BrowserWindow({
      width: 512,
      height: 512,
      show: false,
    });
    await win.loadURL("data:text/html,<!doctype html><html><body></body></html>");

    const allSizes = [...ICO_SIZES, 512];
    const ompPngs = await rasterizeSvg(win, ompSvg, allSizes);
    const cgsPngs = await rasterizeSvg(win, cgsSvg, allSizes);

    fs.writeFileSync(path.join(ASSETS_DIR, "icon.png"), ompPngs.get(512));
    fs.writeFileSync(path.join(ASSETS_DIR, "icon.ico"), buildIco(ompPngs));
    fs.writeFileSync(path.join(ASSETS_DIR, "cgs-icon.png"), cgsPngs.get(512));
    fs.writeFileSync(path.join(ASSETS_DIR, "cgs-icon.ico"), buildIco(cgsPngs));

    win.destroy();
    app.exit(0);
  } catch (err) {
    console.error(err);
  }
});
