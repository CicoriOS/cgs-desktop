import { type JSX, useEffect, useMemo, useState } from "react";
import type { RingState, ToolCall } from "../../../core/types";
import { useClientState } from "../../client-context";
import { baseName } from "../../format";
import { Ring } from "../../ring";
import { addedLines, diffStats, type DiffLine, parseDiff, replacementPreview } from "./diff";
import { DiffView } from "./DiffView";
import { highlightHtml, langOf } from "./highlight";
import { useT } from "../../../i18n";

import { Pre, resultText, TextBody } from "./BodyText";
import { AstBody, EvalBody, TaskBody, TodoBody, WebBody } from "./ExtraBodies";
import { list, rec, str } from "./details";
import { JobsBody, McpBody, mcpLabel, MediaBody, OperationBody } from "./OperationBodies";
import { type CardKind, toolCardKind } from "./cardKinds";

/** One-line description of what a call does, for the card header. */
export function argSummary(call: ToolCall): string {
  const a = call.args;
  const firstTask = rec(list(a.tasks)[0]);
  const preferred = call.name === "task" || call.name === "subagent" ? firstTask.name ?? a.name ?? firstTask.task ?? a.task : undefined;
  const operation = str(a.action ?? a.op);
  const v = preferred ?? a.command ?? a.path ?? a.file_path ?? a.file ?? a.pattern ?? a.pat ?? a.url ?? a.query ?? a.repo ?? a.intent ?? a.code ?? a.title ?? a.goal ?? a.input;
  return [operation, str(v) ?? (operation ? undefined : Object.values(a).find((x): x is string => typeof x === "string"))].filter(Boolean).join(" · ").replace(/\s+/g, " ").slice(0, 140);
}

// ---------------------------------------------------------------- per-tool bodies

/** The shell command, highlighted as bash. */
function CommandPre({ command }: { command: string }) {
  const html = useMemo(() => highlightHtml(command, "bash"), [command]);
  return html === undefined ? <pre className="cmd">{`$ ${command}`}</pre> : <pre className="cmd"><span className="ps">$ </span><span dangerouslySetInnerHTML={{ __html: html }} /></pre>;
}

function BashBody({ call }: { call: ToolCall }) {
  const t = useT();
  const out = resultText(call);
  const ms = rec(call.result?.details).wallTimeMs;
  return (
    <>
      <div className="lab">{t("tool.cmd")}</div>
      <CommandPre command={str(call.args.command) ?? ""} />
      {call.result ? <Pre label={`${call.result.isError ? t("tool.err") : t("tool.out")}${typeof ms === "number" ? `  ${ms < 1000 ? t("tool.ms", { n: Math.round(ms) }) : t("tool.sec", { n: (ms / 1000).toFixed(1) })}` : ""}`}>{out || t("tool.noOutput")}</Pre> : <div className="lab">{t("tool.running")}</div>}
    </>
  );
}

function ReadBody({ call }: { call: ToolCall }) {
  const t = useT();
  const display = rec(rec(call.result?.details).displayContent);
  const text = str(display.text);
  const start = typeof display.startLine === "number" ? display.startLine : 1;
  const numbers = Array.isArray(display.lineNumbers) ? (display.lineNumbers as number[]) : undefined;
  const lines = useMemo<DiffLine[]>(() => (text === undefined ? [] : text.split("\n").map((line, i) => ({ kind: "ctx", no: numbers?.[i] ?? start + i, text: line }))), [text, start, numbers]);
  if (!call.result) return <div className="lab">{t("tool.reading")}</div>;
  if (call.result.isError || text === undefined) return <Pre>{resultText(call) || t("tool.empty")}</Pre>;
  return <DiffView lines={lines} lang={langOf(str(call.args.path) ?? str(call.args.file_path))} />;
}

interface FileDiff {
  path: string;
  lines: DiffLine[];
  note?: string;
}

function editFiles(call: ToolCall): FileDiff[] {
  const d = rec(call.result?.details);
  const per = list(d.perFileResults).map(rec);
  if (per.length) {
    return per.map((f) => ({ path: str(f.path) ?? "", lines: parseDiff(str(f.diff) ?? ""), note: f.isError ? (str(f.displayErrorText) ?? str(f.errorText)) : undefined }));
  }
  const diff = str(d.diff);
  if (diff) return [{ path: str(d.path) ?? str(call.args.path) ?? "", lines: parseDiff(diff) }];
  const oldS = str(call.args.old_string);
  const newS = str(call.args.new_string);
  if (!call.result && oldS !== undefined && newS !== undefined) return [{ path: str(call.args.path) ?? "", lines: replacementPreview(oldS, newS) }];
  return [];
}

function EditBody({ call }: { call: ToolCall }) {
  const t = useT();
  const files = useMemo(() => editFiles(call), [call]);
  const text = resultText(call);
  return (
    <>
      {files.map((f, i) => (
        <div key={i} className="file">
          {files.length > 1 && <div className="lab">{f.path}</div>}
          {f.note && <div className="errline">{f.note}</div>}
          <DiffView lines={f.lines} lang={langOf(f.path || str(call.args.path))} />
        </div>
      ))}
      {!files.length && <>
        {typeof call.args.input === "string" && <Pre language="diff">{call.args.input}</Pre>}
        {list(call.args.edits).map((item, i) => {
          const edit = rec(item);
          return <Pre key={i} language="diff" label={[str(edit.op), str(edit.rename)].filter(Boolean).join(" → ")}>{str(edit.diff) ?? ""}</Pre>;
        })}
        {call.result ? <Pre label={call.result.isError ? t("tool.err") : undefined}>{text || t("tool.empty")}</Pre> : <div className="lab">{t("tool.applying")}</div>}
      </>}
      {call.result?.isError && files.length > 0 && text && <Pre label={t("tool.err")}>{text}</Pre>}
    </>
  );
}

function WriteBody({ call }: { call: ToolCall }) {
  const t = useT();
  const content = str(call.args.content);
  const lines = useMemo(() => (content === undefined ? [] : addedLines(content)), [content]);
  return (
    <>
      {content !== undefined ? <DiffView lines={lines} lang={langOf(str(call.args.path) ?? str(call.args.file_path))} /> : <div className="lab">{call.result ? "" : t("tool.writing")}</div>}
      {call.result?.isError && <Pre label={t("tool.err")}>{resultText(call)}</Pre>}
    </>
  );
}

function GenericBody({ call }: { call: ToolCall }) {
  const t = useT();
  return (
    <>
      <Pre label={t("tool.args")}>{JSON.stringify(call.args, null, 2)}</Pre>
      {call.result ? <Pre label={call.result.isError ? t("tool.err") : t("tool.result")}>{resultText(call) || t("tool.empty")}</Pre> : <div className="lab">{t("tool.running")}</div>}
    </>
  );
}

const BODY: Record<CardKind, (p: { call: ToolCall }) => JSX.Element> = {
  bash: BashBody, read: ReadBody, edit: EditBody, write: WriteBody, text: TextBody,
  eval: EvalBody, task: TaskBody, todo: TodoBody, web: WebBody, ast: AstBody,
  jobs: JobsBody, operation: OperationBody, media: MediaBody, mcp: McpBody,
  ask: TextBody, // AskCard is routed separately by the transcript.
  generic: GenericBody,
};

/** `+N −M` for edit/write headers. */
function statChip(call: ToolCall): { added: number; removed: number } | undefined {
  if (toolCardKind(call.name) === "edit") {
    const files = editFiles(call);
    if (!files.length) return undefined;
    return files.reduce((t, f) => {
      const s = diffStats(f.lines);
      return { added: t.added + s.added, removed: t.removed + s.removed };
    }, { added: 0, removed: 0 });
  }
  if (call.name === "write" && typeof call.args.content === "string") return { added: addedLines(call.args.content).length, removed: 0 };
  return undefined;
}

export function toolRingState(call: ToolCall, streaming: boolean): RingState {
  if (call.status === "ok") return "ok";
  if (call.status === "fail") return "fail";
  return streaming ? "work" : "idle";
}

export function ToolCard({ call }: { call: ToolCall }) {
  const streaming = useClientState((s) => s.run.streaming);
  const level = useClientState((s) => s.thinking.resolved);
  const failed = call.status === "fail";
  const [open, setOpen] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);
  useEffect(() => {
    if (failed && !autoOpened) {
      setAutoOpened(true);
      setOpen(true); // a failed call opens its card once
    }
  }, [failed, autoOpened]);

  const kind = call.name === "read" && rec(call.result?.details).kind === "url" ? "web" : toolCardKind(call.name);
  const Body = BODY[kind];
  const stat = statChip(call);
  const path = str(call.args.path) ?? str(call.args.file_path);
  const summary = path && (kind === "edit" || kind === "write" || kind === "read") ? baseName(path) : argSummary(call);
  return (
    <details className={`tool${failed ? " err" : ""}`} data-card-kind={kind} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary title={path ?? undefined}>
        <Ring small state={toolRingState(call, streaming)} level={level} />
        <span className="name">{kind === "mcp" ? mcpLabel(call) : call.name}</span>
        <span className="sum">{summary}</span>
        {stat && (
          <span className="stat">
            <b className="plus">+{stat.added}</b> {stat.removed > 0 && <b className="minus">−{stat.removed}</b>}
          </span>
        )}
      </summary>
      {open && (
        <div className="tb">
          <Body call={call} />
        </div>
      )}
    </details>
  );
}
