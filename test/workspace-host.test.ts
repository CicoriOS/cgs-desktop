// The workspace implementation runs against real Git repositories in a temp directory: no user config, no network, and (for watch and
// commits) real files under the repository. Node environment is the vitest default (vite.config.ts `test.environment = "node"`).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  gitBranches,
  gitCheckout,
  gitCommit,
  gitCommitFiles,
  gitDiff,
  gitDiscard,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitStage,
  gitStatus,
  gitUnstage,
  listDirectory,
  readPreview,
  registerWorkspaceIpc,
  watchWorkspace,
} from "../desktop/workspace.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cgs-workspace-"));
const home = path.join(root, "home");
const gitConfig = path.join(root, "gitconfig");
const ENV_KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
const savedEnv = new Map<string, string | undefined>();

// Dates are explicit so ordering does not depend on how fast the machine commits: tick 0.. is the base commit, `later(day)` is a day after.
let tick = 0;
const stamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
const later = (day: number) => new Date(Date.UTC(2026, 0, 1 + day)).toISOString();

function run(cwd: string, args: string[], extraEnv: Record<string, string> = {}): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  }).trim();
}

function write(repo: string, rel: string, text: string | Buffer): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

function commit(repo: string, message: string, files: Record<string, string | Buffer | null> = {}, date = stamp()): string {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    if (text === null) fs.rmSync(abs, { force: true });
    else write(repo, rel, text);
  }
  run(repo, ["add", "-A"]);
  run(repo, ["commit", "-q", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return run(repo, ["rev-parse", "HEAD"]);
}

function bareOrigin(base: string): string {
  const origin = path.join(base, "origin.git");
  fs.mkdirSync(base, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  return origin;
}

/** A repository with its initial commit and a bare origin it follows; `other` clones are made by the tests that need a teammate. */
function makeRepo(name: string, files: Record<string, string | Buffer | null> = { "a.txt": "one\ntwo\n" }): { repo: string; origin: string } {
  const base = path.join(root, name);
  const origin = bareOrigin(base);
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  run(repo, ["remote", "add", "origin", origin]);
  commit(repo, "init", files);
  run(repo, ["push", "-q", "-u", "origin", "main"]);
  return { repo, origin };
}

function cloneTeammate(origin: string, name: string): string {
  const other = path.join(path.dirname(origin), name);
  execFileSync("git", ["clone", "-q", origin, other]);
  run(other, ["config", "user.name", "Teammate"]);
  run(other, ["config", "user.email", "teammate@example.com"]);
  return other;
}

beforeAll(() => {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    gitConfig,
    ["[user]", "\tname = Test User", "\temail = test@example.com", "[init]", "\tdefaultBranch = main", "[advice]", "\tdetachedHead = false", ""].join("\n"),
  );
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  Object.assign(process.env, {
    HOME: home,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
});

afterAll(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("workspace files", () => {
  it("lists absolute paths with folders first, and previews text, image, binary and large files", async () => {
    const { repo } = makeRepo("preview", { "text.txt": "hello\n" });
    write(repo, "src/file.ts", "export {};\n");
    write(repo, "pixel.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    write(repo, "blob.bin", Buffer.from([0, 1, 2, 3]));
    write(repo, "big.txt", "x".repeat(1024 * 1024 + 1));

    const entries = await listDirectory(repo, repo);
    expect(entries[0]?.dir).toBe(true);
    expect(entries.find((entry) => entry.name === "src")).toEqual({ name: "src", path: path.join(repo, "src"), dir: true });
    expect(await listDirectory(repo, path.join(repo, "src"))).toEqual([{ name: "file.ts", path: path.join(repo, "src", "file.ts"), dir: false }]);

    expect(await readPreview(repo, path.join(repo, "text.txt"))).toEqual({ kind: "text", text: "hello\n" });
    const image = await readPreview(repo, path.join(repo, "pixel.png"));
    expect(image.kind).toBe("image");
    if (image.kind === "image") expect(image.url).toMatch(/^data:image\/png;base64,/);
    expect(await readPreview(repo, path.join(repo, "blob.bin"))).toEqual({ kind: "binary" });
    expect(await readPreview(repo, path.join(repo, "big.txt"))).toEqual({ kind: "large", size: 1024 * 1024 + 1 });
    await expect(readPreview(repo, path.join(repo, "src"))).rejects.toThrow(/not a file/);
  });

  it("refuses paths outside the workspace, including through symlinks", async () => {
    const { repo } = makeRepo("escape");
    const outside = path.join(root, "escape", "outside.txt");
    fs.writeFileSync(outside, "secret\n");
    fs.symlinkSync(outside, path.join(repo, "link.txt"));
    fs.symlinkSync(path.join(root, "escape"), path.join(repo, "linkdir"));

    await expect(readPreview(repo, "../outside.txt")).rejects.toThrow(/outside the workspace/);
    await expect(readPreview(repo, outside)).rejects.toThrow(/outside the workspace/);
    await expect(readPreview(repo, path.join(repo, "link.txt"))).rejects.toThrow(/outside the workspace/);
    await expect(readPreview(repo, path.join(repo, "linkdir", "outside.txt"))).rejects.toThrow(/outside the workspace/);
    await expect(listDirectory(repo, path.join(repo, "linkdir"))).rejects.toThrow(/outside the workspace/);
    await expect(gitDiff(repo, "../outside.txt", "changes")).rejects.toThrow(/outside the workspace/);
    await expect(gitStage(repo, ["../outside.txt"])).rejects.toThrow(/outside the workspace/);
    await expect(gitDiscard(repo, ["../outside.txt"])).rejects.toThrow(/outside the workspace/);
    expect(fs.existsSync(outside)).toBe(true);
    expect((await readPreview(repo, path.join(repo, "a.txt"))).kind).toBe("text");
  });
});

describe("workspace git", () => {
  it("reports every status kind with both sides of a file changed twice and a rename's destination", async () => {
    const { repo } = makeRepo("status", { "a.txt": "a\n", "gone.txt": "g\n", "old.txt": "old\n", "dup.txt": "base\n" });
    write(repo, "a.txt", "a changed\n");
    fs.rmSync(path.join(repo, "gone.txt"));
    write(repo, "untracked.txt", "new\n");
    run(repo, ["mv", "old.txt", "renamed.txt"]);
    write(repo, "dup.txt", "staged\n");
    run(repo, ["add", "dup.txt"]);
    write(repo, "dup.txt", "staged then working\n");

    const status = await gitStatus(repo);
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.files).toEqual(expect.arrayContaining([
      { path: path.join(repo, "a.txt"), status: "modified", staged: false },
      { path: path.join(repo, "gone.txt"), status: "deleted", staged: false },
      { path: path.join(repo, "untracked.txt"), status: "untracked", staged: false },
      { path: path.join(repo, "renamed.txt"), status: "renamed", staged: true },
      { path: path.join(repo, "dup.txt"), status: "modified", staged: true },
      { path: path.join(repo, "dup.txt"), status: "modified", staged: false },
    ]));
    expect(status.files.filter((file) => file.path === path.join(repo, "dup.txt"))).toHaveLength(2);
    expect(status.files.some((file) => file.path === path.join(repo, "old.txt"))).toBe(false);
    expect([status.ahead, status.behind]).toEqual([0, 0]);
  });

  it("marks an unresolved merge as a conflict", async () => {
    const { repo, origin } = makeRepo("conflict", { "a.txt": "base\n" });
    const other = cloneTeammate(origin, "other");
    write(other, "a.txt", "theirs\n");
    run(other, ["commit", "-q", "-am", "theirs"]);
    run(other, ["push", "-q"]);
    write(repo, "a.txt", "ours\n");
    run(repo, ["commit", "-q", "-am", "ours"]);
    await expect(gitPull(repo)).rejects.toThrow(/conflict/i);
    expect(await gitStatus(repo).then((status) => status.files)).toEqual([{ path: path.join(repo, "a.txt"), status: "conflict", staged: false }]);
  });

  it("diffs the working tree, the index and one commit; binary, deleted and ignored files have no diff", async () => {
    const { repo } = makeRepo("diff", { "a.txt": "one\ntwo\nthree\n", "gone.txt": "gone\n", "bin.dat": "text\n", ".gitignore": "ignored.txt\n" });
    const first = run(repo, ["rev-parse", "HEAD"]);
    const binary = commit(repo, "binary", { "bin.dat": Buffer.from([0, 1, 2]) });
    const a = path.join(repo, "a.txt");
    write(repo, "a.txt", "one\nTWO\nthree\n");
    run(repo, ["add", "a.txt"]);
    write(repo, "a.txt", "one\nTWO\nthree\nfour\n");
    fs.rmSync(path.join(repo, "gone.txt"));
    write(repo, "ignored.txt", "ignored\n");
    write(repo, "fresh.txt", "hello\n");
    write(repo, "bin.dat", Buffer.from([0, 9, 9]));

    const staged = await gitDiff(repo, a, "staged");
    expect(staged).toContain("+TWO");
    expect(staged).not.toContain("+four");
    const changes = await gitDiff(repo, a, "changes");
    expect(changes).toContain("+four");
    expect(changes).not.toContain("+TWO");
    expect(await gitDiff(repo, a, { commit: first })).toContain("+one");
    expect(await gitDiff(repo, path.join(repo, "fresh.txt"), "changes")).toContain("+hello");
    expect(await gitDiff(repo, path.join(repo, "gone.txt"), "changes")).toBeUndefined();
    expect(await gitDiff(repo, path.join(repo, "ignored.txt"), "changes")).toBeUndefined();
    expect(await gitDiff(repo, path.join(repo, "bin.dat"), "changes")).toBeUndefined();
    expect(await gitDiff(repo, path.join(repo, "bin.dat"), { commit: binary })).toBeUndefined();
    await expect(gitDiff(repo, a, { commit: "0000000" })).rejects.toThrow(/unknown commit/);
  });

  it("treats file names as literals, not Git pathspecs", async () => {
    const { repo } = makeRepo("literal-names", { "a.txt": "a\n" });
    write(repo, "glob*.txt", "literal\n");
    write(repo, "globX.txt", "other\n");
    await gitStage(repo, [path.join(repo, "glob*.txt")]);
    const staged = (await gitStatus(repo)).files.filter((file) => file.staged).map((file) => path.basename(file.path));
    expect(staged).toContain("glob*.txt");
    expect(staged).not.toContain("globX.txt");
    await gitDiscard(repo, [path.join(repo, "globX.txt")]);
    expect(fs.existsSync(path.join(repo, "globX.txt"))).toBe(false);
    expect(fs.existsSync(path.join(repo, "glob*.txt"))).toBe(true);
  });

  it("stages, unstages, discards and commits", async () => {
    const { repo } = makeRepo("mutate", { "keep.txt": "keep\n", "drop.txt": "drop\n" });
    write(repo, "keep.txt", "keep changed\n");
    write(repo, "extra.txt", "extra\n");
    await gitStage(repo, [path.join(repo, "keep.txt"), path.join(repo, "extra.txt")]);
    expect(await gitStatus(repo).then((status) => status.files)).toEqual([
      { path: path.join(repo, "extra.txt"), status: "added", staged: true },
      { path: path.join(repo, "keep.txt"), status: "modified", staged: true },
    ]);
    await gitUnstage(repo, "all");
    expect(await gitStatus(repo).then((status) => status.files.map((file) => [path.basename(file.path), file.staged]))).toEqual([
      ["extra.txt", false],
      ["keep.txt", false],
    ]);
    await gitStage(repo, "all");
    await gitCommit(repo, "change keep\n\nbody");
    const clean = await gitStatus(repo);
    expect(clean.files).toEqual([]);
    expect(clean.ahead).toBe(1);
    expect(await gitLog(repo, 1)).toMatchObject([{ subject: "change keep", direction: "outgoing" }]);
    await expect(gitCommit(repo, "  ")).rejects.toThrow(/empty commit message/);
    await expect(gitCommit(repo, "nothing staged")).rejects.toThrow(/nothing to commit|no changes added/);

    write(repo, "keep.txt", "dirty\n");
    write(repo, "untracked.txt", "gone\n");
    await gitDiscard(repo, [path.join(repo, "keep.txt")]);
    expect(fs.readFileSync(path.join(repo, "keep.txt"), "utf8")).toBe("keep changed\n");
    await gitDiscard(repo, [path.join(repo, "untracked.txt")]);
    expect(fs.existsSync(path.join(repo, "untracked.txt"))).toBe(false);

    write(repo, "keep.txt", "again\n");
    await gitStage(repo, "all");
    await gitUnstage(repo, "all");
    expect(await gitStatus(repo).then((status) => status.files)).toEqual([{ path: path.join(repo, "keep.txt"), status: "modified", staged: false }]);
  });

  it("lists the files one commit changed, including a rename", async () => {
    const { repo } = makeRepo("commit-files", { "a.txt": "a\n" });
    commit(repo, "add b", { "b.txt": "b\n" });
    expect(await gitCommitFiles(repo, run(repo, ["rev-parse", "HEAD"]))).toEqual([
      { path: path.join(repo, "b.txt"), status: "added", staged: false },
    ]);
    run(repo, ["mv", "a.txt", "renamed.txt"]);
    run(repo, ["commit", "-q", "-m", "rename a"]);
    expect(await gitCommitFiles(repo, run(repo, ["rev-parse", "HEAD"]))).toEqual([
      { path: path.join(repo, "renamed.txt"), status: "renamed", staged: false },
    ]);
  });
});

describe("workspace sync", () => {
  it("fetches what a teammate pushed and labels commits incoming, outgoing and shared", async () => {
    const { repo, origin } = makeRepo("sync");
    const initial = run(repo, ["rev-parse", "HEAD"]);
    const other = cloneTeammate(origin, "other");
    const teammate = commit(other, "teammate: fix", { "b.txt": "b\n" }, later(2));
    run(other, ["push", "-q"]);
    const mine = commit(repo, "mine: local", { "a.txt": "mine\n" }, later(1));

    const before = await gitStatus(repo);
    expect([before.ahead, before.behind]).toEqual([1, 0]); // as of the last fetch
    await gitFetch(repo);
    const after = await gitStatus(repo);
    expect([after.ahead, after.behind]).toEqual([1, 1]);
    expect(after.upstream).toBe("origin/main");

    const log = await gitLog(repo, 10);
    expect(log.map((entry) => [entry.subject, entry.direction])).toEqual([
      ["teammate: fix", "incoming"],
      ["mine: local", "outgoing"],
      ["init", "shared"],
    ]);
    expect(log.map((entry) => entry.hash)).toEqual([teammate, mine, initial]);
    await expect(gitPush(repo)).rejects.toThrow(/rejected|fetch first|non-fast-forward/i);
  });

  it("pulls a teammate's commit fast-forward", async () => {
    const { repo, origin } = makeRepo("pull");
    const other = cloneTeammate(origin, "other");
    commit(other, "teammate", { "teammate.txt": "hello\n" }, later(1));
    run(other, ["push", "-q"]);
    await gitFetch(repo);
    expect((await gitStatus(repo)).behind).toBe(1);
    await gitPull(repo);
    expect(fs.readFileSync(path.join(repo, "teammate.txt"), "utf8")).toBe("hello\n");
    expect(await gitStatus(repo)).toMatchObject({ ahead: 0, behind: 0 });
  });

  it("publishes a branch without an upstream as origin/<name> and follows it", async () => {
    const base = path.join(root, "publish");
    const origin = bareOrigin(base);
    const repo = path.join(base, "repo");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    run(repo, ["remote", "add", "origin", origin]);
    commit(repo, "first", { "a.txt": "a\n" });
    expect((await gitStatus(repo)).upstream).toBeUndefined();

    await gitPush(repo);
    const published = await gitStatus(repo);
    expect(published.upstream).toBe("origin/main");
    expect([published.ahead, published.behind]).toEqual([0, 0]);
    expect(run(origin, ["rev-parse", "main"])).toBe(run(repo, ["rev-parse", "HEAD"]));

    commit(repo, "second", { "b.txt": "b\n" });
    expect((await gitStatus(repo)).ahead).toBe(1);
    await gitPush(repo);
    expect(run(origin, ["rev-parse", "main"])).toBe(run(repo, ["rev-parse", "HEAD"]));
  });
});

describe("workspace branches", () => {
  it("lists local branches first (current on top), then remote branches nobody follows", async () => {
    const { repo } = makeRepo("branches");
    run(repo, ["checkout", "-q", "-b", "feature"]);
    commit(repo, "feature work", { "feature.txt": "f\n" }, later(3));
    run(repo, ["push", "-q", "-u", "origin", "feature"]);
    run(repo, ["checkout", "-q", "main"]);
    run(repo, ["checkout", "-q", "-b", "local-only"]);
    commit(repo, "local work", { "local.txt": "l\n" }, later(2));
    run(repo, ["checkout", "-q", "main"]);
    run(repo, ["push", "-q", "origin", "main:refs/heads/topic"]);
    await gitFetch(repo);

    const branches = await gitBranches(repo);
    expect(branches.map((branch) => [branch.name, branch.remote, branch.current])).toEqual([
      ["main", false, true],
      ["feature", false, false],
      ["local-only", false, false],
      ["origin/topic", true, false],
    ]);
    expect(branches.find((branch) => branch.name === "feature")).toMatchObject({ upstream: "origin/feature", ahead: 0, behind: 0, author: "Test User" });
    expect(branches.find((branch) => branch.name === "origin/topic")).toMatchObject({ remote: true, current: false, ahead: 0, behind: 0 });
    expect(branches[0]?.upstream).toBe("origin/main");
    expect(branches[0]?.time).toBe(Number(run(repo, ["log", "-1", "--format=%at", "main"])) * 1000);
  });

  it("labels a branch without an upstream by what the remotes already have", async () => {
    const { repo } = makeRepo("log-no-upstream");
    run(repo, ["checkout", "-q", "-b", "solo"]);
    commit(repo, "pushed elsewhere", { "x.txt": "x\n" }, later(1));
    run(repo, ["push", "-q", "origin", "HEAD:refs/heads/published"]);
    await gitFetch(repo);
    commit(repo, "local only", { "y.txt": "y\n" }, later(2));
    expect(await gitStatus(repo).then((status) => status.upstream)).toBeUndefined();
    expect(await gitLog(repo, 10)).toMatchObject([
      { subject: "local only", direction: "outgoing" },
      { subject: "pushed elsewhere", direction: "shared" },
      { subject: "init", direction: "shared" },
    ]);
  });

  it("creates a branch from HEAD, and a local branch from a remote one", async () => {
    const { repo } = makeRepo("checkout");
    await gitCheckout(repo, "wip", true);
    expect((await gitStatus(repo)).branch).toBe("wip");
    await expect(gitCheckout(repo, "wip", true)).rejects.toThrow(/already exists/);

    run(repo, ["checkout", "-q", "main"]);
    run(repo, ["push", "-q", "origin", "main:refs/heads/remote-only"]);
    await gitFetch(repo);
    await gitCheckout(repo, "origin/remote-only");
    expect(await gitStatus(repo)).toMatchObject({ branch: "remote-only", upstream: "origin/remote-only" });
  });
});

describe("workspace watch", () => {
  it("fires on a file edit and on a commit", async () => {
    const { repo } = makeRepo("watch");
    // Real fs.watch notifications are the completion signal, so no fake timers here; the test timeout bounds a lost event.
    const watchOnce = (action: () => void): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      const stop = watchWorkspace(repo, () => {
        stop();
        resolve();
      });
      action();
      return promise;
    };

    await watchOnce(() => write(repo, "a.txt", "edited\n"));
    write(repo, "a.txt", "staged\n");
    run(repo, ["add", "a.txt"]);
    await watchOnce(() => run(repo, ["commit", "-q", "-m", "watched"]));
  }, 15_000);

  it("reports a plain directory as not a repository", async () => {
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain, { recursive: true });
    expect(await gitStatus(plain)).toEqual({ isRepo: false, ahead: 0, behind: 0, files: [] });
  });
});

describe("workspace IPC", () => {
  it("wraps results and errors, and forwards subscribed watch events", async () => {
    type Handler = (event: any, ...args: any[]) => any;
    const handlers = new Map<string, Handler>();
    const listeners = new Map<string, Handler>();
    const sent: unknown[][] = [];
    const sender = {
      id: 1,
      isDestroyed: () => false,
      send: (channel: string, ...args: unknown[]) => {
        sent.push([channel, ...args]);
      },
      once: () => {},
      on: () => {},
      removeListener: () => {},
    };
    registerWorkspaceIpc({
      handle: (channel: string, handler: Handler) => void handlers.set(channel, handler),
      on: (channel: string, handler: Handler) => void listeners.set(channel, handler),
    });
    const { repo } = makeRepo("ipc");

    const status = await handlers.get("workspace:gitStatus")!({ sender }, repo);
    expect(status).toMatchObject({ ok: true, value: { isRepo: true, branch: "main" } });
    const refused = await handlers.get("workspace:read")!({ sender }, repo, "../outside.txt");
    expect(refused).toEqual({ ok: false, error: expect.stringMatching(/outside the workspace/) });
    const empty = await handlers.get("workspace:gitCommit")!({ sender }, repo, "   ");
    expect(empty).toEqual({ ok: false, error: "Aborting commit due to empty commit message." });

    expect(handlers.get("workspace:watch")!({ sender }, repo, "w1")).toEqual({ ok: true, value: true });
    const changed = Promise.withResolvers<void>();
    const send = sender.send;
    sender.send = (channel: string, ...args: unknown[]) => {
      send(channel, ...args);
      if (channel === "workspace:changed" && args[0] === "w1") changed.resolve();
    };
    write(repo, "a.txt", "ipc\n");
    await changed.promise;
    listeners.get("workspace:unwatch")!({ sender }, "w1");
  }, 15_000);
});
