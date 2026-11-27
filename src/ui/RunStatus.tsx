import { useEffect, useState } from "react";
import type { RunProgress } from "../core/types";
import type { MessageKey } from "../i18n";
import { useT } from "../i18n";
import { useClientState } from "./client-context";
import { CloseIcon } from "./icons";
import { Ring } from "./ring";

const COMPACTION_REASONS: Record<string, MessageKey> = {
  threshold: "run.compaction.reason.threshold",
  overflow: "run.compaction.reason.overflow",
  idle: "run.compaction.reason.idle",
  incomplete: "run.compaction.reason.incomplete",
};
/** The `/compact <mode>` subcommands the client knows a name for; anything else is shown as omp sent it. */
const COMPACT_MODES: Record<string, MessageKey> = {
  snapcompact: "compact.mode.snapcompact",
  soft: "compact.mode.soft",
  remote: "compact.mode.remote",
  handoff: "compact.mode.handoff",
};

type RetryState = NonNullable<RunProgress["retry"]>;

/** The delay in an `auto_retry_start` counts down while the strip is visible. */
function RetryClock({ retry }: { retry: RetryState }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!retry.delayMs) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [retry.startedAt, retry.delayMs]);
  const left = retry.delayMs ? Math.max(0, Math.ceil((retry.startedAt + retry.delayMs - now) / 1000)) : 0;
  return <span className="run-count">{left > 0 ? t("run.retry.countdown", { n: left }) : t("run.retry.now")}</span>;
}

/**
 * One strip above the message box for what the agent reports about itself: compaction, retries, a fallback model,
 * cache warming, extension statuses, the goal and configuration warnings.
 */
export function RunStatus() {
  const t = useT();
  const progress = useClientState((s) => s.progress);
  const level = useClientState((s) => s.thinking.resolved);
  /** Warnings has no text and no end frame: a new frame re-shows the line after it was dismissed. */
  const [dismissed, setDismissed] = useState(0);
  const { compaction, retry, fallback, warming, goal, warnings } = progress;
  // A new session counts warnings from zero again; the old dismissal must not hide the new session's first one.
  useEffect(() => {
    if (warnings === 0) setDismissed(0);
  }, [warnings]);
  const statusText = Object.values(progress.statuses).join(" · ");
  const showWarnings = warnings > 0 && dismissed !== warnings;
  if (!compaction && !retry && !fallback && !warming && !goal && !statusText && !showWarnings) return null;

  const reasonKey = compaction?.kind === "auto" && compaction.reason ? COMPACTION_REASONS[compaction.reason] : undefined;
  const modeKey = compaction?.kind === "manual" && compaction.mode ? COMPACT_MODES[compaction.mode] : undefined;
  const compactionLabel = compaction
    ? [
        t(compaction.kind === "auto" ? "run.compaction.auto" : "run.compaction.manual"),
        reasonKey ? t(reasonKey) : compaction.kind === "auto" ? compaction.reason : undefined,
        modeKey ? t(modeKey) : compaction.kind === "manual" ? compaction.mode : undefined,
      ].filter(Boolean).join(" · ")
    : undefined;

  return (
    <div className="run-strip">
      <div className="run-card" role="status" aria-live="polite">
        {compactionLabel && (
          <div className="run-row" data-kind="compaction">
            <Ring small state="work" level={level} />
            <span className="run-text">{compactionLabel}</span>
          </div>
        )}
        {retry && (
          <div className="run-row" data-kind="retry">
            <Ring small state="work" level={level} />
            <b>{t("run.retry", { attempt: retry.attempt, max: retry.maxAttempts })}</b>
            <RetryClock retry={retry} />
            {retry.reason && <span className="run-reason" title={retry.reason}>{retry.reason}</span>}
          </div>
        )}
        {fallback && (
          <div className="run-row" data-kind="fallback" title={fallback.from ? t("run.fallback.from", { from: fallback.from }) : undefined}>
            <span className="run-text">{fallback.ok ? t("run.fallback.ok", { model: fallback.to }) : t("run.fallback", { model: fallback.to })}</span>
          </div>
        )}
        {warming && (
          <div className="run-row" data-kind="warming">
            <Ring small state="work" level={level} />
            <span className="run-text">{t("run.warming")}</span>
          </div>
        )}
        {goal && (
          <div className="run-row" data-kind="goal">
            <span className="run-text" title={goal.objective}>{t("run.goal", { goal: goal.objective })}</span>
          </div>
        )}
        {statusText && (
          <div className="run-row run-statuses" data-kind="status">
            <span className="run-text">{statusText}</span>
          </div>
        )}
        {showWarnings && (
          <div className="run-row warn" data-kind="warnings">
            <span className="run-text">{t("run.configWarnings")}</span>
            <button type="button" className="run-close" title={t("run.dismiss")} aria-label={t("run.dismiss")} onClick={() => setDismissed(warnings)}>
              <CloseIcon />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Extension widgets, above or below the message box as omp placed them. */
export function RunWidgets({ placement }: { placement: "aboveEditor" | "belowEditor" }) {
  const widgets = useClientState((s) => s.progress.widgets);
  const mine = widgets.filter((w) => w.placement === placement);
  if (!mine.length) return null;
  return (
    <div className={`run-widgets ${placement === "aboveEditor" ? "above" : "below"}`}>
      {mine.map((w) => (
        <div className="run-widget" key={w.key} data-widget={w.key}>{w.lines.join("\n")}</div>
      ))}
    </div>
  );
}
