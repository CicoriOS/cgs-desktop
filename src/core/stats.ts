// What the dashboard shows: token and cost use per model, cache hit rate, and how full each agent's context is.
// Pure functions over omp's data; client.ts does the RPC calls and hands the results here.

/** The usage block omp stores on every assistant message. */
interface UsageBlock {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

export interface UsageMessage {
  role: string;
  provider?: string;
  model?: string;
  usage?: UsageBlock;
  /** A `task` tool result carries one entry per subagent it ran. */
  toolName?: string;
  details?: unknown;
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface ModelUsage extends Tokens {
  /** `provider/id`. */
  model: string;
  requests: number;
}

/** omp's `get_session_stats` (the fields the dashboard reads). Its totals include subagent runs and requests no message carries, such as titles. */
export interface SessionTotals {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  cost?: number;
  contextUsage?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
}

/** omp's `get_subagents` entry (the fields the dashboard reads). */
export interface SubagentSnapshot {
  id: string;
  agent: string;
  description?: string;
  status: string;
  progress?: { contextTokens?: number; contextWindow?: number };
}

export interface ContextGauge {
  /** Tokens in the context now; undefined before the agent's first reply. */
  used?: number;
  window?: number;
}

export interface SubagentGauge extends ContextGauge {
  id: string;
  agent: string;
  description?: string;
  status: string;
}

export interface StatsView {
  total: Tokens;
  /** Per model, main agent and listed subagents together, biggest cost first. */
  rows: ModelUsage[];
  /** Part of the total no listed message accounts for: titles, side questions, subagent runs omp no longer reports. Absent when it is zero. */
  other?: Tokens;
  main: ContextGauge;
  subagents: SubagentGauge[];
}

const num = (v: number | null | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Adds the assistant messages' usage to `into`, one row per `provider/model`. */
export function addUsage(into: Record<string, ModelUsage>, messages: readonly UsageMessage[]): void {
  for (const m of messages) {
    if (m.role !== "assistant" || !m.usage) continue;
    const key = m.provider && m.model ? `${m.provider}/${m.model}` : (m.model ?? "?");
    const row = (into[key] ??= { model: key, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    row.requests += 1;
    row.input += num(m.usage.input);
    row.output += num(m.usage.output);
    row.cacheRead += num(m.usage.cacheRead);
    row.cacheWrite += num(m.usage.cacheWrite);
    row.cost += num(m.usage.cost?.total);
  }
}

const LEVEL_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

/** Adds the usage of the subagents a `task` tool result reports (finished runs; omp no longer lists them live). */
export function addTaskResults(into: Record<string, ModelUsage>, messages: readonly UsageMessage[]): void {
  for (const m of messages) {
    if (m.role !== "toolResult" || m.toolName !== "task") continue;
    const results = (m.details as { results?: unknown } | undefined)?.results;
    if (!Array.isArray(results)) continue;
    for (const r of results as { usage?: UsageBlock; resolvedModel?: string; requests?: number }[]) {
      if (!r?.usage) continue;
      const key = r.resolvedModel?.replace(LEVEL_SUFFIX, "") ?? "?";
      const row = (into[key] ??= { model: key, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
      row.requests += num(r.requests);
      row.input += num(r.usage.input);
      row.output += num(r.usage.output);
      row.cacheRead += num(r.usage.cacheRead);
      row.cacheWrite += num(r.usage.cacheWrite);
      row.cost += num(r.usage.cost?.total);
    }
  }
}

/** Share of the prompt tokens that came from the cache; undefined when nothing was sent yet. */
export function cacheHitRate(t: Pick<Tokens, "input" | "cacheRead" | "cacheWrite">): number | undefined {
  const prompt = t.input + t.cacheRead + t.cacheWrite;
  return prompt > 0 ? t.cacheRead / prompt : undefined;
}

/** Fraction of the window in use, 0 to 1; undefined when either number is unknown. */
export function fill(g: ContextGauge): number | undefined {
  if (g.used === undefined || !g.window || g.window <= 0) return undefined;
  return Math.min(1, Math.max(0, g.used / g.window));
}

export function buildStats(totals: SessionTotals, perAgentMessages: readonly (readonly UsageMessage[])[], subagents: readonly SubagentSnapshot[]): StatsView {
  const byModel: Record<string, ModelUsage> = {};
  for (const messages of perAgentMessages) {
    addUsage(byModel, messages);
    addTaskResults(byModel, messages);
  }
  const rows = Object.values(byModel).sort((a, b) => b.cost - a.cost || b.input + b.output - (a.input + a.output));

  const total: Tokens = {
    input: num(totals.tokens?.input),
    output: num(totals.tokens?.output),
    cacheRead: num(totals.tokens?.cacheRead),
    cacheWrite: num(totals.tokens?.cacheWrite),
    cost: num(totals.cost),
  };
  const listed: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const r of rows) {
    listed.input += r.input;
    listed.output += r.output;
    listed.cacheRead += r.cacheRead;
    listed.cacheWrite += r.cacheWrite;
    listed.cost += r.cost;
  }
  const rest: Tokens = {
    input: Math.max(0, total.input - listed.input),
    output: Math.max(0, total.output - listed.output),
    cacheRead: Math.max(0, total.cacheRead - listed.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - listed.cacheWrite),
    cost: Math.max(0, total.cost - listed.cost),
  };
  const hasRest = rest.input + rest.output + rest.cacheRead + rest.cacheWrite > 0 || rest.cost > 1e-9;

  const cu = totals.contextUsage;
  return {
    total,
    rows,
    other: hasRest ? rest : undefined,
    main: { used: cu?.tokens ?? undefined, window: cu?.contextWindow },
    subagents: subagents.map((s) => ({
      id: s.id,
      agent: s.agent,
      description: s.description,
      status: s.status,
      used: s.progress?.contextTokens,
      window: s.progress?.contextWindow,
    })),
  };
}
