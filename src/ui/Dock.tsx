import { summarizeTodos } from "../core/todos";
import { isFinished } from "../core/subagents";
import type { RingState, SubagentInfo, SubagentStatus } from "../core/types";
import { useT } from "../i18n";
import { useClientState } from "./client-context";
import { LevelDot, Ring } from "./ring";

const MARK = { pending: "☐", in_progress: "◐", completed: "☑", abandoned: "⊘" } as const;
const SUB_RING: Record<SubagentStatus, RingState> = { pending: "idle", running: "work", completed: "ok", failed: "fail", aborted: "stop" };
const SUB_STATUS = { pending: "tool.pending", running: "tool.running", completed: "tool.completed", failed: "tool.err", aborted: "tool.cancelled" } as const;

function TodoCard() {
  const t = useT();
  const phases = useClientState((s) => s.todos);
  const { done, total, current } = summarizeTodos(phases);
  if (!total) return null;
  return (
    <details className="dock-card todo">
      <summary>
        <span className="dock-title">{t("dock.todo")}</span>
        <span className="dock-count">{t("dock.todoCount", { done, total })}</span>
        {current && <span className="dock-sum">{current}</span>}
      </summary>
      <div className="dock-body">
        {phases.map((phase, i) => (
          <div key={i}>
            {phase.name && <div className="lab">{phase.name}</div>}
            <ul className="tool-checklist">
              {phase.tasks.map((item, j) => (
                <li key={j} data-state={item.status}>
                  <span aria-hidden="true">{MARK[item.status]}</span> <span>{item.content}</span> <small>{t(`tool.${item.status}`)}</small>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}

function SubagentRow({ info, onOpen }: { info: SubagentInfo; onOpen: (id: string) => void }) {
  const t = useT();
  const name = info.description ?? info.id;
  return (
    <button type="button" className="sub-row" data-status={info.status} title={t("dock.open", { name })} aria-label={t("dock.open", { name })} onClick={() => onOpen(info.id)}>
      <LevelDot level={info.level} />
      <span className="sub-name">{name}</span>
      {name !== info.agent && <small className="sub-agent">{info.agent}</small>}
      <span className="sub-state">
        <Ring small state={SUB_RING[info.status]} level={info.level ?? "auto"} />
        <small>{t(SUB_STATUS[info.status])}</small>
      </span>
    </button>
  );
}

function SubagentCard({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useT();
  const subagents = useClientState((s) => s.subagents);
  if (!subagents.length) return null;
  const live = subagents.filter((s) => !isFinished(s.status));
  const finished = subagents.filter((s) => isFinished(s.status));
  return (
    <div className="dock-card subs">
      <div className="dock-head">
        <span className="dock-title">{t("dock.subagents")}</span>
        {live.length > 0 && <span className="dock-count">{t("dock.running", { n: live.length })}</span>}
      </div>
      {live.map((s) => (
        <SubagentRow key={s.id} info={s} onOpen={onOpen} />
      ))}
      {finished.length > 0 && (
        <details className="sub-finished" open={live.length === 0}>
          <summary>{t("dock.finished", { n: finished.length })}</summary>
          {finished.map((s) => (
            <SubagentRow key={s.id} info={s} onOpen={onOpen} />
          ))}
        </details>
      )}
    </div>
  );
}

/** The todo list and the subagents above the message box (ADR 0037): todo first, subagents below it. */
export function Dock({ onOpenSubagent }: { onOpenSubagent: (id: string) => void }) {
  return (
    <div id="dock">
      <TodoCard />
      <SubagentCard onOpen={onOpenSubagent} />
    </div>
  );
}
