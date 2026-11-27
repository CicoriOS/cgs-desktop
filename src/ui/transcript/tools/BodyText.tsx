import { useMemo } from "react";
import type { ToolCall } from "../../../core/types";
import { useT } from "../../../i18n";
import { list, rec, str } from "./details";
import { highlightHtml } from "./highlight";

export function resultText(call: ToolCall): string {
  return list(call.result?.content).map(rec).filter(p => p.type === "text").map(p => str(p.text) ?? "").join("");
}

/** A running call's output so far; the result replaces it, so a finished card reads exactly as before. */
export function streamText(call: ToolCall): string {
  return call.result ? "" : call.stream?.text ?? "";
}

/** `tail`: keep the end of a long text (a live log is read at its end); the default keeps the start. */
export function Pre({ children, label, language, limit = 20_000, tail }: { children: string; label?: string; language?: string; limit?: number; tail?: boolean }) {
  const t = useT();
  const cut = children.length > limit;
  const text = cut ? (tail ? `…\n${children.slice(children.length - limit)}` : `${children.slice(0, limit)}\n${t("tool.truncated")}`) : children;
  const html = useMemo(() => highlightHtml(text, language), [text, language]);
  return <>
    {label && <div className="lab">{label}</div>}
    {html === undefined ? <pre>{text}</pre> : <pre className="cmd" dangerouslySetInnerHTML={{ __html: html }} />}
  </>;
}

export function TextBody({ call }: { call: ToolCall }) {
  const t = useT();
  const text = str(rec(call.result?.details).displayContent) || resultText(call) || streamText(call);
  return call.result ? <Pre label={call.result.isError ? t("tool.err") : undefined}>{text || t("tool.noResult")}</Pre>
    : call.stream ? <Pre tail label={t("tool.out")}>{text || t("tool.noOutput")}</Pre>
    : <div className="lab">{t("tool.running")}</div>;
}
