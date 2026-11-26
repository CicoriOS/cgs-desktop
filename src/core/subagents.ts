import { isRecord } from "./guards";
import type { SubagentInfo, SubagentStatus, ToolCall } from "./types";

const STATUSES: Record<SubagentStatus, true> = { pending: true, running: true, completed: true, failed: true, aborted: true };
const FINISHED: Record<SubagentStatus, boolean> = { pending: false, running: false, completed: true, failed: true, aborted: true };
/** The client keeps this many; the oldest finished ones go first. */
const MAX_SUBAGENTS = 50;

export const isFinished = (status: SubagentStatus): boolean => FINISHED[status];

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function statusOf(v: unknown): SubagentStatus | undefined {
  if (v === "started") return "running";
  return typeof v === "string" && Object.hasOwn(STATUSES, v) ? (v as SubagentStatus) : undefined;
}

/** One subagent as omp reports it in a registry snapshot, a progress or lifecycle payload, or a `task` result entry. Fields it lacks stay undefined. */
export function subagentFrom(entry: unknown, outer: Record<string, unknown> = {}): SubagentInfo | undefined {
  if (!isRecord(entry)) return undefined;
  const progress = isRecord(entry.progress) ? entry.progress : undefined;
  const id = text(entry.id) ?? text(progress?.id);
  const agent = text(entry.agent) ?? text(outer.agent);
  if (!id || !agent) return undefined;
  const index = typeof entry.index === "number" ? entry.index : typeof outer.index === "number" ? outer.index : 0;
  let status = statusOf(entry.status) ?? statusOf(progress?.status);
  if (!status && typeof entry.exitCode === "number") status = entry.aborted === true ? "aborted" : entry.exitCode === 0 ? "completed" : "failed";
  return {
    id,
    index,
    agent,
    status: status ?? "running",
    ...optional("description", text(entry.description) ?? text(progress?.description)),
    ...optional("task", text(entry.assignment) ?? text(entry.task) ?? text(outer.assignment) ?? text(outer.task)),
    ...optional("level", text(entry.resolvedThinkingLevel) ?? text(progress?.resolvedThinkingLevel)),
    ...optional("model", text(entry.resolvedModel) ?? text(progress?.resolvedModel)),
    ...optional("parentToolCallId", text(entry.parentToolCallId) ?? text(outer.parentToolCallId)),
  };
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: string });
}

/** `get_subagents` data. */
export function subagentsFromSnapshot(data: unknown): SubagentInfo[] {
  const list = isRecord(data) && Array.isArray(data.subagents) ? data.subagents : [];
  return list.flatMap((s) => subagentFrom(s) ?? []);
}

/** `subagent_lifecycle` and `subagent_progress` frames: the entry is the payload (lifecycle) or its `progress` (progress), the payload supplies the rest. */
export function subagentFromFrame(frame: { type: string; payload?: unknown }): SubagentInfo | undefined {
  if (!isRecord(frame.payload)) return undefined;
  const payload = frame.payload;
  return frame.type === "subagent_progress" ? subagentFrom(payload.progress, payload) : subagentFrom(payload);
}

/** The entries of a `task` tool result (finished runs), or its running progress while no result exists. */
export function subagentsFromTaskDetails(details: unknown, parentToolCallId: string): SubagentInfo[] {
  if (!isRecord(details)) return [];
  const entries = Array.isArray(details.results) && details.results.length ? details.results : Array.isArray(details.progress) ? details.progress : [];
  return entries.flatMap((e) => subagentFrom(e, { parentToolCallId }) ?? []);
}

/** What the `task` call that started `id` sent and got back: its task text (flat or batch arguments) and the run's output or error. */
export function taskCallOf(call: ToolCall | undefined, id: string): { task?: string; output?: string } {
  if (!call) return {};
  const results = isRecord(call.result?.details) && Array.isArray(call.result.details.results) ? call.result.details.results : [];
  const result = results.find((r) => isRecord(r) && r.id === id);
  const batch = Array.isArray(call.args.tasks) ? call.args.tasks : [];
  const item = batch.find((t) => isRecord(t) && t.name === id) ?? (batch.length === 1 ? batch[0] : undefined);
  const argTask = isRecord(item) ? text(item.task) : text(call.args.task);
  const output = isRecord(result) ? [result.output, result.error].filter((v): v is string => typeof v === "string" && v !== "").join("\n") : "";
  return { task: (isRecord(result) ? text(result.assignment) : undefined) ?? argTask, ...(output ? { output } : {}) };
}

/** `list` after reading omp's live roster: an entry that is neither finished nor on the roster is not running any more (omp restarted, or its last report was lost). */
export function reconcileRoster(list: readonly SubagentInfo[], roster: readonly SubagentInfo[]): SubagentInfo[] {
  const live = new Set(roster.map((s) => s.id));
  if (!list.some((s) => !isFinished(s.status) && !live.has(s.id))) return list as SubagentInfo[];
  return list.map((s) => (!isFinished(s.status) && !live.has(s.id) ? { ...s, status: "aborted" } : s));
}

/**
 * Folds `incoming` into `list` by id. A finished subagent does not go back to running from a late progress report; a lifecycle
 * `started` (`restart`) does, since an id can be reused by a new run.
 */
export function mergeSubagents(list: readonly SubagentInfo[], incoming: readonly SubagentInfo[], restart = false): SubagentInfo[] {
  if (!incoming.length) return list as SubagentInfo[];
  const next = list.slice();
  for (const entry of incoming) {
    const i = next.findIndex((s) => s.id === entry.id);
    const old = next[i];
    if (!old) {
      next.push(entry);
      continue;
    }
    const keep = isFinished(old.status) && !isFinished(entry.status) && !restart;
    next[i] = { ...old, ...entry, status: keep ? old.status : entry.status, index: entry.index || old.index };
    for (const key of ["description", "task", "level", "model", "parentToolCallId"] as const) next[i]![key] ??= old[key];
  }
  if (next.length <= MAX_SUBAGENTS) return next;
  const drop = next.length - MAX_SUBAGENTS;
  const dropped = new Set(next.filter((s) => isFinished(s.status)).slice(0, drop));
  return next.filter((s) => !dropped.has(s));
}
