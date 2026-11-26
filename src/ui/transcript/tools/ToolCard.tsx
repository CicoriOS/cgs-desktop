import { type JSX, useEffect, useState } from "react";
import type { RingState, ToolCall } from "../../../core/types";
import { useClientState } from "../../client-context";
import { baseName } from "../../format";
import { Ring } from "../../ring";
import { addedLines, diffStats, type DiffLine, parseDiff, replacementPreview } from "./diff";
import { DiffView } from "./DiffView";
import { useT } from "../../../i18n";

type Rec = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const rec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const MAX_TEXT = 20_000;

/** Text blocks of a tool result. */
export function resultText(call: ToolCall): string {
  const parts = (call.result?.content ?? []) as { type?: string; text?: string }[];
  return parts.map((p) => (p?.type === "text" ? (p.text ?? "") : "")).join("");
}

/** One-line description of what a call does, for the card header. */
export function argSummary(call: ToolCall): string {
  const a = call.args;
  const v = a.command ?? a.path ?? a.file_path ?? a.pattern ?? a.url ?? a.query ?? a.intent ?? Object.values(a).find((x) => typeof x === "string");
  return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 140) : "";
}

function Pre({ children, label }: { children: string; label?: string }) {
  const t = useT();
  return (
    <>
      {label && <div className="lab">{label}</div>}
      <pre>{children.length > MAX_TEXT ? `${children.slice(0, MAX_TEXT)}\n${t("tool.truncated")}` : children}</pre>
    </>
  );
}

// ---------------------------------------------------------------- per-tool bodies

function BashBody({ call }: { call: ToolCall }) {
  const t = useT();
  const out = resultText(call);
  const ms = rec(call.result?.details).wallTimeMs;
  return (
    <>
      <div className="lab">{t("tool.cmd")}</div>
      <pre className="cmd">{`$ ${str(call.args.command) ?? ""}`}</pre>
      {call.result ? <Pre label={`${call.result.isError ? t("tool.err") : t("tool.out")}${typeof ms === "number" ? `  ${ms < 1000 ? t("tool.ms", { n: Math.round(ms) }) : t("tool.sec", { n: (ms / 1000).toFixed(1) })}` : ""}`}>{out || t("tool.noOutput")}</Pre> : <div className="lab">{t("tool.running")}</div>}
    </>
  );
}

function ReadBody({ call }: { call: ToolCall }) {
  const t = useT();
  const display = rec(rec(call.result?.details).displayContent);
  const text = str(display.text);
  if (!call.result) return <div className="lab">{t("tool.reading")}</div>;
  if (call.result.isError || text === undefined) return <Pre>{resultText(call) || t("tool.empty")}</Pre>;
  const start = typeof display.startLine === "number" ? display.startLine : 1;
  const numbers = Array.isArray(display.lineNumbers) ? (display.lineNumbers as number[]) : undefined;
  const lines: DiffLine[] = text.split("\n").map((t, i) => ({ kind: "ctx", no: numbers?.[i] ?? start + i, text: t }));
  return <DiffView lines={lines} />;
}

interface FileDiff {
  path: string;
  lines: DiffLine[];
  note?: string;
}

function editFiles(call: ToolCall): FileDiff[] {
  const d = rec(call.result?.details);
  const per = Array.isArray(d.perFileResults) ? (d.perFileResults as Rec[]) : [];
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
  const files = editFiles(call);
  const text = resultText(call);
  return (
    <>
      {files.map((f, i) => (
        <div key={i} className="file">
          {files.length > 1 && <div className="lab">{f.path}</div>}
          {f.note && <div className="errline">{f.note}</div>}
          <DiffView lines={f.lines} />
        </div>
      ))}
      {!files.length && (call.result ? <Pre>{text || t("tool.empty")}</Pre> : <div className="lab">{t("tool.applying")}</div>)}
      {call.result?.isError && files.length > 0 && text && <Pre label={t("tool.err")}>{text}</Pre>}
    </>
  );
}

function WriteBody({ call }: { call: ToolCall }) {
  const t = useT();
  const content = str(call.args.content);
  return (
    <>
      {content !== undefined ? <DiffView lines={addedLines(content)} /> : <div className="lab">{call.result ? "" : t("tool.writing")}</div>}
      {call.result?.isError && <Pre label={t("tool.err")}>{resultText(call)}</Pre>}
    </>
  );
}

function TextBody({ call }: { call: ToolCall }) {
  const t = useT();
  const display = rec(call.result?.details).displayContent;
  const text = typeof display === "string" ? display : resultText(call);
  return call.result ? <Pre>{text || t("tool.noResult")}</Pre> : <div className="lab">{t("tool.running")}</div>;
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

const BODY: Record<string, (p: { call: ToolCall }) => JSX.Element> = {
  bash: BashBody,
  read: ReadBody,
  edit: EditBody,
  write: WriteBody,
  grep: TextBody,
  glob: TextBody,
  find: TextBody,
};

/** `+N −M` for edit/write headers. */
function statChip(call: ToolCall): { added: number; removed: number } | undefined {
  if (call.name === "edit") {
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

  const Body = BODY[call.name] ?? GenericBody;
  const stat = statChip(call);
  const path = str(call.args.path) ?? str(call.args.file_path);
  const summary = call.name === "edit" || call.name === "write" || call.name === "read" ? (path ? baseName(path) : argSummary(call)) : argSummary(call);
  return (
    <details className={`tool${failed ? " err" : ""}`} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary title={path ?? undefined}>
        <Ring small state={toolRingState(call, streaming)} level={level} />
        <span className="name">{call.name}</span>
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
