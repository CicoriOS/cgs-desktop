// Where the executables the installer ships live. Split from install.mjs so platform.mjs can ask without loading the installer.
import path from "node:path";

/** `<resources>/tools` in a packaged app; `CGS_TOOLS_DIR` overrides it in development and tests. */
export function bundledToolsDir({ env = process.env, resourcesPath = process.resourcesPath } = {}) {
  return env.CGS_TOOLS_DIR?.trim() || path.join(resourcesPath ?? "", "tools");
}
