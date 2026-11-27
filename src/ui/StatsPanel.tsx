import { useEffect, useState } from "react";
import { useActions, useReadOnly } from "./client-context";
import { CompactSplit } from "./CompactButton";
import { formatCost, formatPercent, formatTokens } from "./format";
import { CloseIcon } from "./icons";
import { cacheHitRate, type ContextGauge, fill, type StatsView, type Tokens } from "../core/stats";
import { useT } from "../i18n";

const REFRESH_MS = 4000;

function Bar({ gauge }: { gauge: ContextGauge }) {
  const t = useT();
  const f = fill(gauge);
  if (f === undefined) return <span className="muted">{t("stats.unknown")}</span>;
  const left = (gauge.window ?? 0) - (gauge.used ?? 0);
  return (
    <div className="gauge" title={`${formatTokens(gauge.used ?? 0)} / ${formatTokens(gauge.window ?? 0)}`}>
      <div className={f > 0.85 ? "bar hot" : "bar"} role="progressbar" aria-valuenow={Math.round(f * 100)} aria-valuemin={0} aria-valuemax={100}>
        <i style={{ width: `${f * 100}%` }} />
      </div>
      <span className="pct">{formatPercent(f)}</span>
      <span className="muted left">{formatTokens(Math.max(0, left))}</span>
    </div>
  );
}

function Counts({ u }: { u: Tokens }) {
  const t = useT();
  const hit = cacheHitRate(u);
  return (
    <div className="st-counts">
      <span>{t("stats.input")} <b>{formatTokens(u.input)}</b></span>
      <span>{t("stats.output")} <b>{formatTokens(u.output)}</b></span>
      <span>{t("stats.cacheRead")} <b>{formatTokens(u.cacheRead)}</b></span>
      <span>{t("stats.cacheWrite")} <b>{formatTokens(u.cacheWrite)}</b></span>
      <span>{t("stats.hit")} <b>{hit === undefined ? "–" : formatPercent(hit)}</b></span>
      <span>{t("stats.cost")} <b>{formatCost(u.cost)}</b></span>
    </div>
  );
}

/** Usage of the current session: tokens and cost per model, cache hit rate, how full each agent's context window is. */
export function StatsPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const actions = useActions();
  const readOnly = useReadOnly();
  const [view, setView] = useState<StatsView>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () =>
      actions.loadStats().then(
        (v) => live && (setView(v), setFailed(false)),
        () => live && setFailed(true),
      );
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [actions]);

  return (
    <div id="stats-panel">
      <div className="btw-head">
        <b>{t("stats.title")}</b>
        <span className="grow" />
        <button type="button" className="icon small" title={t("common.close")} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="st-body">
        {!view && <div className="muted">{failed ? t("stats.failed") : t("common.loading")}</div>}
        {view && (
          <>
            <section>
              <h4>{t("stats.total")}</h4>
              <Counts u={view.total} />
            </section>
            <section>
              <h4>{t("stats.models")}</h4>
              {view.rows.map((r) => (
                <div key={r.model} className="st-model">
                  <div className="st-name">
                    <span>{r.model}</span>
                    <span className="muted">{t("stats.requests", { n: r.requests })}</span>
                  </div>
                  <Counts u={r} />
                </div>
              ))}
              {view.other && (
                <div className="st-model">
                  <div className="st-name">
                    <span>{t("stats.other")}</span>
                  </div>
                  <Counts u={view.other} />
                </div>
              )}
              <div className="muted note">{t("stats.costNote")}</div>
            </section>
            <section>
              <div className="st-head">
                <h4>{t("stats.context")}</h4>
                {!readOnly && <CompactSplit />}
              </div>
              <div className="st-agent">
                <span className="st-name">{t("stats.main")}</span>
                <Bar gauge={view.main} />
              </div>
              {view.subagents.length === 0 && <div className="muted">{t("stats.noSubagents")}</div>}
              {view.subagents.map((s) => (
                <div key={s.id} className="st-agent" title={s.description}>
                  <span className="st-name">
                    {s.agent} <span className="muted">{s.status}</span>
                  </span>
                  <Bar gauge={s} />
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
