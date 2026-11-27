import { RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SettingsApi, UsageReport } from "../../core/settings";
import { useLocale, useT } from "../../i18n";
import { percentText, planTimeText, usedPercent } from "../account";
import { useClientState } from "../client-context";
import { formatTokens } from "../format";
import { UsageMeter } from "../UsageMeter";
import type { Dimension } from "./usage";
import { groupUsage, sumUsage, usageWindow } from "./usage";

const RANGES = [7, 30, 90] as const;
type Range = typeof RANGES[number];
type Metric = "cost" | "tokens";
const TREND_GROUPS = ["day", "month", "project"] as const;
const TABLE_GROUPS = ["model", "day", "project"] as const;

export function UsagePanel({ load }: { load?: SettingsApi["usage"] }) {
  const t = useT();
  const locale = useLocale();
  const account = useClientState((s) => s.account);
  const [range, setRange] = useState<Range>(30);
  const [trendBy, setTrendBy] = useState<(typeof TREND_GROUPS)[number]>("day");
  const [breakdownBy, setBreakdownBy] = useState<(typeof TABLE_GROUPS)[number]>("model");
  const [metric, setMetric] = useState<Metric>("cost");
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ report: UsageReport; now: number }>();
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(!!load);
  useEffect(() => {
    if (!load) return;
    let active = true;
    setLoading(true);
    setFailed(false);
    void load().then((report) => {
      if (active) setSnapshot({ report, now: Date.now() });
    }, () => {
      if (active) setFailed(true);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load, revision]);

  const entries = useMemo(() => snapshot ? usageWindow(snapshot.report.entries, range, snapshot.now) : [], [snapshot, range]);
  const total = useMemo(() => sumUsage(entries), [entries]);
  const series = useMemo(() => groupUsage(entries, trendBy), [entries, trendBy]);
  const breakdown = useMemo(() => groupUsage(entries, breakdownBy), [entries, breakdownBy]);
  const money = useMemo(() => new Intl.NumberFormat(locale, { style: "currency", currency: snapshot?.report.currency ?? "USD" }), [locale, snapshot?.report.currency]);
  const format = metric === "cost" ? money.format : formatTokens;

  const width = 360;
  const height = 110;
  const temporal = trendBy !== "project";
  const max = series.reduce((highest, point) => Math.max(highest, point[metric]), 1);
  // Real time spacing: a quiet week is wider than a quiet day.
  const points = temporal && series.length ? (() => {
    const first = Date.parse(series[0]!.key);
    const span = Date.parse(series.at(-1)!.key) - first;
    return series.map((point) => ({
      x: span ? 8 + (Date.parse(point.key) - first) / span * (width - 16) : width / 2,
      y: height - 8 - point[metric] / max * (height - 16),
      point,
    }));
  })() : [];

  const tabs = <T extends Dimension>(choices: readonly T[], active: T, change: (value: T) => void, label: string) => (
    <div className="set-tabs" role="group" aria-label={label}>
      {choices.map((value) => <button key={value} type="button" aria-pressed={active === value} onClick={() => change(value)}>{t(`set.ui.${value}`)}</button>)}
    </div>
  );

  return (
    <>
      {account && (
        <section className="set-card">
          <div className="set-plan-head"><b>{t("acct.balance")}</b><span className="usage-value">{account.balance || "—"}</span></div>
          {account.stale && <p className="set-desc">{t("acct.stale")}</p>}
          {account.subscriptions.map((sub) => {
            const percent = usedPercent(sub);
            return (
              <div key={sub.id} className="set-plan">
                <div className="set-plan-head"><b>{sub.planTitle || t("set.ui.planUsage")}</b><span className="muted">{planTimeText(sub, Date.now())}</span></div>
                {!sub.unlimited && <UsageMeter used={percent} label={sub.planTitle || t("set.ui.planUsage")} />}
                <div className="set-plan-foot">
                  <span className="usage-value">{sub.unlimited ? t("acct.used", { used: sub.usedDisplay || String(sub.amountUsed) }) : `${sub.usedDisplay || sub.amountUsed} / ${sub.totalDisplay || sub.amountTotal}`}</span>
                  <span className="usage-value">{sub.unlimited ? t("acct.unlimited") : percentText(percent)}</span>
                </div>
              </div>
            );
          })}
        </section>
      )}
      {load ? (
        <>
          <div className="set-actions usage-filters">
            {tabs(TREND_GROUPS, trendBy, setTrendBy, t("set.ui.groupBy"))}
            <span className="grow" />
            <select className="set-select" aria-label={t("set.ui.range")} value={range} onChange={(e) => {
              const selected = RANGES.find((days) => String(days) === e.target.value);
              if (selected) setRange(selected);
            }}>
              {RANGES.map((r) => <option key={r} value={r}>{t(`set.opt.d${r}`)}</option>)}
            </select>
            <button className="set-btn" type="button" aria-label={t("set.ui.refresh")} disabled={loading} onClick={() => setRevision((n) => n + 1)}><RefreshCw className="i" /></button>
          </div>
          {(failed || loading) && <p className="set-desc" role="status">{t(failed ? "set.ui.loadFailed" : "set.ui.loading")}</p>}
          {snapshot && (entries.length ? (
            <>
              <div className="set-usage-overview">
                <div className="set-card">
                  <div className="set-sec">{t("set.ui.rawCost")}</div>
                  <strong>{money.format(total.cost)}</strong>
                  <p className="set-desc">{t("set.ui.rawCostHelp")}</p>
                </div>
                <div className="set-card">
                  <div className="set-usage-chart-head">
                    <h3 className="set-sec">{t(temporal ? "set.ui.trend" : "set.ui.project")}</h3>
                    <div className="set-tabs" role="group" aria-label={t("set.ui.trendMetric")}>
                      {(["cost", "tokens"] as const).map((m) => <button key={m} type="button" aria-pressed={metric === m} onClick={() => setMetric(m)}>{t(`set.ui.${m}`)}</button>)}
                    </div>
                  </div>
                  {temporal ? (
                    <figure className="set-trend">
                      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t(`set.ui.${metric}`)}>
                        <path className="set-grid" d={`M8 ${height - 8}H${width - 8} M8 ${height / 2}H${width - 8} M8 8H${width - 8}`} />
                        {points.length > 1 && <polyline points={points.map(({ x, y }) => `${x},${y}`).join(" ")} />}
                        {points.map(({ x, y, point }) => <circle key={point.key} cx={x} cy={y} r={points.length > 45 ? 1.5 : 2.8}><title>{`${point.key}: ${format(point[metric])}`}</title></circle>)}
                      </svg>
                      <figcaption><span>{series[0]?.key}</span><span>{series.length > 1 && series.at(-1)?.key}</span></figcaption>
                    </figure>
                  ) : (
                    <div className="set-project-bars">
                      {series.map((point) => <div key={point.key}><span>{point.key}</span><meter aria-label={point.key} value={point[metric]} max={max} /><span>{format(point[metric])}</span></div>)}
                    </div>
                  )}
                </div>
              </div>
              <div className="set-stats">
                {([
                  ["tokens", formatTokens(total.tokens)],
                  ["cached", formatTokens(total.cacheRead)],
                  ["input", formatTokens(total.input)],
                  ["output", formatTokens(total.output)],
                  ["cacheSaved", money.format(total.cacheSavings)],
                ] as const).map(([id, value]) => (
                  <div className="set-card" key={id}><div className="set-desc">{t(`set.ui.${id}`)}</div><b>{value}</b></div>
                ))}
              </div>
              <div className="set-usage-chart-head">
                <h3 className="set-sec">{t("set.ui.breakdown")}</h3>
                {tabs(TABLE_GROUPS, breakdownBy, setBreakdownBy, t("set.ui.breakdown"))}
              </div>
              <table className="set-table">
                <thead><tr><th scope="col">{t(`set.ui.${breakdownBy}`)}</th><th scope="col">{t("set.ui.tokens")}</th><th scope="col">{t("set.ui.cost")}</th></tr></thead>
                <tbody>{breakdown.map((row) => <tr key={row.key}><td>{row.key}</td><td>{formatTokens(row.tokens)}</td><td>{money.format(row.cost)}</td></tr>)}</tbody>
              </table>
            </>
          ) : <p className="set-card muted">{t("set.ui.noUsage")}</p>)}
        </>
      ) : <p className="set-card muted">{t("set.ui.usageUnavailable")}</p>}
    </>
  );
}
