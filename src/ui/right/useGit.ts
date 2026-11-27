import { useEffect, useState } from "react";
import type { GitStatus } from "../../core/types";
import { useActions, useClientState } from "../client-context";

export type GitState = GitStatus & { loading: boolean; error?: string };

const EMPTY: GitState = { loading: true, isRepo: false, ahead: 0, behind: 0, files: [] };

/** Git state of the active workspace; reloads when a workspace opens and on `reload` (which carries the live changes). */
export function useGit(reload: number): GitState {
  const actions = useActions();
  const cwd = useClientState((s) => s.activeCwd);
  const [git, setGit] = useState<GitState>(EMPTY);
  useEffect(() => {
    if (!cwd) return;
    let live = true;
    setGit((g) => ({ ...g, loading: true, error: undefined }));
    actions.gitStatus().then(
      (status) => live && setGit({ ...status, loading: false }),
      (e) => live && setGit({ ...EMPTY, loading: false, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [actions, cwd, reload]);
  return git;
}
