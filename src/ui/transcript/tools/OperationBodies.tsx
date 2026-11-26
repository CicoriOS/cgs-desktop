import type { ToolCall } from "../../../core/types";
import { useT } from "../../../i18n";
import { Pre, TextBody } from "./BodyText";
import { evalImages, list, rec, str } from "./details";
import { Duration, Status } from "./ExtraBodies";

type Props = { call: ToolCall };

export function OperationBody({ call }: Props) {
  const details = rec(call.result?.details);
  const values = { ...rec(details.request), ...call.args };
  const fields = Object.entries(values).filter(([, v]) => v !== undefined && v !== null);
  return <>
    {typeof details.serverName === "string" && <div className="lab">{details.serverName}</div>}
    {fields.length > 0 && <dl className="tool-fields">{fields.map(([key, v]) => <div key={key}>
      <dt>{key}</dt><dd>{typeof v === "object" ? <Pre>{JSON.stringify(v, null, 2)}</Pre> : String(v).slice(0, 20_000)}</dd>
    </div>)}</dl>}
    <TextBody call={call} />
  </>;
}

export function JobsBody({ call }: Props) {
  const t = useT();
  const details = rec(call.result?.details);
  const jobs = [...list(details.jobs), ...list(details.cancelled)].map(rec);
  if (!jobs.length) return <OperationBody call={call} />;
  return <>{jobs.map((job, i) => <div className="file" key={i}>
    <div className="lab">{str(job.id)}{typeof job.status === "string" && <> · <Status status={job.status} /></>}<Duration ms={job.durationMs} /></div>
    {typeof job.label === "string" && <Pre>{job.label}</Pre>}
    {typeof job.message === "string" && <Pre>{job.message}</Pre>}
    {typeof job.resultText === "string" && <Pre label={t("tool.result")}>{job.resultText}</Pre>}
    {typeof job.errorText === "string" && <Pre label={t("tool.err")}>{job.errorText}</Pre>}
  </div>)}{(call.result?.isError || !jobs.some(j => j.resultText || j.errorText || j.message)) && <TextBody call={call} />}</>;
}

export function MediaBody({ call }: Props) {
  const t = useT();
  return <><OperationBody call={call} />{evalImages(call).map((src, i) => <img className="eval-image" key={i} src={src} alt={t("tool.image", { n: i + 1 })} loading="lazy" />)}</>;
}

export function mcpLabel(call: ToolCall) {
  const { serverName, mcpToolName } = rec(call.result?.details);
  return typeof serverName === "string" && typeof mcpToolName === "string"
    ? `${serverName} / ${mcpToolName}` : call.name;
}

export function McpBody({ call }: Props) {
  const t = useT();
  const structured = rec(call.result?.details).structuredContent;
  return <>
    <Pre language="json" label={t("tool.args")}>{JSON.stringify(call.args, null, 2)}</Pre>
    {structured !== undefined && !call.result?.isError
      ? <Pre language="json" label={t("tool.result")}>{JSON.stringify(structured, null, 2)}</Pre>
      : <TextBody call={call} />}
  </>;
}
