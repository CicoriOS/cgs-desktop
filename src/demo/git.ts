// The demo's Git: an in-memory repository behind each demo workspace. Files carry their HEAD, index and working copies; branches carry
// their history, what the remote has that they lack, and what teammates will push next, so staging, committing, fetching, pulling,
// pushing and switching branches all behave the way the Git panel expects (a push is rejected while the remote is ahead, and so on).
import type { GitBranch, GitCommit, GitDiffTarget, GitFile, GitFileKind, GitIdentity, GitStatus } from "../core/types";
import { unifiedPatch } from "./patch";

export interface DemoFile {
  /** Working copy; absent = deleted in the working tree. */
  text?: string;
  /** Copy at HEAD; absent = not in the repository. */
  head?: string;
  /** Copy in the index. Absent = the same as HEAD; `null` = deletion staged. */
  index?: string | null;
  image?: string;
}

interface DemoChange {
  path: string;
  before?: string;
  after?: string;
}

export interface DemoCommit {
  hash: string;
  subject: string;
  author: string;
  email: string;
  time: number;
  /** On the remote already. */
  pushed: boolean;
  changes: DemoChange[];
}

export interface DemoBranch {
  upstream?: string;
  /** Newest first. */
  history: DemoCommit[];
  /** On the remote, not here yet (known from the last fetch), newest first. */
  incoming: DemoCommit[];
  /** What teammates push next: a fetch brings the first of these in. */
  upcoming: DemoCommit[];
}

export interface DemoRemoteBranch {
  author: string;
  time: number;
  /** What a local branch made from it starts with. */
  commits: DemoCommit[];
}

export interface DemoRepo {
  user: GitIdentity;
  /** Current branch. */
  branch: string;
  branches: Record<string, DemoBranch>;
  /** Remote branches nobody here follows yet, by `origin/<name>`. */
  remotes: Record<string, DemoRemoteBranch>;
  files: Record<string, DemoFile>;
}

const index = (file: DemoFile): string | undefined => (file.index === undefined ? file.head : (file.index ?? undefined));

/** Index against HEAD, or the working tree against the index. */
function sideStatus(from: string | undefined, to: string | undefined, fresh: GitFileKind): GitFileKind | undefined {
  if (from === undefined) return to === undefined ? undefined : fresh;
  if (to === undefined) return "deleted";
  return from === to ? undefined : "modified";
}

export const changeKind = (change: DemoChange): GitFileKind => sideStatus(change.before, change.after, "added") ?? "modified";

let counter = 0;
/** A short stable-looking hash for a made-up commit. */
const fakeHash = (): string => (0x9e3779b1 * ++counter + 0x5bd1e995).toString(16).slice(-7).padStart(7, "0");

export interface CommitSeed {
  subject: string;
  author: string;
  /** How long ago, in minutes. */
  ago: number;
  pushed?: boolean;
  files?: [path: string, before: string | undefined, after: string | undefined][];
}

/** Commit seeds need no real content: files default to one small change of an invented file. */
export function seedCommit(seed: CommitSeed, now = Date.now()): DemoCommit {
  const changes = (seed.files ?? [[`src/${seed.subject.split(/[:(]/)[0]!.trim() || "x"}.ts`, "// before\n", "// after\n"]]).map(([path, before, after]) => ({ path, before, after }));
  return { hash: fakeHash(), subject: seed.subject, author: seed.author, email: `${seed.author}@example.com`, time: now - seed.ago * 60_000, pushed: seed.pushed ?? true, changes };
}

const withCwd = (cwd: string, path: string) => `${cwd}/${path}`;
const relPath = (cwd: string, path: string) => path.slice(cwd.length + 1);

/** The Git operations over one demo repository; `changed` runs after anything that alters the repository (watchers hear it, as with a real file watcher). */
export function demoGit(cwd: string, repo: DemoRepo, changed: () => void) {
  const current = () => repo.branches[repo.branch]!;
  const unpushed = (b: DemoBranch) => b.history.filter((c) => !c.pushed);
  const selected = (paths: string[] | "all", side: "stage" | "unstage") =>
    paths === "all"
      ? Object.keys(repo.files)
      : paths.map((p) => relPath(cwd, p)).filter((p) => p in repo.files && (side === "stage" || index(repo.files[p]!) !== repo.files[p]!.head));

  return {
    status(): GitStatus {
      const files: GitFile[] = [];
      for (const [path, file] of Object.entries(repo.files)) {
        const staged = sideStatus(file.head, index(file), "added");
        if (staged) files.push({ path: withCwd(cwd, path), status: staged, staged: true });
        const idx = index(file);
        const unstaged = sideStatus(idx, file.text, "untracked");
        if (unstaged) files.push({ path: withCwd(cwd, path), status: unstaged, staged: false });
      }
      files.sort((x, y) => x.path.localeCompare(y.path) || Number(y.staged) - Number(x.staged));
      const b = current();
      return { isRepo: true, branch: repo.branch, ...(b.upstream ? { upstream: b.upstream } : {}), ahead: unpushed(b).length, behind: b.incoming.length, user: repo.user, files };
    },

    diff(path: string, target: GitDiffTarget): string | undefined {
      const rel = relPath(cwd, path);
      if (typeof target === "object") {
        const commit = [...Object.values(repo.branches).flatMap((b) => [...b.history, ...b.incoming])].find((c) => c.hash === target.commit);
        const change = commit?.changes.find((c) => c.path === rel);
        return change && unifiedPatch(rel, change.before ?? "", change.after ?? "") || undefined;
      }
      const file = repo.files[rel];
      if (!file || file.image) return undefined;
      const [from, to] = target === "staged" ? [file.head, index(file)] : [index(file), file.text];
      if (to === undefined) return undefined;
      return unifiedPatch(rel, from ?? "", to) || undefined;
    },

    stage(paths: string[] | "all") {
      for (const rel of selected(paths, "stage")) {
        const file = repo.files[rel]!;
        if (file.text === file.head && file.index === undefined) continue;
        file.index = file.text ?? null;
      }
      changed();
    },

    unstage(paths: string[] | "all") {
      for (const rel of selected(paths, "unstage")) delete repo.files[rel]!.index;
      changed();
    },

    discard(paths: string[]) {
      for (const rel of paths.map((p) => relPath(cwd, p))) {
        const file = repo.files[rel];
        if (!file) continue;
        const idx = index(file);
        if (idx === undefined && file.head === undefined) delete repo.files[rel]; // untracked: gone
        else if (idx !== undefined) file.text = idx;
      }
      changed();
    },

    commit(message: string) {
      const subject = message.trim();
      if (!subject) throw new Error("Aborting commit due to empty commit message.");
      const changes: DemoChange[] = [];
      for (const [path, file] of Object.entries(repo.files)) {
        const idx = index(file);
        if (sideStatus(file.head, idx, "added") === undefined) continue;
        changes.push({ path, before: file.head, after: idx });
        if (idx === undefined) file.head = undefined;
        else file.head = idx;
        delete file.index;
        if (file.head === undefined && file.text === undefined) delete repo.files[path];
      }
      if (!changes.length) throw new Error("nothing to commit: stage some changes first");
      current().history.unshift({ hash: fakeHash(), subject: subject.split("\n")[0]!, author: repo.user.name, email: repo.user.email, time: Date.now(), pushed: false, changes });
      changed();
    },

    fetch() {
      for (const b of Object.values(repo.branches)) {
        const next = b.upcoming.shift();
        if (next) b.incoming.unshift(next);
      }
      changed();
    },

    pull() {
      const b = current();
      if (!b.upstream) throw new Error("There is no tracking information for the current branch.");
      b.history = [...b.incoming.map((c) => ({ ...c, pushed: true })), ...b.history];
      b.incoming = [];
      changed();
    },

    push() {
      const b = current();
      if (b.incoming.length) throw new Error(`Updates were rejected because the remote contains work that you do not have locally. Pull first (${b.upstream}).`);
      b.upstream ??= `origin/${repo.branch}`;
      for (const c of b.history) c.pushed = true;
      changed();
    },

    branches(): GitBranch[] {
      const local = Object.entries(repo.branches).map(([name, b]): GitBranch => {
        const newest = b.history[0];
        return { name, remote: false, current: name === repo.branch, ...(b.upstream ? { upstream: b.upstream } : {}), ahead: unpushed(b).length, behind: b.incoming.length, author: newest?.author ?? repo.user.name, time: newest?.time ?? 0 };
      });
      const followed = new Set(Object.values(repo.branches).map((b) => b.upstream));
      const remote = Object.entries(repo.remotes)
        .filter(([name]) => !followed.has(name))
        .map(([name, r]): GitBranch => ({ name, remote: true, current: false, ahead: 0, behind: 0, author: r.author, time: r.time }));
      return [...local.sort((x, y) => Number(y.current) - Number(x.current) || y.time - x.time), ...remote.sort((x, y) => y.time - x.time)];
    },

    checkout(name: string, create = false) {
      if (create) {
        if (repo.branches[name]) throw new Error(`a branch named '${name}' already exists`);
        repo.branches[name] = { history: current().history.map((c) => ({ ...c })), incoming: [], upcoming: [] };
      } else if (name.startsWith("origin/")) {
        const remote = repo.remotes[name];
        if (!remote) throw new Error(`pathspec '${name}' did not match any branch`);
        const local = name.slice("origin/".length);
        repo.branches[local] = { upstream: name, history: remote.commits.map((c) => ({ ...c, pushed: true })), incoming: [], upcoming: [] };
      } else if (!repo.branches[name]) throw new Error(`pathspec '${name}' did not match any branch`);
      repo.branch = name.startsWith("origin/") && !create ? name.slice("origin/".length) : name;
      changed();
    },

    log(limit: number): GitCommit[] {
      const b = current();
      const direction = (c: DemoCommit, incoming: boolean): GitCommit["direction"] => (incoming ? "incoming" : c.pushed ? "shared" : "outgoing");
      return [...b.incoming.map((c) => ({ c, incoming: true })), ...b.history.map((c) => ({ c, incoming: false }))]
        .sort((x, y) => y.c.time - x.c.time)
        .slice(0, limit)
        .map(({ c, incoming }) => ({ hash: c.hash, subject: c.subject, author: c.author, email: c.email, time: c.time, direction: direction(c, incoming) }));
    },

    commitFiles(hash: string): GitFile[] {
      const commit = Object.values(repo.branches).flatMap((b) => [...b.history, ...b.incoming]).find((c) => c.hash === hash);
      return (commit?.changes ?? []).map((c) => ({ path: withCwd(cwd, c.path), status: changeKind(c), staged: false }));
    },
  };
}
