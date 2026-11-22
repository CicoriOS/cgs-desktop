"use strict";
// What this client tells the server about itself: operating system and app version. The server shows them in the
// dashboard's Clients page (next to the GeoIP location it derives from the connection address) and refreshes them
// from the headers below on the periodic tier/usage requests.

const os = require("node:os");

const APP_VERSION = require("../../package.json").version;

/** Human-readable OS version, at most 64 characters (the server's limit), e.g. "Windows 11 Pro 10.0.26100". */
function osVersion() {
  let text;
  if (process.platform === "win32") text = `${os.version()} ${os.release()}`;
  else if (process.platform === "darwin") text = `macOS ${os.release()}`;
  else text = `${os.type()} ${os.release()}`;
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 64);
}

/** Headers for authenticated device requests: the credential plus OS and app version. */
function clientHeaders(clientSecret) {
  return { Authorization: `Bearer ${clientSecret}`, "X-Client-OS": osVersion(), "X-Client-Version": APP_VERSION.slice(0, 32) };
}

module.exports = { APP_VERSION, osVersion, clientHeaders };
