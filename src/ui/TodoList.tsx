import { Check, Minus } from "lucide-react";
import type { TodoPhase } from "../core/types";
import { useT } from "../i18n";

/** Read-only: omp owns task status. The marks show progress, not editable checkboxes. */
export function TodoList({ phases }: { phases: readonly TodoPhase[] }) {
  const t = useT();
  return (
    <div className="todo-list">
      {phases.map((phase, i) => (
        <div className="todo-phase" key={i}>
          {phase.name && <div className="todo-phase-name">{phase.name}</div>}
          <ul role="list" aria-label={phase.name}>
            {phase.tasks.map(({ status, content }, j) => {
              const [title, ...lines] = content.split("\n");
              const steps = lines.map((line) => /^\s*-\s+\[([ xX])\]\s+(.+)$/.exec(line));
              const hasSteps = steps.length > 0 && steps.every((step) => step !== null);
              return <li className="todo-item" key={j} data-state={status}>
                <span className="todo-mark" aria-hidden="true">
                  {status === "completed" ? <Check className="i" /> : status === "abandoned" ? <Minus className="i" /> : null}
                </span>
                <span className="todo-text">{hasSteps ? title : content}</span>
                <small className="todo-state">{t(`tool.${status}`)}</small>
                {hasSteps && <ul className="todo-steps" role="list">
                  {steps.map((step, k) => {
                    const done = step![1] !== " ";
                    return <li key={k} data-done={done}>
                      <span className="todo-step-mark" aria-label={t(done ? "tool.completed" : "tool.pending")} role="img">{done && <Check className="i" />}</span>
                      <span>{step![2]}</span>
                    </li>;
                  })}
                </ul>}
              </li>;
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
