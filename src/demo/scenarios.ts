// The three conversations the demo opens with, and the scripted runs a prompt can start. Everything here is data for the same UI the
// real client draws: nothing in it is special-cased by the components.
import type { SessionEntry } from "../core/history";
import type { RawMessage } from "../core/messages";
import { assistantMessage, type Block, call, diffLines, Log, text, think, toolResultMessage } from "./log";
import { DemoSession, type Run, type Script, type SessionInit, type SubagentRec } from "./session";
import { editDemoFile, HIGHLIGHT_AFTER } from "./workspace";

const MIN = 60_000;
const WEB = "/home/demo/cgs-web";
const API = "/home/demo/payments-api";
const PROGRESS = "/home/demo/progress";

// ---------------------------------------------------------------------------------------------- shared tool results
const phases = (...tasks: [string, "pending" | "in_progress" | "completed"][]) => [{
  name: "重构登录校验",
  tasks: tasks.map(([content, status]) => ({
    content: content === "补测试并跑通"
      ? `${content}\n- [${status === "pending" ? " " : "x"}] 覆盖空表单和无效邮箱\n- [ ] 验证错误提示和焦点位置\n- [ ] 跑通登录回归测试`
      : content,
    status,
  })),
}];

const LOGIN_SRC = [
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
].join("\n");

const rows = (from: number, lines: string[]) => ({ text: lines.join("\n"), startLine: from });

// ---------------------------------------------------------------------------------------------- A: a finished, feature-rich conversation
type Seed = Omit<SessionInit, "pick" | "archive">;

function seedA(): Seed {
  const log = new Log(Date.now() - 14 * MIN);
  log.user("登录页的表单校验写得很乱，邮箱和密码的规则散在好几个地方。帮我梳理一下，抽成统一的校验模块，改完跑一下测试。");
  log.assistant([
    think("先弄清楚校验现在散在哪。我会先建一个任务清单，再用 grep 找出所有校验点，读一遍登录表单，然后再动手。"),
    text("先列个计划，再看代码。"),
    call("a-todo-1", "todo", { action: "init" }),
  ], "toolUse");
  log.result("a-todo-1", "todo", "Todo list created (4 tasks).", { phases: phases(["梳理现有校验逻辑", "in_progress"], ["抽出 validators 模块", "pending"], ["改造 LoginForm 使用它", "pending"], ["补测试并跑通", "pending"]) });
  log.assistant([
    call("a-grep-1", "grep", { pattern: "includes\\(\"@\"\\)|password\\.length|isValid", path: "src" }),
    call("a-read-1", "read", { path: "src/pages/LoginForm.tsx" }),
  ], "toolUse");
  log.result("a-grep-1", "grep", "src/pages/LoginForm.tsx:9:    if (!email.includes(\"@\")) return setError(\"邮箱格式不对\");\nsrc/pages/LoginForm.tsx:10:    if (password.length < 6) return setError(\"密码至少 6 位\");\nsrc/pages/Register.tsx:21:    if (!form.email.includes(\"@\")) return;\nsrc/lib/api.ts:44:  if (password.length < 8) throw new Error(\"weak password\");");
  log.result("a-read-1", "read", LOGIN_SRC, { displayContent: rows(1, LOGIN_SRC.split("\n")) });
  log.developer("<system-reminder>\nThe user's project uses bun. Run tests with `bun test`, not npm.\n</system-reminder>");
  log.assistant([
    think("三处规则不一致：登录页要求 6 位，API 要求 8 位，注册页压根不校验密码。统一成一个模块，规则以 API 的为准。"),
    text("发现规则不一致（登录 6 位、API 8 位、注册页没有密码校验），我以 API 为准抽一个模块。"),
    call("a-write-1", "write", {
      path: "src/lib/validators.ts",
      content: [
        "export type Check = (value: string) => string | undefined;",
        "",
        'export const email: Check = (v) => (/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v) ? undefined : "邮箱格式不对");',
        'export const password: Check = (v) => (v.length >= 8 ? undefined : "密码至少 8 位");',
        "",
        "/** 依次运行，返回第一条错误。 */",
        "export const firstError = (value: string, ...checks: Check[]) => checks.map((c) => c(value)).find(Boolean);",
      ].join("\n"),
    }),
    call("a-edit-1", "edit", { path: "src/pages/LoginForm.tsx" }),
  ], "toolUse");
  log.result("a-write-1", "write", "Wrote 7 lines to src/lib/validators.ts");
  log.result("a-edit-1", "edit", "Updated src/pages/LoginForm.tsx", {
    path: "src/pages/LoginForm.tsx",
    diff: diffLines([
      [" ", 1, 'import { useState } from "react";'],
      ["+", 2, 'import { email as checkEmail, firstError, password as checkPassword } from "../lib/validators";'],
      [" ", 3, ""],
      [" ", 8, "  function submit() {"],
      ["-", 9, '    if (!email.includes("@")) return setError("邮箱格式不对");'],
      ["-", 10, '    if (password.length < 6) return setError("密码至少 6 位");'],
      ["+", 10, "    const problem = firstError(email, checkEmail) ?? firstError(password, checkPassword);"],
      ["+", 11, "    if (problem) return setError(problem);"],
      [" ", 12, '    setError("");'],
    ]),
  });
  log.assistant([call("a-todo-2", "todo", { action: "update" }), call("a-bash-1", "bash", { command: "bun test src/lib" })], "toolUse");
  log.result("a-todo-2", "todo", "Todo list updated.", { phases: phases(["梳理现有校验逻辑", "completed"], ["抽出 validators 模块", "completed"], ["改造 LoginForm 使用它", "completed"], ["补测试并跑通", "in_progress"]) });
  log.result("a-bash-1", "bash", "bun test v1.4.4\n\nsrc/lib/validators.test.ts:\n✓ email accepts a normal address [0.21ms]\n✓ email rejects a missing domain [0.05ms]\n✓ password needs 8 characters [0.04ms]\n✗ firstError returns the first failing check\n  expected: \"邮箱格式不对\"\n  received: undefined\n\n 3 pass\n 1 fail\n", { wallTimeMs: 842 }, true);
  log.assistant([
    think("测试挂了。`firstError` 把 `value` 同时传给了所有 check，但测试里第一个 check 是故意放过的，所以结果应是第二个的错误——是测试期望写错了，不是实现的问题。"),
    text(
      "改完了，测试有一条失败，原因在测试本身。\n\n## 做了什么\n\n- 新增 `src/lib/validators.ts`：`email`、`password` 两条规则和 `firstError` 组合器\n- `LoginForm.tsx` 改用它，删掉内联的两个 `if`\n- 密码规则统一为 **8 位**（原先登录页是 6 位）\n\n## 规则对照\n\n| 位置 | 之前 | 现在 |\n|---|---|---|\n| 登录页 | 6 位 | 8 位 |\n| 注册页 | 不校验 | 8 位 |\n| API | 8 位 | 8 位（不变） |\n\n## 失败的测试\n\n`firstError returns the first failing check` 期望拿到邮箱的错误，但用例里给的是合法邮箱，所以应当返回 `undefined`。应改成：\n\n```ts\ntest(\"firstError returns the first failing check\", () => {\n  expect(firstError(\"a@b.co\", email, password)).toBe(\"密码至少 8 位\");\n});\n```\n\n要我顺手把测试改掉并给注册页接上吗？",
    ),
  ]);

  log.user("好，改掉。另外给我画一张提交时的校验流程图，我要贴到文档里。");
  log.assistant([
    text(
      "测试已按上面的写法修正。校验流程如下：\n\n```mermaid\nflowchart TD\n  A[点击登录] --> B{邮箱合法?}\n  B -- 否 --> E[显示邮箱错误]\n  B -- 是 --> C{密码 ≥ 8 位?}\n  C -- 否 --> F[显示密码错误]\n  C -- 是 --> D[调用 onSubmit]\n  E --> A\n  F --> A\n```\n\n两条规则都在 `validators.ts`，登录页和注册页以后共用同一处。",
    ),
  ]);

  log.user("顺便查一下 zod 和手写校验的体积差多少，值不值得引入。");
  log.assistant([
    think("需要真实数据：先搜一下 zod 的打包体积，再用 eval 粗算手写方案的大小。"),
    call("a-web-1", "web_search", { query: "zod bundle size gzip vs hand-written validators" }),
    call("a-eval-1", "eval", { language: "js", code: 'const src = "export const email = (v) => /^[^@\\\\s]+@[^@\\\\s]+$/.test(v);";\nconsole.log(src.length, "bytes, gzip ≈", Math.round(src.length * 0.7));' }),
  ], "toolUse");
  log.result("a-web-1", "web_search", "", {
    response: {
      answer: "zod v4 核心约 5.7 kB gzip（`zod/mini` 更小）；v3 约 13 kB。体积主要取决于用到的 schema 种类，tree-shaking 对 v4 效果明显。",
      sources: [
        { title: "Zod 4 — Packages & bundle size", url: "https://zod.dev/packages/core" },
        { title: "Bundlephobia: zod", url: "https://bundlephobia.com/package/zod" },
      ],
    },
  });
  log.result("a-eval-1", "eval", "68 bytes, gzip ≈ 48", { cells: [{ code: 'const src = "export const email = (v) => /^[^@\\\\s]+@[^@\\\\s]+$/.test(v);";\nconsole.log(src.length, "bytes, gzip ≈", Math.round(src.length * 0.7));', language: "js", output: "68 bytes, gzip ≈ 48", status: "ok", durationMs: 12 }] });
  log.assistant([
    text("结论：**现在不值得引入 zod**。\n\n- 手写的两条规则合计不到 0.2 kB，zod 4 核心约 5.7 kB gzip，相差近 30 倍\n- 目前只有两个字段，没有嵌套对象和跨字段规则，zod 的优势用不上\n- 以后表单变多、需要从 schema 推导类型时再换，`Check` 的签名很容易适配"),
  ]);

  return {
    id: "child-a", cwd: WEB, path: `${WEB.replace(/\//g, "-")}/login-validation.jsonl`, title: "重构登录页的表单校验", log,
    todos: phases(["梳理现有校验逻辑", "completed"], ["抽出 validators 模块", "completed"], ["改造 LoginForm 使用它", "completed"], ["补测试并跑通", "in_progress"]),
  };
}

// ---------------------------------------------------------------------------------------------- B: subagents, then a question for the user
const SUBS: Pick<SubagentRec, "id" | "agent" | "description" | "assignment" | "model" | "level">[] = [
  { id: "gateway-probe", agent: "explore", description: "网关与重试链路", assignment: "读 gateway/ 的回调转发与重试配置，找出可能放大尾延迟的地方。只读，不要改文件。", model: "cgs-openai/deepseek-v4.1-flash", level: "medium" },
  { id: "db-probe", agent: "explore", description: "数据库慢查询", assignment: "查 payments 库最近 24h 的慢查询日志，关注 callback_events 表。只读。", model: "cgs-openai/deepseek-v4.1-flash", level: "medium" },
  { id: "queue-probe", agent: "explore", description: "消息队列积压", assignment: "查 callback-retry 队列的积压和消费速率。", model: "cgs-openai/deepseek-v4.1-flash", level: "low" },
];

const transcriptFor = (s: (typeof SUBS)[number], output: string, command: string, result: string): RawMessage[] => [
  { role: "user", content: [{ type: "text", text: s.assignment }] },
  assistantMessage([text("先看现状。"), call(`${s.id}-c1`, "bash", { command })], "toolUse"),
  toolResultMessage(`${s.id}-c1`, "bash", result),
  assistantMessage([text(output)]),
];

function seedB(): Seed {
  const log = new Log(Date.now() - 30 * MIN);
  log.user("线上支付回调偶发超时（p99 从 300ms 涨到 4s），请并行排查网关、数据库、消息队列三个方向，给我结论。", 0);
  const results = [
    { out: "网关对回调失败做 5 次指数退避重试，且没有 jitter：下游抖动时 5 次重试会同时落在同一秒，形成重试风暴。`gateway/retry.go:58` 的 `maxAttempts=5`、`base=200ms`。", cmd: "rg -n 'maxAttempts|backoff' gateway/", res: "gateway/retry.go:58:\tmaxAttempts = 5\ngateway/retry.go:61:\tbase        = 200 * time.Millisecond\ngateway/retry.go:77:\t// TODO: jitter", code: 0 },
    { out: "`callback_events` 缺少 `(merchant_id, status)` 的联合索引，状态扫描走了全表；每天 02:00 的对账任务会把它拖到 3.8s。", cmd: "psql -c \"EXPLAIN ANALYZE SELECT * FROM callback_events WHERE merchant_id=$1 AND status='pending'\"", res: "Seq Scan on callback_events  (cost=0.00..48211.00 rows=12 width=312) (actual time=3812.4..3812.4 rows=12 loops=1)", code: 0 },
    { out: "", cmd: "curl -s http://10.0.3.17:15672/api/queues/%2F/callback-retry", res: "curl: (7) Failed to connect to 10.0.3.17 port 15672: Connection refused", code: 1 },
  ];
  const details = {
    totalDurationMs: 41_200,
    results: SUBS.map((s, i) => ({
      id: s.id, index: i, agent: s.agent, description: s.description, assignment: s.assignment, exitCode: results[i]!.code,
      output: results[i]!.out, ...(results[i]!.code ? { error: "队列管理端口 15672 拒绝连接（10.0.3.17），无法读取积压指标。" } : {}),
      durationMs: [38_000, 41_200, 12_400][i], resolvedModel: `${s.model}:${s.level}`, resolvedThinkingLevel: s.level, requests: 4 + i,
      usage: { input: 2400 + i * 300, output: 380 + i * 90, cacheRead: 9000, cacheWrite: 0, cost: { total: 0.004 + i * 0.001 } },
    })),
  };
  log.assistant([
    think("三个方向互相独立，适合并行。每个子智能体只读，给它们明确的范围和不要改文件的约束。"),
    text("拆成三个只读子智能体并行排查。"),
    call("b-task-1", "task", { tasks: SUBS.map((s) => ({ name: s.id, agent: s.agent, task: s.assignment })) }),
  ], "toolUse");
  log.result("b-task-1", "task", results.map((r, i) => `[${SUBS[i]!.id}] ${r.out || "failed"}`).join("\n"), details);
  log.assistant([
    text(
      "三个方向里两个有结论，队列那条没拿到数据。\n\n| 方向 | 结论 | 置信度 |\n|---|---|---|\n| 网关 | 重试无 jitter，5 次退避同时落点，形成重试风暴 | 高 |\n| 数据库 | `callback_events` 缺联合索引，02:00 对账任务全表扫描 3.8s | 高 |\n| 队列 | 管理端口拒绝连接，**未能确认** | — |\n\n网关和数据库两个问题叠加，正好解释“偶发”：对账任务占住数据库的时间窗里，回调重试被放大。\n\n队列那条需要你确认 `10.0.3.17:15672` 是否对外开放。",
    ),
  ]);

  const transcripts = Object.fromEntries(SUBS.map((s, i) => [s.id, transcriptFor(s, results[i]!.out || "无法连接管理端口，放弃。", results[i]!.cmd, results[i]!.res)]));
  const subagents: SubagentRec[] = SUBS.map((s, i) => ({ ...s, index: i, status: results[i]!.code ? "failed" : "completed", parentToolCallId: "b-task-1", contextTokens: 18_000 + i * 6000 }));
  return {
    id: "child-b", cwd: API, path: `${API.replace(/\//g, "-")}/callback-timeout.jsonl`, title: "排查支付回调偶发超时", log, subagents, transcripts,
    onFirstAttach: { prompt: "先别动手，你建议下一步怎么做？有拿不准的可以问我。", script: askScript },
  };
}

// ---------------------------------------------------------------------------------------------- C: a run in progress when it is opened
function seedC(): Seed {
  const log = new Log(Date.now() - 80 * MIN);
  log.user("首页首屏 LCP 3.8s，帮我看看打包体积，哪些是大头？", 0);
  log.assistant([call("c-bash-1", "bash", { command: "bun --bun run build 2>&1 | tail -12" })], "toolUse");
  log.result("c-bash-1", "bash", "dist/assets/index-DqWx1u.js        412.37 kB │ gzip: 131.20 kB\ndist/assets/mermaid-Bk3a9.js    1,284.10 kB │ gzip: 349.88 kB\ndist/assets/highlight-C0pRq.js    968.52 kB │ gzip: 301.07 kB\ndist/assets/index-Hs82kd.css       38.41 kB │ gzip:   8.30 kB\n✓ built in 6.91s", { wallTimeMs: 7120 });
  log.assistant([
    text("大头是两个**首屏用不到**的库：\n\n| 产物 | 体积 | gzip |\n|---|---|---|\n| `mermaid` | 1.28 MB | 350 kB |\n| `highlight.js` | 0.97 MB | 301 kB |\n| 应用本体 | 412 kB | 131 kB |\n\n这两项合计占首屏 JS 的约八成，但只有对话里出现图表或代码块才会用到。改成**按需动态加载**即可。"),
  ]);
  return {
    id: "child-c", cwd: WEB, path: `${WEB.replace(/\//g, "-")}/lcp-bundle.jsonl`, title: "首屏加载优化", log,
    // Opened from the sidebar, this one shows ADR 0047's lock: a phone is using it, and a click on the composer takes over.
    controller: { kind: "remote", name: "iPhone 15 Pro" },
    onFirstAttach: { prompt: "好，把 mermaid 和 highlight.js 改成按需加载，再构建一次对比体积。", script: optimizeScript },
  };
}

// ---------------------------------------------------------------------------------------------- D/E/F: progress display
const PASS_LINES = [
  "PASS email accepts a normal address [0.21ms]",
  "PASS email rejects a missing domain [0.05ms]",
  "PASS password needs 8 characters [0.04ms]",
];
const FAIL_LINES = ['FAIL firstError returns the first failing check', '  expected: "邮箱格式不对"', "  received: undefined", "", " 4 pass", " 1 fail"];

/** Full previews of one `bun test` run, as bash sends them: each replaces the previous one. */
function streamedTestRun(): string[] {
  const percents = [3, 11, 18, 26, 37, 37, 44, 52, 61, 73, 84, 92, 100];
  return percents.map((percent, i) => {
    const shown = PASS_LINES.slice(0, Math.min(PASS_LINES.length, Math.floor(i / 2) + 1));
    const failed = i === percents.length - 1 ? ["", ...FAIL_LINES] : [];
    return ["bun test v1.4.4 (demo)", "", "src/lib/validators.test.ts:", `  downloading fixtures  ${percent}%`, ...(shown.length ? ["", ...shown] : []), ...failed].join("\n");
  });
}

function seedD(): Seed {
  const log = new Log(Date.now() - 100 * MIN);
  log.user("校验模块抽好了，测试写了吗？");
  log.assistant([text("写好了，`src/lib/validators.test.ts` 里有 4 条用例。要现在跑吗？")]);
  return {
    id: "child-d", cwd: PROGRESS, path: `${PROGRESS.replace(/\//g, "-")}/progress-stream.jsonl`, title: "演示：工具实时输出", log,
    onFirstAttach: { prompt: "跑一遍，我盯着输出看。", script: streamScript },
  };
}

function seedE(): Seed {
  const log = new Log(Date.now() - 110 * MIN);
  log.user("上下文是不是快满了？刚才服务端还报了一次过载。");
  log.assistant([text("对，上下文到了阈值；我可以压缩一下，再处理过载时的重试和回退。")]);
  return {
    id: "child-e", cwd: PROGRESS, path: `${PROGRESS.replace(/\//g, "-")}/progress-compact.jsonl`, title: "演示：压缩与重试", log,
    onFirstAttach: { prompt: "压缩吧，顺便让我看看重试和回退的状态。", script: compactionScript },
  };
}

function seedF(): Seed {
  const log = new Log(Date.now() - 120 * MIN);
  log.user("扩展现在都上报了些什么？");
  log.assistant([text("有构建状态、CI 摘要，还有一个目标模式；我让它们显示出来。")]);
  return {
    id: "child-f", cwd: PROGRESS, path: `${PROGRESS.replace(/\//g, "-")}/progress-widgets.jsonl`, title: "演示：状态与小部件", log,
    onFirstAttach: { prompt: "显示一下当前的状态和小部件。", script: statusScript },
  };
}

// ---------------------------------------------------------------------------------------------- scripted runs
async function askScript(r: Run): Promise<void> {
  await r.assistant([
    think("现状：重试风暴和缺索引两件事都能做，但改动风险不同。队列那条数据没拿到。这是真有分歧的决策，应该问用户，而不是替他选。"),
    text("有两条路风险不同，我想先确认你的取向。"),
    call("ask-1", "ask", { questions: [{ id: "strategy", question: "处理策略" }] }),
  ]);
  const reply = await r.ask("ask-1", [
    "<form>",
    "<p>网关重试和缺失索引都要处理，先动哪个？</p>",
    '<fieldset><legend>处理策略</legend>',
    '<label><input type="radio" name="strategy" value="index" checked> 先加联合索引（只读变更，几乎无风险，对账任务立刻变快）</label>',
    '<label><input type="radio" name="strategy" value="jitter"> 先给网关重试加 jitter（改动在热路径，需灰度）</label>',
    '<label><input type="radio" name="strategy" value="both"> 两个一起做，分两次发布</label>',
    "</fieldset>",
    '<label>补充说明 <textarea name="note" placeholder="可选"></textarea></label>',
    "</form>",
  ].join("\n"));
  const data = (typeof reply.data === "object" && reply.data !== null ? reply.data : {}) as Record<string, string>;
  const cancelled = reply.cancelled === true || !data.strategy;
  const label = { index: "先加联合索引", jitter: "先给网关重试加 jitter", both: "两个一起做，分两次发布" }[data.strategy ?? ""] ?? data.strategy ?? "";
  await r.tools([{ id: "ask-1", name: "ask", args: {}, ms: 0, output: cancelled ? "User cancelled the form." : `strategy: ${label}`, details: { answers: [{ name: "strategy", question: "处理策略", answer: cancelled ? "" : label }, ...(data.note ? [{ name: "note", question: "补充说明", answer: data.note }] : [])] }, isError: false }]);
  await r.assistant([
    text(cancelled ? "好，我先不动，等你想好再说。" : `收到，按「${label}」来：\n\n1. ${data.strategy === "jitter" ? "网关 `retry.go` 的退避加 ±30% jitter，灰度 5% 流量观察 p99" : "对 `callback_events(merchant_id, status)` 建联合索引（`CREATE INDEX CONCURRENTLY`，不锁表）"}\n2. 观察一个对账周期（02:00）确认尾延迟回落\n3. 再处理另一项\n\n${data.note ? `你的补充「${data.note}」我会一并考虑。\n\n` : ""}需要我现在生成变更脚本吗？`),
  ]);
}

async function optimizeScript(r: Run): Promise<void> {
  await r.assistant([
    think("两个库都是在渲染时才用到：`Markdown.tsx` 里 mermaid 已经是动态 import，highlight.js 是静态引入。先确认引用点，再改成按需加载，最后构建对比。"),
    text("先看 highlight.js 在哪里被引入。"),
    call("c-grep-2", "grep", { pattern: "highlight\\.js", path: "src" }),
  ]);
  await r.tools([{ id: "c-grep-2", name: "grep", args: { pattern: "highlight\\.js", path: "src" }, ms: 700, output: "src/ui/transcript/tools/highlight.ts:1:import hljs from \"highlight.js/lib/core\";\nsrc/ui/transcript/tools/highlight.ts:2:import bash from \"highlight.js/lib/languages/bash\";" }]);
  await r.assistant([
    text("语言包是静态引入的，改成首次用到时才加载。"),
    call("c-edit-2", "edit", { path: "src/ui/transcript/tools/highlight.ts" }),
  ]);
  await r.tools([{
    id: "c-edit-2", name: "edit", args: { path: "src/ui/transcript/tools/highlight.ts" }, ms: 900, output: "Updated src/ui/transcript/tools/highlight.ts",
    effect: () => editDemoFile(r.session.cwd, "src/ui/transcript/tools/highlight.ts", () => HIGHLIGHT_AFTER),
    details: { path: "src/ui/transcript/tools/highlight.ts", diff: diffLines([[" ", 1, 'import hljs from "highlight.js/lib/core";'], ["-", 2, 'import bash from "highlight.js/lib/languages/bash";'], ["-", 3, 'hljs.registerLanguage("bash", bash);'], ["+", 2, "const loaders = { bash: () => import(\"highlight.js/lib/languages/bash\") };"], ["+", 3, "export const ensureLanguage = async (name: keyof typeof loaders) =>"], ["+", 4, "  hljs.getLanguage(name) ?? hljs.registerLanguage(name, (await loaders[name]()).default);"]]) },
  }]);
  await r.assistant([text("现在重新构建，对比体积。"), call("c-bash-2", "bash", { command: "bun --bun run build 2>&1 | tail -12" })]);
  await r.tools([{ id: "c-bash-2", name: "bash", args: { command: "bun --bun run build 2>&1 | tail -12" }, ms: 9000, output: "dist/assets/index-Lm40sQ.js        214.06 kB │ gzip:  68.71 kB\ndist/assets/mermaid-Bk3a9.js    1,284.10 kB │ gzip: 349.88 kB  (async)\ndist/assets/highlight-X1c2e.js    962.10 kB │ gzip: 299.40 kB  (async)\n✓ built in 6.55s", details: { wallTimeMs: 8950 } }]);
  await r.assistant([
    text("构建完成，首屏 JS 大幅下降：\n\n| 产物 | 之前 gzip | 之后 gzip |\n|---|---|---|\n| 首屏入口 | 131.2 kB | **68.7 kB** |\n| mermaid | 349.9 kB（首屏） | 349.9 kB（按需） |\n| highlight.js | 301.1 kB（首屏） | 299.4 kB（按需） |\n\n首屏 JS 减少约 **48%**。mermaid 和语言包只在首次出现图表或代码块时下载。建议用 Lighthouse 再测一次 LCP。"),
  ]);
}

async function streamScript(r: Run): Promise<void> {
  await r.assistant([
    think("先跑测试，输出会实时出现；同时留意待办提醒和 IRC 消息。"),
    text("开始跑 `validators.test.ts`，输出会实时出现在卡片里。"),
    call("d-bash-1", "bash", { command: "bun test src/lib/validators.test.ts 2>&1" }),
  ]);
  const previews = streamedTestRun();
  const running = r.tools([{
    id: "d-bash-1", name: "bash", args: { command: "bun test src/lib/validators.test.ts 2>&1" }, ms: 6500, stream: previews,
    output: previews.at(-1) ?? "", details: { wallTimeMs: 6400 },
  }]);
  await r.sleep(1100);
  r.session.emit({ type: "irc_message", message: { role: "custom", customType: "irc", content: [{ type: "text", text: "mika: 构建机 3 号空着，这条跑完可以直接上 CI。" }] } });
  await r.sleep(2400);
  r.session.emit({ type: "todo_reminder", todos: [{ content: "补测试并跑通", status: "in_progress" }], attempt: 1, maxAttempts: 3 });
  r.session.emit({ type: "message_end", messageId: "d-todo-reminder", message: { role: "developer", content: [{ type: "text", text: "<system-reminder>\nYou stopped with 1 incomplete todo item(s): 补测试并跑通.\n(Reminder 1/3)\n</system-reminder>" }] } });
  await running;
  await r.assistant([text("三条通过、一条失败：失败的是测试自己的期望值写错了（给的是合法邮箱却期望报错），实现没问题。要我改测试吗？")]);
}

async function compactionScript(r: Run): Promise<void> {
  const s = r.session;
  await r.assistant([text("先预热缓存，然后压缩上下文；如果服务端过载，会自动重试并回退模型。")]);
  s.emit({ type: "cache_warming_start", phase: "idle", method: "prewarm", provider: "cgs-claude", model: "claude-sonnet-5-5" });
  await r.sleep(1600);
  s.emit({ type: "cache_warming_end", phase: "idle", method: "prewarm", provider: "cgs-claude", model: "claude-sonnet-5-5", outcome: "hit" });
  s.emit({ type: "auto_compaction_start", reason: "threshold", action: "remote" });
  await r.sleep(2800);
  s.emit({ type: "auto_compaction_end", action: "remote", aborted: false, willRetry: false, result: { summary: "…", firstKeptEntryId: "e12", tokensBefore: 136_400 } });
  s.emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 5000, errorMessage: "529 overloaded: the provider is at capacity" });
  await r.sleep(1400);
  s.emit({ type: "retry_fallback_applied", from: "cgs-claude/claude-sonnet-5-5", to: "cgs-openai/gpt-5.5", role: "default", reason: "provider overloaded" });
  await r.sleep(3600);
  s.emit({ type: "retry_fallback_succeeded", model: "cgs-openai/gpt-5.5", role: "default" });
  s.emit({ type: "auto_retry_end", success: true, attempt: 1 });
  await r.assistant([text("压缩完成（136k → 31k tokens）。原模型过载，回退到 GPT-5.5 后这次重试成功了。")]);
}

async function statusScript(r: Run): Promise<void> {
  const s = r.session;
  // Let the page finish attaching: frames sent while it hydrates are dropped, and a real extension reports later.
  await r.sleep(700);
  s.emit({ type: "goal_updated", goal: { id: "goal-1", objective: "把登录校验整理成一个模块并跑通测试", status: "active", tokensUsed: 18_400, timeUsedSeconds: 420 } });
  s.emit({ type: "extension_ui_request", id: "status-build", method: "setStatus", statusKey: "build", statusText: "构建缓存命中 (2.1s)" });
  s.emit({ type: "extension_ui_request", id: "status-lint", method: "setStatus", statusKey: "lint", statusText: "0 处警告" });
  s.emit({ type: "extension_ui_request", id: "widget-above", method: "setWidget", widgetKey: "note", widgetLines: ["演示后端：不连接真实模型，状态与小部件来自扩展帧。"], widgetPlacement: "belowEditor" });
  s.emit({ type: "extension_ui_request", id: "widget-below", method: "setWidget", widgetKey: "ci", widgetLines: ["CI · build #2481 运行中", "单元测试 96/128 · 覆盖率 91%"], widgetPlacement: "aboveEditor" });
  s.emit({ type: "config_warnings_changed" });
  await r.assistant([think("这些状态跑完也留着，用来展示扩展的常驻信息。"), text("扩展把构建状态和 CI 摘要放在输入框两侧；配置里有一条警告，可以点掉。")]);
}

async function subagentScript(r: Run): Promise<void> {
  await r.assistant([
    think("两个独立的检查，并行最快。"),
    text("拆成两个子智能体并行："),
    call("run-task", "task", { tasks: [{ name: "scan-a", agent: "explore", task: "统计 src 下各目录的文件数和总行数" }, { name: "scan-b", agent: "explore", task: "找出 src 中所有 TODO 和 FIXME" }] }),
  ]);
  const specs: SubagentRec[] = [
    { id: "scan-a", agent: "explore", index: 0, description: "统计目录规模", assignment: "统计 src 下各目录的文件数和总行数", status: "running", level: "low", model: "cgs-openai/deepseek-v4.1-flash", parentToolCallId: "run-task", contextTokens: 3000 },
    { id: "scan-b", agent: "explore", index: 1, description: "扫描 TODO/FIXME", assignment: "找出 src 中所有 TODO 和 FIXME", status: "running", level: "low", model: "cgs-openai/deepseek-v4.1-flash", parentToolCallId: "run-task", contextTokens: 3000 },
  ];
  for (const s of specs) {
    r.startSubagent(s);
    r.progressSubagent(s.id, { role: "user", content: [{ type: "text", text: s.assignment }] }, 3000);
  }
  const outputs = ["src/ui 41 文件 / 6.2k 行；src/core 14 文件 / 2.9k 行；src/connect 9 文件 / 1.6k 行。", "共 3 处：`Sidebar.tsx` 1 处 TODO，`client.ts` 1 处 FIXME，`connection.ts` 1 处 TODO。"];
  const watch = async () => {
    for (const [step, line] of ["开始扫描。", "已读到一半。", "正在汇总。"].entries()) {
      await r.sleep(1300);
      for (const s of specs) r.progressSubagent(s.id, { role: "assistant", content: [{ type: "text", text: `${s.description}：${line}` }], stopReason: "stop" }, 6000 + step * 4000);
    }
    await r.sleep(800);
    specs.forEach((s, i) => (r.progressSubagent(s.id, { role: "assistant", content: [{ type: "text", text: outputs[i]! }], stopReason: "stop" }, 17_000), r.endSubagent(s.id, "completed")));
  };
  await Promise.all([
    watch(),
    r.tools([{
      id: "run-task", name: "task", args: {}, ms: 5600, output: outputs.map((o, i) => `[${specs[i]!.id}] ${o}`).join("\n"),
      details: { totalDurationMs: 5600, results: specs.map((s, i) => ({ id: s.id, index: i, agent: s.agent, description: s.description, assignment: s.assignment, exitCode: 0, output: outputs[i], durationMs: 5200, resolvedModel: `${s.model}:low`, resolvedThinkingLevel: "low" })) },
    }]),
  ]);
  await r.assistant([text(`两个检查都完成了：\n\n- **规模**：${outputs[0]}\n- **待办**：${outputs[1]}`)]);
}

async function editScript(r: Run): Promise<void> {
  await r.assistant([
    think("先读目标文件，确认上下文再改。"),
    text("先读一下相关文件。"),
    call("run-read", "read", { path: "src/pages/LoginForm.tsx" }),
  ]);
  await r.tools([{ id: "run-read", name: "read", args: { path: "src/pages/LoginForm.tsx" }, ms: 500, output: LOGIN_SRC, details: { displayContent: rows(1, LOGIN_SRC.split("\n")) } }]);
  await r.assistant([text("在提交前去掉首尾空白，避免带空格的邮箱被拒。"), call("run-edit", "edit", { path: "src/pages/LoginForm.tsx" })]);
  await r.tools([{
    id: "run-edit", name: "edit", args: { path: "src/pages/LoginForm.tsx" }, ms: 700, output: "Updated src/pages/LoginForm.tsx",
    effect: () => editDemoFile(r.session.cwd, "src/pages/LoginForm.tsx", (text) => (text.includes("rawEmail") ? text : text.replace("function submit() {\n", "function submit() {\n    const email = rawEmail.trim();\n"))),
    details: { path: "src/pages/LoginForm.tsx", diff: diffLines([[" ", 8, "  function submit() {"], ["+", 9, "    const email = rawEmail.trim();"], [" ", 10, '    if (!email.includes("@")) return setError("邮箱格式不对");'], [" ", 11, '    if (password.length < 6) return setError("密码至少 6 位");']]) },
  }]);
  await r.assistant([text("改好了：提交前先 `trim()` 邮箱。需要我补一条对应的测试吗？")]);
}

const exploreScript = (prompt: string): Script => async (r) => {
  await r.assistant([
    think(`用户在问：「${prompt.slice(0, 40)}」。先看项目里有没有相关代码，再回答。`),
    text("我先在项目里找一下相关内容。"),
    call("run-grep", "grep", { pattern: prompt.slice(0, 12), path: "src" }),
  ]);
  await r.tools([{ id: "run-grep", name: "grep", args: { pattern: prompt.slice(0, 12), path: "src" }, ms: 900, output: "（没有匹配的文件）" }]);
  const blocks: Block[] = [
    text(`这是演示后端的示例回复，没有接入真实模型。\n\n你说的是：> ${prompt}\n\n可以试试这些输入，看看不同的界面：\n\n- 「**并行**排查两个问题」：启动子智能体，看右下角的子智能体面板\n- 「**问我**怎么选」：弹出 ask 表单\n- 「**修复**登录页的 bug」：读文件、改文件、看 diff\n- 在运行中再发一条消息：进入队列\n- \`/compact\`：压缩上下文`),
  ];
  await r.assistant(blocks);
};

export function pick(prompt: string): Script {
  if (/并行|子智能体|子代理|subagent/i.test(prompt)) return subagentScript;
  if (/问我|提问|ask/i.test(prompt)) return askScript;
  if (/改|修|重构|实现|edit|fix/i.test(prompt)) return editScript;
  return exploreScript(prompt);
}

let saved = 0;

/** A session wired to the demo's scripts. `archive` receives the session a fork leaves behind. */
export function createSession(seed: Seed, archive: (s: DemoSession) => void): DemoSession {
  return new DemoSession({
    ...seed,
    pick,
    archive: (entries: SessionEntry[], title, cwd, path, at) => {
      const log = new Log(at);
      log.entries = entries;
      archive(createSession({ id: `child-saved-${++saved}`, cwd, path, title, log }, archive));
    },
  });
}

/** The demo's conversations; the progress ones sit in their own workspace so the original three open as before. */
export const demoSessions = (archive: (s: DemoSession) => void): DemoSession[] => [seedA(), seedB(), seedC(), seedD(), seedE(), seedF()].map((seed) => createSession(seed, archive));
