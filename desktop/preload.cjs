// The smallest bridge the renderer gets: what the shell is and what its window can do (host features arrive as the client needs them).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("cgsDesktop", {
  platform: process.platform,
  /** The window itself is translucent (OS blur behind it); the page lets it show through the sidebar. */
  glass: process.argv.includes("--cgs-glass"),
  /** The page draws the title bar, so it also drives the window. */
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    toggleMaximize: () => ipcRenderer.send("window:toggleMaximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    onMaximized: (listener) => {
      const forward = (_event, maximized) => listener(maximized);
      ipcRenderer.on("window:maximized", forward);
      return () => ipcRenderer.removeListener("window:maximized", forward);
    },
  },
  /** The files and folders of a drag and drop, as paths on this machine (a File object does not carry one), in the order given. */
  async inspectDrop(files) {
    const paths = files.map((file) => webUtils.getPathForFile(file));
    const directories = await ipcRenderer.invoke("fs:areDirectories", paths);
    // The page works with "/" on every platform.
    return paths.map((path, i) => ({ path: path.replaceAll("\\", "/"), directory: directories[i] }));
  },
});
