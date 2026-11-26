import { useMemo } from "react";
import type { ToolCall } from "../../../core/types";
import { useT } from "../../../i18n";
import { list, rec, str } from "./details";
import { highlightHtml } from "./highlight";

export function resultText(call: ToolCall): string {
  return list(call.result?.content).map(rec).filter(p => p.type === "text").map(p => str(p.text) ?? "").join("");
}

export function Pre({ children, label, language, limit = 20_000 }: { children: string; label?: string; language?: string; limit?: number }) {
  const t = useT();
  const text = children.length > limit ? `${children.slice(0, limit)}\n${t("tool.truncated")}` : children;
  const html = useMemo(() => highlightHtml(text, language), [text, language]);
  return <>
    {label && <div className="lab">{label}</div>}
    {html === undefined ? <pre>{text}</pre> : <pre className="cmd" dangerouslySetInnerHTML={{ __html: html }} />}
  </>;
}

export function TextBody({ call }: { call: ToolCall }) {
  const t = useT();
  const text = str(rec(call.result?.details).displayContent) || resultText(call);
  return call.result ? <Pre label={call.result.isError ? t("tool.err") : undefined}>{text || t("tool.noResult")}</Pre> : <div className="lab">{t("tool.running")}</div>;
}
