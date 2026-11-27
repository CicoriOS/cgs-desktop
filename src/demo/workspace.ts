// The demo's workspaces: a small file tree per directory inside an in-memory Git repository (git.ts).
import type { FileEntry, FilePreview, WorkspaceApi } from "../core/types";
import { type DemoFile, type DemoRepo, demoGit, seedCommit } from "./git";

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

const LOGIN_HEAD = lines(
  'import { useState } from "react";',
  "",
  "export function LoginForm({ onSubmit }: { onSubmit(v: { email: string; password: string }): void }) {",
  '  const [email, setEmail] = useState("");',
  '  const [password, setPassword] = useState("");',
  '  const [error, setError] = useState("");',
  "",
  "  function submit() {",
  '    if (!email.includes("@")) return setError("邮箱格式不对");',
  '    if (password.length < 6) return setError("密码至少 6 位");',
  '    setError("");',
  "    onSubmit({ email, password });",
  "  }",
  "  return <form onSubmit={(e) => (e.preventDefault(), submit())}>…</form>;",
  "}",
);

const LOGIN_NOW = lines(
  'import { useState } from "react";',
  'import { email as checkEmail, firstError, password as checkPassword } from "../lib/validators";',
  "",
  "export function LoginForm({ onSubmit }: { onSubmit(v: { email: string; password: string }): void }) {",
  '  const [email, setEmail] = useState("");',
  '  const [password, setPassword] = useState("");',
  '  const [error, setError] = useState("");',
  "",
  "  function submit() {",
  "    const problem = firstError(email, checkEmail) ?? firstError(password, checkPassword);",
  "    if (problem) return setError(problem);",
  '    setError("");',
  "    onSubmit({ email, password });",
  "  }",
  "  return <form onSubmit={(e) => (e.preventDefault(), submit())}>…</form>;",
  "}",
);

const HIGHLIGHT_HEAD = lines(
  'import hljs from "highlight.js/lib/core";',
  'import bash from "highlight.js/lib/languages/bash";',
  'hljs.registerLanguage("bash", bash);',
  "",
  "export const highlight = (code: string, language: string) => hljs.highlight(code, { language }).value;",
);

export const HIGHLIGHT_AFTER = lines(
  'import hljs from "highlight.js/lib/core";',
  'const loaders = { bash: () => import("highlight.js/lib/languages/bash") };',
  "export const ensureLanguage = async (name: keyof typeof loaders) =>",
  "  hljs.getLanguage(name) ?? hljs.registerLanguage(name, (await loaders[name]()).default);",
  "",
  "export const highlight = (code: string, language: string) => hljs.highlight(code, { language }).value;",
);

const LOGO = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#7c5cf0"/><path d="M20 44V20l24 24V20" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;

const WEB_FILES: Record<string, DemoFile> = {
  "package.json": { head: lines("{", '  "name": "cgs-web",', '  "private": true,', '  "scripts": { "dev": "vite", "build": "vite build", "test": "bun test" }', "}"), text: lines("{", '  "name": "cgs-web",', '  "private": true,', '  "scripts": { "dev": "vite", "build": "vite build", "test": "bun test" }', "}") },
  "vite.config.ts": { head: lines('import { defineConfig } from "vite";', "", "export default defineConfig({ build: { target: \"es2022\" } });"), text: lines('import { defineConfig } from "vite";', "", "export default defineConfig({ build: { target: \"es2022\" } });") },
  "README.md": {
    head: lines("# cgs-web", "", "CGS 的网页客户端。", "", "## 开发", "", "```sh", "bun install", "bun run dev", "```", "", "## 目录", "", "- `src/pages`：页面", "- `src/lib`：与界面无关的逻辑"),
    text: lines("# cgs-web", "", "CGS 的网页客户端。", "", "## 开发", "", "```sh", "bun install", "bun run dev", "```", "", "## 目录", "", "- `src/pages`：页面", "- `src/lib`：与界面无关的逻辑"),
  },
  "src/pages/LoginForm.tsx": { head: LOGIN_HEAD, text: LOGIN_NOW },
  "src/pages/Register.tsx": { head: lines('export function Register() {', "  return <form>…</form>;", "}"), text: lines('export function Register() {', "  return <form>…</form>;", "}") },
  "src/lib/api.ts": { head: lines("export async function login(email: string, password: string) {", '  if (password.length < 8) throw new Error("weak password");', "  return fetch(\"/api/login\", { method: \"POST\", body: JSON.stringify({ email, password }) });", "}"), text: lines("export async function login(email: string, password: string) {", '  if (password.length < 8) throw new Error("weak password");', "  return fetch(\"/api/login\", { method: \"POST\", body: JSON.stringify({ email, password }) });", "}") },
  "src/lib/validators.ts": {
    text: lines(
      "export type Check = (value: string) => string | undefined;",
      "",
      'export const email: Check = (v) => (/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v) ? undefined : "邮箱格式不对");',
      'export const password: Check = (v) => (v.length >= 8 ? undefined : "密码至少 8 位");',
      "",
      "/** 依次运行，返回第一条错误。 */",
      "export const firstError = (value: string, ...checks: Check[]) => checks.map((c) => c(value)).find(Boolean);",
    ),
  },
  "src/lib/validators.test.ts": {
    text: lines(
      'import { expect, test } from "bun:test";',
      'import { email, firstError, password } from "./validators";',
      "",
      'test("email accepts a normal address", () => expect(email("a@b.co")).toBeUndefined());',
      'test("email rejects a missing domain", () => expect(email("a@b")).toBe("邮箱格式不对"));',
      'test("password needs 8 characters", () => expect(password("1234567")).toBe("密码至少 8 位"));',
      'test("firstError returns the first failing check", () => {',
      '  expect(firstError("a@b.co", email, password)).toBe("密码至少 8 位");',
      "});",
    ),
  },
  "src/lib/legacy-auth.ts": { head: lines("// 旧的登录实现，已被 validators 取代。", "export const legacyCheck = (v: string) => v.length > 0;") },
  // Session "首屏加载优化" edits this one while it runs: it starts clean and turns up in the Git panel live.
  "src/ui/transcript/tools/highlight.ts": { head: HIGHLIGHT_HEAD, text: HIGHLIGHT_HEAD },
  "public/cgs-logo.svg": { image: LOGO, head: "(image)", text: "(image)" },
};

const API_FILES: Record<string, DemoFile> = {
  "README.md": { head: lines("# payments-api", "", "支付网关与回调服务。"), text: lines("# payments-api", "", "支付网关与回调服务。") },
  "gateway/retry.go": {
    head: lines("package gateway", "", "const (", "\tmaxAttempts = 5", "\tbase        = 200 * time.Millisecond", ")", "", "func backoff(attempt int) time.Duration {", "\treturn base << attempt", "}"),
    text: lines("package gateway", "", "const (", "\tmaxAttempts = 5", "\tbase        = 200 * time.Millisecond", ")", "", "func backoff(attempt int) time.Duration {", "\td := base << attempt", "\treturn d + time.Duration(rand.Int63n(int64(d)/3)) // jitter", "}"),
  },
  "gateway/main.go": { head: lines("package gateway", "", "func Run() error { return serve() }"), text: lines("package gateway", "", "func Run() error { return serve() }") },
  "db/schema.sql": { head: lines("CREATE TABLE callback_events (", "  id BIGSERIAL PRIMARY KEY,", "  merchant_id BIGINT NOT NULL,", "  status TEXT NOT NULL", ");"), text: lines("CREATE TABLE callback_events (", "  id BIGSERIAL PRIMARY KEY,", "  merchant_id BIGINT NOT NULL,", "  status TEXT NOT NULL", ");") },
};

// Staged state the seeds above cannot say: validators.test.ts is a new file already in the index, and api.ts has a staged edit with a
// further edit on top of it, so the Git panel shows a file under both Staged Changes and Changes.
WEB_FILES["src/lib/validators.test.ts"]!.index = WEB_FILES["src/lib/validators.test.ts"]!.text;
{
  const api = WEB_FILES["src/lib/api.ts"]!;
  const staged = api.head!.replace("weak password", "password too short");
  api.index = staged;
  api.text = staged.replace('throw new Error("password too short");', 'throw new Error("password too short");\n  if (!email) throw new Error("email required");');
}

const ME = { name: "林枫", email: "linfeng@example.com" };
const ZHOU = "周岚";
const CHEN = "陈默";
const WANG = "王小北";
const HOUR = 60;
const DAY = 24 * HOUR;

const webCommits = (extra: Parameters<typeof seedCommit>[0][]) =>
  [
    ...extra,
    { subject: "chore: 升级 vite 到 7.1", author: ZHOU, ago: 1 * DAY },
    { subject: "fix(register): 注册页提交后清空表单", author: CHEN, ago: 2 * DAY },
    { subject: "feat(login): 登录表单基础校验", author: ME.name, ago: 3 * DAY },
    { subject: "docs: 补充 README 目录说明", author: WANG, ago: 5 * DAY },
    { subject: "init: cgs-web 项目骨架", author: ZHOU, ago: 9 * DAY },
  ].map((c) => seedCommit(c));

const WEB: DemoRepo = {
  user: ME,
  branch: "feature/login-validation",
  branches: {
    // Diverged: one unpushed commit of mine, two teammate commits waiting on the remote, and a third that a fetch will bring.
    "feature/login-validation": {
      upstream: "origin/feature/login-validation",
      history: webCommits([{ subject: "feat(login): 用 validators 替换内联校验", author: ME.name, ago: 2 * HOUR, pushed: false, files: [["src/pages/LoginForm.tsx", "// inline checks\n", "// validators\n"]] }]),
      incoming: [
        seedCommit({ subject: "fix(api): 登录失败时返回具体错误码", author: CHEN, ago: 30, files: [["src/lib/api.ts", "throw new Error('failed');\n", "throw new ApiError(res.status);\n"]] }),
        seedCommit({ subject: "test(login): 补登录表单用例", author: ZHOU, ago: 1 * HOUR }),
      ],
      upcoming: [seedCommit({ subject: "refactor(lib): 抽出 fetch 封装", author: WANG, ago: 2 })],
    },
    main: {
      upstream: "origin/main",
      history: webCommits([]),
      incoming: [seedCommit({ subject: "release: 1.4.0", author: ZHOU, ago: 5 * HOUR })],
      upcoming: [],
    },
    "fix/register-reset": { history: webCommits([{ subject: "wip: 注册页重置", author: ME.name, ago: 6 * DAY, pushed: false }]).slice(0, 3), incoming: [], upcoming: [] },
  },
  remotes: {
    "origin/main": { author: ZHOU, time: Date.now() - 5 * HOUR * 60_000, commits: [] },
    "origin/feature/login-validation": { author: CHEN, time: Date.now() - 30 * 60_000, commits: [] },
    "origin/feature/oauth": { author: ZHOU, time: Date.now() - 1 * DAY * 60_000, commits: webCommits([{ subject: "feat(auth): 接入 OAuth 回调", author: ZHOU, ago: 1 * DAY }]).slice(0, 3) },
    "origin/release/1.3": { author: WANG, time: Date.now() - 20 * DAY * 60_000, commits: webCommits([]).slice(2) },
  },
  files: WEB_FILES,
};

const API: DemoRepo = {
  user: ME,
  branch: "main",
  branches: {
    main: {
      upstream: "origin/main",
      history: [
        { subject: "fix(gateway): 回调超时改为指数退避", author: CHEN, ago: 8 * HOUR },
        { subject: "feat(db): callback_events 增加 status 列", author: ME.name, ago: 2 * DAY },
        { subject: "init: payments-api", author: ZHOU, ago: 12 * DAY },
      ].map((c) => seedCommit(c)),
      incoming: [],
      upcoming: [],
    },
  },
  remotes: {
    "origin/main": { author: CHEN, time: Date.now() - 8 * HOUR * 60_000, commits: [] },
    "origin/fix/callback-timeout": { author: WANG, time: Date.now() - 3 * HOUR * 60_000, commits: [seedCommit({ subject: "fix(callback): 超时后重新投递", author: WANG, ago: 3 * HOUR })] },
  },
  files: API_FILES,
};

const TREES: Record<string, DemoRepo> = { "/home/demo/cgs-web": WEB, "/home/demo/payments-api": API };

const rel = (cwd: string, path: string) => path.slice(cwd.length + 1);

const LARGE = 256 * 1024;

const watchers = new Map<string, Set<() => void>>();

const notify = (cwd: string) => {
  for (const listener of watchers.get(cwd) ?? []) listener();
};

/** What a scripted run does to a file on "disk": the working copy changes and every watcher of the workspace hears it, as a real file watcher would report. */
export function editDemoFile(cwd: string, path: string, change: (text: string) => string): void {
  const file = TREES[cwd]?.files[path];
  if (!file) return;
  file.text = change(file.text ?? "");
  notify(cwd);
}

const gits = new Map<string, ReturnType<typeof demoGit>>();
function git(cwd: string): ReturnType<typeof demoGit> {
  const repo = TREES[cwd];
  if (!repo) throw new Error("not a git repository");
  let g = gits.get(cwd);
  if (!g) gits.set(cwd, (g = demoGit(cwd, repo, () => notify(cwd))));
  return g;
}

export const demoWorkspace: WorkspaceApi = {
  watch(cwd, listener) {
    const set = watchers.get(cwd) ?? new Set();
    watchers.set(cwd, set);
    set.add(listener);
    return () => void set.delete(listener);
  },

  async list(cwd, dir) {
    const tree = TREES[cwd];
    if (!tree) return [];
    const prefix = dir === cwd ? "" : `${rel(cwd, dir)}/`;
    const seen = new Map<string, FileEntry>();
    for (const [path, file] of Object.entries(tree.files)) {
      if (!path.startsWith(prefix) || (file.text === undefined && file.head === undefined)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (file.text === undefined && slash < 0) continue; // deleted files are gone from disk
      seen.set(name, { name, path: `${cwd}/${prefix}${name}`, dir: slash >= 0 });
    }
    return [...seen.values()].sort((x, y) => Number(y.dir) - Number(x.dir) || x.name.localeCompare(y.name));
  },

  async read(cwd, path): Promise<FilePreview> {
    const file = TREES[cwd]?.files[rel(cwd, path)];
    if (!file || file.text === undefined) throw new Error("No such file");
    if (file.image) return { kind: "image", url: file.image };
    if (file.text.length > LARGE) return { kind: "large", size: file.text.length };
    return { kind: "text", text: file.text };
  },

  async gitStatus(cwd) {
    return TREES[cwd] ? git(cwd).status() : { isRepo: false, ahead: 0, behind: 0, files: [] };
  },
  async gitDiff(cwd, path, target) {
    return git(cwd).diff(path, target);
  },
  async gitStage(cwd, paths) {
    git(cwd).stage(paths);
  },
  async gitUnstage(cwd, paths) {
    git(cwd).unstage(paths);
  },
  async gitDiscard(cwd, paths) {
    git(cwd).discard(paths);
  },
  async gitCommit(cwd, message) {
    git(cwd).commit(message);
  },
  async gitFetch(cwd) {
    git(cwd).fetch();
  },
  async gitPull(cwd) {
    git(cwd).pull();
  },
  async gitPush(cwd) {
    git(cwd).push();
  },
  async gitBranches(cwd) {
    return git(cwd).branches();
  },
  async gitCheckout(cwd, branch, create) {
    git(cwd).checkout(branch, create);
  },
  async gitLog(cwd, limit) {
    return git(cwd).log(limit);
  },
  async gitCommitFiles(cwd, hash) {
    return git(cwd).commitFiles(hash);
  },
};
