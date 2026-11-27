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
  /**
   * The local host link (ADR 0046, cgsconnect/local-channel.md §8): MuxMessages to one sidecar, plus its calls and events.
   * The status mirrors the link, so `send` can answer synchronously (nothing is queued while it is not ready).
   */
  host: (() => {
    const listeners = new Set();
    let status = "connecting";
    let revision = -1;
    const apply = (next, detail, nextRevision) => {
      // A status poll may answer with an older value than a broadcast that arrived meanwhile; the revision orders them.
      if (typeof nextRevision === "number") {
        if (nextRevision < revision) return;
        revision = nextRevision;
      }
      status = next;
      for (const listener of listeners) listener(next, detail);
    };
    ipcRenderer.on("cgs:host:status", (_event, next, detail, nextRevision) => apply(next, detail, nextRevision));
    return {
      send(message) {
        if (status !== "ready") return false;
        ipcRenderer.send("cgs:host:send", message);
        return true;
      },
      onMessage(callback) {
        const forward = (_event, message) => callback(message);
        ipcRenderer.on("cgs:host:message", forward);
        return () => ipcRenderer.removeListener("cgs:host:message", forward);
      },
      onStatus(callback) {
        listeners.add(callback);
        // Ask for the current status too: a reloaded window has heard no broadcasts yet.
        void ipcRenderer.invoke("cgs:host:status").then((current) => apply(current.status, current.detail, current.revision), () => {});
        return () => listeners.delete(callback);
      },
      call(method, params) {
        return ipcRenderer.invoke("cgs:host:call", method, params).catch((error) => {
          // Electron wraps a handler's rejection ("Error invoking remote method …: Error: code"); the page expects the code.
          const text = String(error instanceof Error ? error.message : error);
          const marker = "Error: ";
          const at = text.lastIndexOf(marker);
          throw new Error(at < 0 ? text : text.slice(at + marker.length));
        });
      },
      onEvent(callback) {
        const forward = (_event, name, data) => callback(name, data);
        ipcRenderer.on("cgs:host:event", forward);
        return () => ipcRenderer.removeListener("cgs:host:event", forward);
      },
    };
  })(),
  /**
   * The workspace's files and Git (WorkspaceApi): Node fs and the git CLI, in the main process. Every answer is `{ ok, value }` or
   * `{ ok, error }` so Git's own message reaches the page without Electron's "Error invoking remote method" wrapper.
   */
  workspace: (() => {
    const call = async (method, ...args) => {
      const result = await ipcRenderer.invoke(`workspace:${method}`, ...args);
      if (!result?.ok) throw new Error(result?.error ?? "workspace request failed");
      return result.value;
    };
    let next = 0;
    // A watch id only has to be unique among this window's watches; the main process keys them by webContents too.
    const session = Math.random().toString(36).slice(2);
    return {
      list: (cwd, dir) => call("list", cwd, dir),
      read: (cwd, path) => call("read", cwd, path),
      gitStatus: (cwd) => call("gitStatus", cwd),
      gitDiff: (cwd, path, target) => call("gitDiff", cwd, path, target),
      gitStage: (cwd, paths) => call("gitStage", cwd, paths),
      gitUnstage: (cwd, paths) => call("gitUnstage", cwd, paths),
      gitDiscard: (cwd, paths) => call("gitDiscard", cwd, paths),
      gitCommit: (cwd, message) => call("gitCommit", cwd, message),
      gitFetch: (cwd) => call("gitFetch", cwd),
      gitPull: (cwd) => call("gitPull", cwd),
      gitPush: (cwd) => call("gitPush", cwd),
      gitBranches: (cwd) => call("gitBranches", cwd),
      gitCheckout: (cwd, branch, create) => call("gitCheckout", cwd, branch, create),
      gitLog: (cwd, limit) => call("gitLog", cwd, limit),
      gitCommitFiles: (cwd, hash) => call("gitCommitFiles", cwd, hash),
      watch(cwd, listener) {
        const id = `${session}-${++next}`;
        let closed = false;
        const forward = (_event, changed) => {
          if (changed === id) listener();
        };
        ipcRenderer.on("workspace:changed", forward);
        // The main process starts watching asynchronously; if the page stopped meanwhile, stop it once it did start.
        call("watch", cwd, id).then(
          () => {
            if (closed) ipcRenderer.send("workspace:unwatch", id);
          },
          () => {},
        );
        return () => {
          closed = true;
          ipcRenderer.removeListener("workspace:changed", forward);
          ipcRenderer.send("workspace:unwatch", id);
        };
      },
    };
  })(),
  /**
   * Desktop updates (ADR 0046 §6). Only the user installs: `check` asks for a newer release, `download` fetches it, `install`
   * quits and installs it. `onStatus` pushes every phase change; `status()` is the current one.
   */
  updater: {
    check: () => ipcRenderer.invoke("cgs:updater:check"),
    getAutoCheck: () => ipcRenderer.invoke("cgs:updater:getAutoCheck"),
    setAutoCheck: (enabled) => ipcRenderer.invoke("cgs:updater:setAutoCheck", enabled),
    status: () => ipcRenderer.invoke("cgs:updater:status"),
    download: () => ipcRenderer.invoke("cgs:updater:download"),
    install: () => ipcRenderer.invoke("cgs:updater:install"),
    onStatus(callback) {
      const forward = (_event, status) => callback(status);
      ipcRenderer.on("cgs:updater:changed", forward);
      return () => ipcRenderer.removeListener("cgs:updater:changed", forward);
    },
  },
  /**
   * The shell's own behaviour (ADR 0046 §3, §5): CLI sync before the sidecar starts, the close prompt, and notification
   * clicks. State is pushed on change; the `syncState()` call covers a page that loaded after the last push.
   */
  shell: {
    syncState: () => ipcRenderer.invoke("cgs:shell:sync"),
    retry: () => ipcRenderer.send("cgs:shell:retry"),
    onSync(callback) {
      const forward = (_event, state) => callback(state);
      ipcRenderer.on("cgs:shell:sync", forward);
      void ipcRenderer.invoke("cgs:shell:sync").then((state) => callback(state), () => {});
      return () => ipcRenderer.removeListener("cgs:shell:sync", forward);
    },
    onOpenChild(callback) {
      const forward = (_event, target) => callback(target);
      ipcRenderer.on("cgs:shell:open-child", forward);
      return () => ipcRenderer.removeListener("cgs:shell:open-child", forward);
    },
    onClosePrompt(callback) {
      const forward = () => callback();
      ipcRenderer.on("cgs:shell:close-prompt", forward);
      return () => ipcRenderer.removeListener("cgs:shell:close-prompt", forward);
    },
    answerClose: (answer) => ipcRenderer.send("cgs:shell:close-answer", answer),
  },
  /** The files and folders of a drag and drop, as paths on this machine (a File object does not carry one), in the order given. */
  async inspectDrop(files) {
    const paths = files.map((file) => webUtils.getPathForFile(file));
    const directories = await ipcRenderer.invoke("fs:areDirectories", paths);
    // The page works with "/" on every platform.
    return paths.map((path, i) => ({ path: path.replaceAll("\\", "/"), directory: directories[i] }));
  },
});
