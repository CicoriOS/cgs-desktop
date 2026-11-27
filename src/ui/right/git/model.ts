import type { GitCommit, GitFile, GitStatus } from "../../../core/types";

/** What the sync button does: publish an unpublished branch, pull, push, pull then push (diverged), or just ask the remote what is new. */
export type SyncPlan = "publish" | "pull" | "push" | "both" | "fetch";

export function syncPlan({ upstream, ahead, behind }: Pick<GitStatus, "upstream" | "ahead" | "behind">): SyncPlan {
  if (!upstream) return "publish";
  if (ahead && behind) return "both";
  return behind ? "pull" : ahead ? "push" : "fetch";
}

/** The three lists of the Changes view; a file edited in the index and again after it is in both of the last two. */
export function splitFiles(files: GitFile[]): { merge: GitFile[]; staged: GitFile[]; changes: GitFile[] } {
  return {
    merge: files.filter((f) => f.status === "conflict"),
    staged: files.filter((f) => f.staged),
    changes: files.filter((f) => !f.staged && f.status !== "conflict"),
  };
}

/** What the commit button does: nothing to commit, commit the staged files, or (nothing staged) stage everything and commit it. */
export type CommitPlan = "none" | "staged" | "all";

export function commitPlan(staged: number, others: number, message: string): CommitPlan {
  if (!message.trim()) return "none";
  return staged ? "staged" : others ? "all" : "none";
}

/** Authors in order of first appearance. */
export const authorsOf = (commits: GitCommit[]): string[] => [...new Set(commits.map((c) => c.author))];

/** Distinct paths, for a count that does not double a file listed on both sides. */
export const pathCount = (files: GitFile[]): number => new Set(files.map((f) => f.path)).size;
