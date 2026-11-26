import { isRecord } from "./guards";
import type { TodoPhase, TodoStatus } from "./types";

const STATUSES: Record<TodoStatus, true> = { pending: true, in_progress: true, completed: true, abandoned: true };

const isStatus = (v: unknown): v is TodoStatus => typeof v === "string" && Object.hasOwn(STATUSES, v);

/** omp's phase list (`get_state.todoPhases`, or `details.phases` of a `todo` result). Entries without text are dropped; an unknown status counts as pending. */
export function parsePhases(value: unknown): TodoPhase[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((phase): TodoPhase[] => {
    if (!isRecord(phase) || !Array.isArray(phase.tasks)) return [];
    const tasks = phase.tasks.flatMap((task) =>
      isRecord(task) && typeof task.content === "string" ? [{ content: task.content, status: isStatus(task.status) ? task.status : ("pending" as const) }] : [],
    );
    return tasks.length ? [{ ...(typeof phase.name === "string" && phase.name ? { name: phase.name } : {}), tasks }] : [];
  });
}

export interface TodoSummary {
  done: number;
  total: number;
  /** The item being worked on, else the first pending one. */
  current?: string;
}

/** Abandoned items leave the count: they are neither done nor left to do. */
export function summarizeTodos(phases: readonly TodoPhase[]): TodoSummary {
  const tasks = phases.flatMap((p) => p.tasks).filter((t) => t.status !== "abandoned");
  const current = tasks.find((t) => t.status === "in_progress") ?? tasks.find((t) => t.status === "pending");
  return { done: tasks.filter((t) => t.status === "completed").length, total: tasks.length, current: current?.content };
}
