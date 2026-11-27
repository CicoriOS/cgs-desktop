// The workspace's files and Git, in the Electron main process (ADR 0046 §7): Node fs plus the git CLI, no other dependency. Everything
// except `registerWorkspaceIpc` is plain Node, so the logic is unit-tested without Electron. Security: every path argument is resolved
// inside the workspace both lexically and through symlinks, and Git always runs as `git -C <cwd> ... -- <paths>` with an argument list, so
// a file name never becomes an option or a shell word.
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Bigger files come back as `large` instead of being read into memory (and, for images, instead of a huge base64 string over IPC). */
const TEXT_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
/** A diff or status larger than this is a malformed answer; the command is failed instead of buffering forever. */
const MAX_BUFFER = 64 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 60_000;
const WATCH_DEBOUNCE_MS = 120;

/**
 * Images travel as base64 data URLs: they need no protocol registration, and they load both from the Vite dev origin (http) and from the
 * packaged page (file:// or an app protocol) while the renderer is sandboxed. Larger images are reported as `large` instead.
 */
const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

/** Porcelain v1 worktree/index code pairs that mean an unresolved merge. */
const UNMERGED = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

const STATUS_KINDS = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "added", T: "modified", U: "conflict" };

const KIND_OF_STATUS = (code) => STATUS_KINDS[code] ?? "modified";

/** Paths and Git state must never leak the user's shell environment into a different repository. */
function gitEnv() {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    // Status must not rewrite the index's stat cache: that write would itself look like a workspace change and retrigger the watcher.
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
  };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_NAMESPACE"]) delete env[key];
  return env;
}

/** Runs Git without throwing on a non-zero exit; the caller decides which codes it tolerates. */
async function execGit(cwd, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["--literal-pathspecs", "-C", cwd, ...args], {
      env: gitEnv(),
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? MAX_BUFFER,
      timeout: options.timeout,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    // A spawn failure (git is not installed) has a string code; a Git refusal has a numeric exit code.
    if (typeof error.code !== "number" && !error.killed && !error.signal) throw new Error(error.message);
    return {
      code: typeof error.code === "number" ? error.code : -1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : "",
      killed: Boolean(error.killed),
      signal: error.signal,
    };
  }
}

/** Runs Git and turns its refusal into a readable message (Git's own stderr, which the panel shows as it came). */
async function git(cwd, args, options = {}) {
  const result = await execGit(cwd, args, options);
  if (result.code === 0 || (options.allowExitCodes ?? []).includes(result.code)) return result.stdout;
  if (result.killed || result.signal) throw new Error(`git ${args[0]} timed out`);
  const message = result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed (exit ${result.code})`;
  throw new Error(message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** The workspace root as the page gave it, checked to exist and to be a directory. */
async function workspaceDir(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("missing workspace directory");
  const dir = path.resolve(cwd);
  const stat = await fs.stat(dir).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`workspace not found: ${dir}`);
  return dir;
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Resolves symlinks on the longest existing prefix, so a link inside the workspace cannot reach outside it. */
async function realpathNearest(target) {
  let current = target;
  const missing = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** An absolute path that stays inside `root`, or a refusal. The returned path keeps the spelling of `root` (a symlinked workspace stays usable). */
async function resolveInside(root, target) {
  if (typeof target !== "string" || target === "") throw new Error("missing path");
  const abs = path.isAbsolute(target) ? path.normalize(target) : path.resolve(root, target);
  if (!isInside(root, abs)) throw new Error(`path is outside the workspace: ${target}`);
  const rootReal = await fs.realpath(root);
  const real = await realpathNearest(abs);
  if (!isInside(rootReal, real)) throw new Error(`path is outside the workspace: ${target}`);
  return abs;
}

/** Git paths are cwd-relative with "/" separators on every platform. */
function gitPath(root, abs) {
  const rel = path.relative(root, abs);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

async function resolveMany(root, paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error("no paths given");
  const abs = [];
  for (const target of paths) abs.push(await resolveInside(root, target));
  return abs.map((one) => gitPath(root, one));
}

const looksBinary = (buffer) => buffer.subarray(0, 8000).includes(0);

/** Reads just the head of a file: an untracked binary may be gigabytes, and only its first bytes decide. */
async function fileLooksBinary(abs) {
  const handle = await fs.open(abs, "r");
  try {
    const buffer = Buffer.alloc(8000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return looksBinary(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

// Paths Git does not ignore; `check-ignore` cannot take --literal-pathspecs, so ask for the untracked files Git would show instead.
async function visibleUntracked(root) {
  const out = await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  return new Set(out.split("\0").filter(Boolean));
}

async function isTracked(root, rel) {
  const result = await execGit(root, ["ls-files", "--error-unmatch", "--", rel]);
  return result.code === 0;
}

/** A unified diff worth showing, or undefined for an empty/binary one. */
function patchOrUndefined(patch) {
  if (!patch.trim()) return undefined;
  if (/^Binary files .* differ$/m.test(patch) || patch.includes("GIT binary patch")) return undefined;
  return patch;
}

function trackCounts(track) {
  const ahead = Number(/ahead (\d+)/.exec(track ?? "")?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(track ?? "")?.[1] ?? 0);
  return { ahead, behind };
}

/** `git status --porcelain=v1 -z` from a repository root; `prefix` is the workspace's `--show-prefix` when it is a subdirectory. */
function parseStatus(output, root, prefix) {
  const files = [];
  const parts = output.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record || record.length < 4) continue;
    const index = record[0];
    const worktree = record[1];
    const name = record.slice(3);
    // With -z a rename is "XY <new path>\0<old path>\0": the destination is the path the panel shows.
    if (index === "R" || index === "C") i += 1;
    if (prefix && !name.startsWith(prefix)) continue;
    const abs = path.resolve(root, name.slice(prefix.length));
    if (!isInside(root, abs)) continue;
    if (UNMERGED.has(index + worktree)) {
      files.push({ path: abs, status: "conflict", staged: false });
      continue;
    }
    if (index === "?") {
      files.push({ path: abs, status: "untracked", staged: false });
      continue;
    }
    if (index !== " ") files.push({ path: abs, status: KIND_OF_STATUS(index), staged: true });
    if (worktree !== " ") files.push({ path: abs, status: KIND_OF_STATUS(worktree), staged: false });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : Number(b.staged) - Number(a.staged)));
}

export async function listDirectory(cwd, dir) {
  const root = await workspaceDir(cwd);
  const abs = await resolveInside(root, dir ?? root);
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read ${gitPath(root, abs)}: ${error.message}`);
  }
  const result = [];
  for (const entry of entries) {
    const full = path.join(abs, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) isDir = await fs.stat(full).then((stat) => stat.isDirectory(), () => false);
    result.push({ name: entry.name, path: full, dir: isDir });
  }
  return result.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

export async function readPreview(cwd, file) {
  const root = await workspaceDir(cwd);
  const abs = await resolveInside(root, file);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`not a file: ${gitPath(root, abs)}`);
  const mime = IMAGE_TYPES[path.extname(abs).toLowerCase()];
  if (mime) {
    if (stat.size > IMAGE_LIMIT) return { kind: "large", size: stat.size };
    const data = await fs.readFile(abs);
    return { kind: "image", url: `data:${mime};base64,${data.toString("base64")}` };
  }
  if (stat.size > TEXT_LIMIT) return { kind: "large", size: stat.size };
  const data = await fs.readFile(abs);
  if (looksBinary(data)) return { kind: "binary" };
  return { kind: "text", text: data.toString("utf8") };
}

export async function gitStatus(cwd) {
  const root = await workspaceDir(cwd);
  const inside = await execGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    if (inside.code !== 0 && !/not a git repository/i.test(inside.stderr)) {
      throw new Error(inside.stderr.trim() || `git rev-parse failed (exit ${inside.code})`);
    }
    return { isRepo: false, ahead: 0, behind: 0, files: [] };
  }
  const [prefixOut, statusOut, symbolic, headShort, nameOut, emailOut] = await Promise.all([
    git(root, ["rev-parse", "--show-prefix"]),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    execGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
    execGit(root, ["rev-parse", "--short", "HEAD"]),
    execGit(root, ["config", "--get", "user.name"]),
    execGit(root, ["config", "--get", "user.email"]),
  ]);
  const prefix = prefixOut.trim();
  const branch = symbolic.code === 0 ? symbolic.stdout.trim() : "";
  const detached = !branch && headShort.code === 0 ? headShort.stdout.trim() : undefined;
  let upstream;
  let ahead = 0;
  let behind = 0;
  if (branch) {
    // Asking the branch's own ref gives the upstream even after it was deleted on the server ("[gone]"), plus the last known counts.
    const rows = await git(root, ["for-each-ref", "--format=%(upstream:short)%00%(upstream:track)", `refs/heads/${branch}`]);
    const [up, track] = (rows.split("\n")[0] ?? "").split("\0");
    if (up) {
      upstream = up;
      ({ ahead, behind } = trackCounts(track));
    }
  }
  const name = nameOut.code === 0 ? nameOut.stdout.trim() : "";
  const email = emailOut.code === 0 ? emailOut.stdout.trim() : "";
  return {
    isRepo: true,
    ...(branch ? { branch } : {}),
    ...(detached ? { detached } : {}),
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    ...(name && email ? { user: { name, email } } : {}),
    files: parseStatus(statusOut, root, prefix),
  };
}

export async function gitDiff(cwd, file, target) {
  const root = await workspaceDir(cwd);
  const abs = await resolveInside(root, file);
  const rel = gitPath(root, abs);
  const diffArgs = ["diff", "--no-color", "--no-ext-diff", "--relative"];

  if (target && typeof target === "object") {
    const commit = typeof target.commit === "string" ? target.commit : "";
    // A revision, not a path: keep it to a hash so it cannot be read as an option.
    if (!/^[0-9a-fA-F]{4,40}$/.test(commit)) throw new Error(`invalid commit: ${commit}`);
    const exists = await execGit(root, ["rev-parse", "--verify", "-q", `${commit}^{commit}`]);
    if (exists.code !== 0) throw new Error(`unknown commit: ${commit}`);
    const parent = await execGit(root, ["rev-parse", "--verify", "-q", `${commit}^`]);
    // The diff of one commit against its (first) parent; the root commit has no parent and is shown against the empty tree.
    const patch = parent.code === 0
      ? await git(root, [...diffArgs, parent.stdout.trim(), commit, "--", rel])
      : await git(root, ["show", "--format=", "--no-color", "--no-ext-diff", "--relative", commit, "--", rel]);
    return patchOrUndefined(patch);
  }

  if (target === "staged") {
    // Nothing in the index means a staged deletion (or a path never added): there is no "after" side to show.
    if (!await isTracked(root, rel)) return undefined;
    return patchOrUndefined(await git(root, [...diffArgs, "--cached", "--", rel]));
  }

  if (target !== "changes") throw new Error(`unknown diff target: ${String(target)}`);
  const stat = await fs.stat(abs).catch(() => undefined);
  // Deleted from the working tree (or a directory): no working-tree diff to show.
  if (!stat?.isFile()) return undefined;
  if (!await isTracked(root, rel)) {
    if (!(await visibleUntracked(root)).has(rel)) return undefined; // ignored
    if (await fileLooksBinary(abs)) return undefined;
    // Untracked files are shown as the patch that would add them; --no-index exits 1 when the files differ.
    return patchOrUndefined(await git(root, ["diff", "--no-index", "--no-color", "/dev/null", "--", rel], { allowExitCodes: [1] }));
  }
  return patchOrUndefined(await git(root, [...diffArgs, "--", rel]));
}

export async function gitStage(cwd, paths) {
  const root = await workspaceDir(cwd);
  if (paths === "all") {
    await git(root, ["add", "-A", "--", "."]);
    return;
  }
  await git(root, ["add", "-A", "--", ...await resolveMany(root, paths)]);
}

export async function gitUnstage(cwd, paths) {
  const root = await workspaceDir(cwd);
  if (paths === "all") {
    await git(root, ["reset", "-q", "--", "."]);
    return;
  }
  await git(root, ["reset", "-q", "--", ...await resolveMany(root, paths)]);
}

export async function gitDiscard(cwd, paths) {
  const root = await workspaceDir(cwd);
  const rels = await resolveMany(root, paths);
  // Tracked files come back from the index; untracked ones (never in it) are deleted, as the panel promises.
  const tracked = new Set();
  const listed = await git(root, ["ls-files", "-z", "--", ...rels]);
  for (const name of listed.split("\0")) if (name) tracked.add(name);
  const restore = rels.filter((rel) => tracked.has(rel));
  const remove = rels.filter((rel) => !tracked.has(rel));
  if (restore.length) await git(root, ["restore", "--worktree", "--", ...restore]);
  for (const rel of remove) await fs.rm(path.resolve(root, rel), { recursive: true, force: true });
}

export async function gitCommit(cwd, message) {
  const root = await workspaceDir(cwd);
  if (typeof message !== "string" || !message.trim()) throw new Error("Aborting commit due to empty commit message.");
  await git(root, ["commit", "-m", message]);
}

export async function gitFetch(cwd) {
  const root = await workspaceDir(cwd);
  await git(root, ["fetch", "--quiet"], { timeout: NETWORK_TIMEOUT_MS });
}

export async function gitPull(cwd) {
  const root = await workspaceDir(cwd);
  // --no-rebase is required, not cosmetic: since Git 2.34 a diverged pull refuses to run without an explicit merge/rebase choice.
  await git(root, ["pull", "--no-rebase", "--no-edit"], { timeout: NETWORK_TIMEOUT_MS });
}

export async function gitPush(cwd) {
  const root = await workspaceDir(cwd);
  const symbolic = await execGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const branch = symbolic.code === 0 ? symbolic.stdout.trim() : "";
  if (!branch) throw new Error("cannot push: HEAD is detached");
  const upstream = await execGit(root, ["rev-parse", "--verify", "-q", "@{upstream}"]);
  if (upstream.code === 0) await git(root, ["push", "--quiet"], { timeout: NETWORK_TIMEOUT_MS });
  else await git(root, ["push", "--quiet", "--set-upstream", "origin", branch], { timeout: NETWORK_TIMEOUT_MS });
}

export async function gitBranches(cwd) {
  const root = await workspaceDir(cwd);
  const out = await git(root, [
    "for-each-ref",
    "--format=%(refname)%00%(upstream:short)%00%(upstream:track)%00%(authorname)%00%(authordate:unix)%00%(HEAD)",
    "refs/heads",
    "refs/remotes",
  ]);
  const locals = [];
  const remotes = [];
  const followed = new Set();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [ref, upstream, track, author, unix, head] = line.split("\0");
    if (!ref) continue;
    if (ref.startsWith("refs/heads/")) {
      const name = ref.slice("refs/heads/".length);
      if (upstream) followed.add(upstream);
      locals.push({
        name,
        remote: false,
        current: head === "*",
        ...(upstream ? { upstream } : {}),
        ...trackCounts(track),
        author: author ?? "",
        time: Number(unix ?? 0) * 1000,
      });
    } else if (ref.startsWith("refs/remotes/")) {
      // refs/remotes/<remote>/HEAD is a symbolic alias of the remote's default branch, not a branch of its own.
      if (ref.endsWith("/HEAD")) continue;
      remotes.push({
        name: ref.slice("refs/remotes/".length),
        remote: true,
        current: false,
        ahead: 0,
        behind: 0,
        author: author ?? "",
        time: Number(unix ?? 0) * 1000,
      });
    }
  }
  const localOrder = (a, b) => Number(b.current) - Number(a.current) || b.time - a.time || a.name.localeCompare(b.name);
  const remoteOrder = (a, b) => b.time - a.time || a.name.localeCompare(b.name);
  return [...locals.sort(localOrder), ...remotes.filter((branch) => !followed.has(branch.name)).sort(remoteOrder)];
}

export async function gitCheckout(cwd, branch, create = false) {
  const root = await workspaceDir(cwd);
  if (typeof branch !== "string" || !branch.trim()) throw new Error("missing branch name");
  const name = branch.trim();
  if (name.startsWith("-")) throw new Error(`invalid branch name: ${name}`);
  if (create) {
    await git(root, ["checkout", "-b", name]);
    return;
  }
  if (name === "HEAD") throw new Error(`invalid branch name: ${name}`);
  const local = await execGit(root, ["rev-parse", "--verify", "-q", `refs/heads/${name}`]);
  if (local.code === 0) {
    await git(root, ["checkout", name]);
    return;
  }
  // refs/remotes/<remote>/HEAD is an alias, not a branch to start from.
  if (name.endsWith("/HEAD")) throw new Error(`invalid branch name: ${name}`);
  const remote = await execGit(root, ["rev-parse", "--verify", "-q", `refs/remotes/${name}`]);
  if (remote.code === 0) {
    // A remote name starts the local branch that follows it (origin/feature/x -> feature/x tracking origin/feature/x).
    await git(root, ["checkout", "--track", name]);
    return;
  }
  await git(root, ["checkout", name]);
}

const LOG_FORMAT = "--format=%H%x00%s%x00%an%x00%ae%x00%ct";

function parseLog(output, direction) {
  const commits = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [hash, subject, author, email, unix] = line.split("\0");
    if (!hash) continue;
    commits.push({ hash, subject: subject ?? "", author: author ?? "", email: email ?? "", time: Number(unix ?? 0) * 1000, direction });
  }
  return commits;
}

async function logBucket(root, take, revisions, direction) {
  return parseLog(await git(root, ["log", "-n", String(take), LOG_FORMAT, ...revisions]), direction);
}

export async function gitLog(cwd, limit) {
  const root = await workspaceDir(cwd);
  const asked = Number.isFinite(limit) ? Math.floor(limit) : 100;
  const take = Math.max(1, Math.min(1000, asked));
  const head = await execGit(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (head.code !== 0) return [];
  const upstream = await execGit(root, ["rev-parse", "--verify", "-q", "@{upstream}"]);
  let buckets;
  if (upstream.code === 0) {
    const [outgoing, incoming] = await Promise.all([
      logBucket(root, take, ["@{upstream}..HEAD"], "outgoing"),
      logBucket(root, take, ["HEAD..@{upstream}"], "incoming"),
    ]);
    // Commits reachable from both sides, newest branch-history first: the merge base's history. A criss-cross merge can have several
    // bases; the first is git's own choice and still describes shared history.
    const base = await execGit(root, ["merge-base", "HEAD", "@{upstream}"]);
    const baseHash = base.stdout.trim().split("\n")[0] ?? "";
    const shared = base.code === 0 && baseHash ? await logBucket(root, take, [baseHash], "shared") : [];
    buckets = [outgoing, incoming, shared];
  } else {
    // Without an upstream only this branch's history is listed; commits any remote-tracking branch already has count as shared, which
    // tells a pushed commit from a local one. The set of unpublished commits is usually small; a repository without remotes skips it.
    const remotes = await git(root, ["for-each-ref", "refs/remotes"]);
    const unpublished = remotes.trim()
      ? new Set((await git(root, ["rev-list", "HEAD", "--not", "--remotes"])).split("\n").filter(Boolean))
      : new Set();
    buckets = [(await logBucket(root, take, ["HEAD"], "shared")).map((entry) => ({
      ...entry,
      direction: unpublished.has(entry.hash) ? "outgoing" : "shared",
    }))];
  }
  const seen = new Set();
  const commits = [];
  for (const commit of buckets.flat()) {
    if (seen.has(commit.hash)) continue;
    seen.add(commit.hash);
    commits.push(commit);
  }
  return commits.sort((a, b) => b.time - a.time || (a.hash < b.hash ? -1 : 1)).slice(0, take);
}

export async function gitCommitFiles(cwd, hash) {
  const root = await workspaceDir(cwd);
  const commit = typeof hash === "string" ? hash : "";
  if (!/^[0-9a-fA-F]{4,40}$/.test(commit)) throw new Error(`invalid commit: ${commit}`);
  const out = await git(root, ["show", "--format=", "--name-status", "-z", "--relative", "--first-parent", commit]);
  const parts = out.split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status) continue;
    const code = status[0];
    if (code === "R" || code === "C") {
      // Status, original path, then the path that exists in that commit.
      const to = parts[i + 2];
      i += 2;
      const abs = path.resolve(root, to ?? "");
      if (!to || !isInside(root, abs)) continue;
      files.push({ path: abs, status: code === "R" ? "renamed" : "added", staged: false });
    } else {
      const name = parts[i + 1];
      i += 1;
      if (!name) continue;
      const abs = path.resolve(root, name);
      if (!isInside(root, abs)) continue;
      files.push({ path: abs, status: KIND_OF_STATUS(code), staged: false });
    }
  }
  return files;
}

const NOISE = [/(^|[\\/])node_modules([\\/]|$)/, /(^|[\\/])\.git[\\/]objects([\\/]|$)/];

/** `fs.watch` recursive reports changes anywhere under the workspace; `.git/objects` and node_modules are noise, refs and the index are not. */
export function watchWorkspace(cwd, listener) {
  if (typeof cwd !== "string" || !cwd.trim()) throw new Error("missing workspace directory");
  if (typeof listener !== "function") throw new Error("missing change listener");
  const dir = path.resolve(cwd);
  let timer;
  const fire = () => {
    timer = undefined;
    listener();
  };
  const onEvent = (_event, file) => {
    if (typeof file === "string" && NOISE.some((pattern) => pattern.test(file))) return;
    if (timer) return; // a burst of writes is one reload at the end
    timer = setTimeout(fire, WATCH_DEBOUNCE_MS);
  };
  let watcher;
  try {
    watcher = fsSync.watch(dir, { recursive: true }, onEvent);
  } catch {
    // Older runtimes and some platforms cannot watch recursively; top-level changes still arrive.
    watcher = fsSync.watch(dir, onEvent);
  }
  watcher.on("error", () => {}); // a removed workspace ends the watcher quietly; the next workspace starts a new one
  return () => {
    clearTimeout(timer);
    timer = undefined;
    watcher.close();
  };
}

/** Every renderer-facing method of WorkspaceApi, minus `watch`, which needs the webContents that subscribed. */
export const workspaceMethods = {
  list: listDirectory,
  read: readPreview,
  gitStatus,
  gitDiff,
  gitStage,
  gitUnstage,
  gitDiscard,
  gitCommit,
  gitFetch,
  gitPull,
  gitPush,
  gitBranches,
  gitCheckout,
  gitLog,
  gitCommitFiles,
};

const watched = new Map();
/** webContents whose teardown already drops its watches. */
const watchedSenders = new WeakSet();

function stopWatch(key) {
  const record = watched.get(key);
  if (!record) return;
  watched.delete(key);
  record.stop();
}

function stopSenderWatches(sender) {
  for (const [key, record] of watched) if (record.sender === sender) stopWatch(key);
}

/** A reload throws the old document's subscriptions away without calling their unsubscribe; its watchers go with the document. */
function cleanupOnUnload(sender) {
  if (watchedSenders.has(sender)) return;
  watchedSenders.add(sender);
  const drop = () => stopSenderWatches(sender);
  sender.on("destroyed", drop);
  sender.on("did-start-loading", drop);
}

/**
 * Wires WorkspaceApi onto ipcMain. Results travel as `{ ok, value }` / `{ ok, error }`: Electron's own wrapper around a rejected handler
 * would hide Git's message behind "Error invoking remote method ...", and the panel shows that message verbatim.
 */
export function registerWorkspaceIpc(ipcMain) {
  for (const [name, method] of Object.entries(workspaceMethods)) {
    ipcMain.handle(`workspace:${name}`, async (_event, cwd, ...args) => {
      try {
        return { ok: true, value: await method(cwd, ...args) };
      } catch (error) {
        return { ok: false, error: errorMessage(error) };
      }
    });
  }

  ipcMain.handle("workspace:watch", (event, cwd, id) => {
    if (typeof id !== "string" || !id) return { ok: false, error: "missing watch id" };
    const sender = event.sender;
    const key = `${sender.id}:${id}`;
    try {
      stopWatch(key);
      const stop = watchWorkspace(cwd, () => {
        if (sender.isDestroyed()) return stopWatch(key);
        try {
          sender.send("workspace:changed", id);
        } catch {
          stopWatch(key);
        }
      });
      watched.set(key, { stop, sender });
      cleanupOnUnload(sender);
      return { ok: true, value: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.on("workspace:unwatch", (event, id) => {
    if (typeof id === "string") stopWatch(`${event.sender.id}:${id}`);
  });
}
