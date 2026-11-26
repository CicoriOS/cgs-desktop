import type { ToolCall } from "../../../core/types";
import { useT } from "../../../i18n";
import { evalCells, evalImages, list, rec, str, todoPhases } from "./details";
import { Pre, resultText, TextBody } from "./BodyText";

type Props = { call: ToolCall };

export function Duration({ ms }: { ms: unknown }) {
  const t = useT();
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0
    ? <> · {ms < 1000 ? t("tool.ms", { n: Math.round(ms) }) : t("tool.sec", { n: (ms / 1000).toFixed(1) })}</> : null;
}

export function Status({ status }: { status?: string }) {
  const t = useT();
  switch (status) {
    case "pending": return t("tool.pending");
    case "running": return t("tool.running");
    case "complete": case "completed": return t("tool.completed");
    case "cancelled": return t("tool.cancelled");
    case "error": case "failed": return t("tool.err");
    default: return status ?? null;
  }
}

export function EvalBody({ call }: Props) {
  const t = useT();
  const cells = evalCells(call);
  const details = rec(call.result?.details);
  const notice = str(details.notice);
  const output = resultText(call);
  const structured = cells.some(c => c.output !== undefined);
  const asyncStatus = str(rec(details.async).state);
  return <>
    {notice && (structured || !output.includes(notice)) && <Pre>{notice}</Pre>}
    {asyncStatus && <div className="lab"><Status status={asyncStatus} /></div>}
    {cells.map((cell, i) => <div className="file" key={i}>
      <div className="lab">{cell.title || t("tool.cell", { n: i + 1 })}{cell.language && ` · ${cell.language}`}{cell.status && <> · <Status status={cell.status} /></>}<Duration ms={cell.duration} /></div>
      <Pre language={cell.language}>{cell.code}</Pre>
      {cell.output && <Pre label={t(cell.status === "error" ? "tool.err" : "tool.out")}>{cell.output}</Pre>}
    </div>)}
    {evalImages(call).map((src, i) => <img className="eval-image" key={i} src={src} alt={t("tool.image", { n: i + 1 })} loading="lazy" />)}
    {!call.result ? <div className="lab">{t("tool.running")}</div>
      : (!structured || (call.result.isError && !cells.some(c => c.status === "error" && c.output))) && output
        ? <Pre label={t(call.result.isError ? "tool.err" : "tool.out")}>{output}</Pre> : null}
  </>;
}

export function TaskBody({ call }: Props) {
  const t = useT();
  const details = rec(call.result?.details);
  const args = Array.isArray(call.args.tasks) ? call.args.tasks.map(rec) : [call.args];
  const results = list(details.results).map(rec);
  const progress = list(details.progress).map(rec);
  const entries = results.length ? results : progress.length ? progress : args;
  return <>
    <div className="lab"><Status status={str(rec(details.async).state) ?? (call.status === "ok" ? "completed" : call.status === "fail" ? "failed" : "running")} /><Duration ms={details.totalDurationMs} /></div>
    {entries.map((entry, i) => {
      const arg = args[typeof entry.index === "number" ? entry.index : i] ?? {};
      const name = str(entry.id ?? arg.name);
      const agent = str(entry.agent ?? arg.agent);
      const description = str(entry.description ?? entry.assignment ?? entry.task ?? arg.task) ?? list(arg.steps).filter(x => typeof x === "string").join("\n");
      const status = str(entry.status) ?? (entry.aborted ? "cancelled" : typeof entry.exitCode === "number" ? entry.exitCode === 0 ? "completed" : "failed" : undefined);
      const result = [entry.output, entry.error, entry.stderr].filter(x => typeof x === "string" && x).join("\n");
      return <div className="file" key={i}>
        <div className="lab">{[name, agent !== name && agent].filter(Boolean).join(" · ") || t("tool.agent", { n: i + 1 })}{status && <> · <Status status={status} /></>}<Duration ms={entry.durationMs} /></div>
        {description && <Pre>{description}</Pre>}
        {result && <Pre label={t("tool.result")}>{result}</Pre>}
      </div>;
    })}
    {call.result && (call.result.isError || !results.some(r => r.output || r.error || r.stderr)) && <TextBody call={call} />}
  </>;
}

const MARK = { pending: "☐", in_progress: "◐", completed: "☑", abandoned: "⊘" };

export function TodoBody({ call }: Props) {
  const t = useT();
  const phases = todoPhases(call.result?.details);
  return <>
    {phases.map((phase, i) => <div className="file" key={i}>
      {phase.name && <div className="lab">{phase.name}</div>}
      <ul className="tool-checklist">{phase.tasks.map((item, j) => <li key={j} data-state={item.status}>
        <span aria-hidden="true">{MARK[item.status]}</span> <span>{item.content}</span> <small>{t(`tool.${item.status}`)}</small>
      </li>)}</ul>
    </div>)}
    {(!phases.length || call.result?.isError) && <TextBody call={call} />}
  </>;
}

export function WebBody({ call }: Props) {
  const t = useT();
  const details = rec(call.result?.details);
  const query = str(call.args.query ?? call.args.url ?? details.url);
  const response = rec(details.response);
  const sources = list(response.sources);
  const answer = str(response.answer);
  return <>
    {query && <Pre label={t(call.name === "web_search" ? "tool.query" : "tool.url")}>{query}</Pre>}
    {answer && !call.result?.isError && <Pre label={t("tool.result")}>{answer}</Pre>}
    {!call.result?.isError && sources.length > 0 && <>
      <div className="lab">{t("tool.sources", { n: sources.length })}</div>
      <ul className="tool-sources">{sources.slice(0, 8).map((value, i) => {
        const source = rec(value);
        return <li key={i}>{str(source.title) || str(source.url)}{source.title && typeof source.url === "string" ? <div className="lab">{source.url}</div> : null}</li>;
      })}</ul>
    </>}
    {(call.result?.isError || (!answer && !sources.length)) && (call.name === "fetch" && call.result && !call.result.isError
      ? <Pre limit={2000}>{resultText(call) || t("tool.noResult")}</Pre> : <TextBody call={call} />)}
  </>;
}

export function AstBody({ call }: Props) {
  const t = useT();
  const details = rec(call.result?.details);
  const editing = call.name === "ast_edit";
  const first = call.args.pat ?? call.args.pattern ?? call.args.patterns;
  const patterns = editing ? list(call.args.ops).map(rec).flatMap(op => typeof op.pat === "string" ? [typeof op.out === "string" ? `${op.pat} → ${op.out}` : op.pat] : [])
    : (Array.isArray(first) ? first : [first]).filter((v): v is string => typeof v === "string");
  const count = editing ? details.totalReplacements : details.matchCount;
  const display = str(details.displayContent);
  return <>
    {patterns.length > 0 && <Pre label={t("tool.pattern")}>{patterns.join("\n")}</Pre>}
    {typeof count === "number" && <div className="lab">{t(editing ? "tool.replacements" : "tool.matches", { n: count })}</div>}
    {editing && display && !call.result?.isError ? <Pre language="diff">{display}</Pre> : <TextBody call={call} />}
  </>;
}
