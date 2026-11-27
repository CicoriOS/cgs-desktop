// The renderer side of WorkspaceApi: the preload bridge (desktop/preload.cjs), or nothing in a plain browser. The rest of the client gets
// the same interface the demo and the dev bridge implement, so file and Git access never forks by host.
import type { WorkspaceApi } from "../core/types";

/** Read structurally: the shell's other keys are typed in src/ui/desktop.ts, which does not need to know this one. */
type DesktopShell = { cgsDesktop?: { workspace?: WorkspaceApi } };

function bridge(): WorkspaceApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as DesktopShell).cgsDesktop?.workspace;
}

/** Undefined in a browser (there is no local file access) or when the shell did not expose the bridge. */
export function createWorkspaceApi(): WorkspaceApi | undefined {
  const api = bridge();
  if (!api) return undefined;
  return {
    list: (cwd, dir) => api.list(cwd, dir),
    read: (cwd, path) => api.read(cwd, path),
    gitStatus: (cwd) => api.gitStatus(cwd),
    gitDiff: (cwd, path, target) => api.gitDiff(cwd, path, target),
    gitStage: (cwd, paths) => api.gitStage(cwd, paths),
    gitUnstage: (cwd, paths) => api.gitUnstage(cwd, paths),
    gitDiscard: (cwd, paths) => api.gitDiscard(cwd, paths),
    gitCommit: (cwd, message) => api.gitCommit(cwd, message),
    gitFetch: (cwd) => api.gitFetch(cwd),
    gitPull: (cwd) => api.gitPull(cwd),
    gitPush: (cwd) => api.gitPush(cwd),
    gitBranches: (cwd) => api.gitBranches(cwd),
    gitCheckout: (cwd, branch, create) => api.gitCheckout(cwd, branch, create),
    gitLog: (cwd, limit) => api.gitLog(cwd, limit),
    gitCommitFiles: (cwd, hash) => api.gitCommitFiles(cwd, hash),
    watch: (cwd, listener) => api.watch(cwd, listener),
  };
}
