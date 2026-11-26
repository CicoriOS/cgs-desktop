import { memo, type ReactNode, useMemo, useState } from "react";
import type { RingState, ToolCall, Turn } from "../../core/types";
import { useActions, useClientState } from "../client-context";
import { formatDuration } from "../format";
import { CheckIcon, CopyIcon, ForkIcon } from "../icons";
import { Ring } from "../ring";
import { Markdown } from "./Markdown";
import { callNames, type Step, viewTurn } from "./process";
import { ToolCard } from "./tools/ToolCard";
import { useT } from "../../i18n";

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea"); // clipboard API needs a secure context; fall back for plain http
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <button type="button" className="act-btn" title={done ? t("common.copied") : t("common.copy")} aria-label={t("common.copy")} onClick={copy}>
      {done ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function Fold({ className, summary, children, defaultOpen = false }: { className: string; summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className={className} open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

function CallChain({ calls }: { calls: ToolCall[] }) {
  const t = useT();
  const streaming = useClientState((s) => s.run.streaming);
  const level = useClientState((s) => s.thinking.resolved);
  const running = calls.some((c) => c.status === "running");
  const failed = calls.some((c) => c.status === "fail");
  const state: RingState = running ? (streaming ? "work" : "idle") : failed ? "fail" : "ok";
  const names = callNames(calls);
  const text = running && streaming ? t("turn.running", { names }) : failed ? t("turn.callFailed", { names }) : t("turn.used", { names });
  return (
    <Fold className={`chain${failed ? " err" : ""}`} defaultOpen={failed} summary={<><Ring small state={state} level={level} /><span className="cs">{text}</span></>}>
      <div className="cards">
        {calls.map((c) => (
          <ToolCard key={c.id} call={c} />
        ))}
      </div>
    </Fold>
  );
}

function StepLine({ step, thinkingNow }: { step: Step; thinkingNow: boolean }) {
  const t = useT();
  if (step.kind === "calls") return <CallChain calls={step.calls} />;
  if (step.kind === "note")
    return (
      <div className="pnote">
        <Markdown text={step.text} />
      </div>
    );
  return (
    <Fold className="thought" summary={<span className="cs">{thinkingNow ? t("turn.thinkingNow") : t("turn.thought")}</span>}>
      <div className="tt">{step.text}</div>
    </Fold>
  );
}

export const TurnView = memo(function TurnView({ turn, index, isLast, tools }: { turn: Turn; index: number; isLast: boolean; tools: Record<string, ToolCall> }) {
  const t = useT();
  const actions = useActions();
  const run = useClientState((s) => s.run);
  const level = useClientState((s) => s.thinking.resolved);
  const view = useMemo(() => viewTurn(turn, tools), [turn, tools]);

  const live = turn.state === "running";
  const hasReply = view.replies.length > 0;
  const ring: RingState = isLast && run.state !== "idle" ? run.state : turn.state === "failed" ? "fail" : turn.state === "interrupted" ? "stop" : "idle";
  const interrupted = turn.state === "interrupted" || turn.state === "failed";
  const lastMessage = turn.assistant.at(-1);
  const errorText = lastMessage?.stopReason === "error" && lastMessage.errorMessage ? lastMessage.errorMessage : turn.errorText;
  const showAssistant = live || turn.assistant.length > 0 || !!errorText;
  const canFork = !run.streaming && turn.state === "done" && turn.assistant.length > 0;

  const parts: string[] = [];
  if (view.hasThinking) parts.push(t("turn.thoughtFor", { d: formatDuration((turn.replyAt ?? turn.startedAt) - turn.startedAt) }));
  if (view.callCount) parts.push(t("turn.calls", { n: view.callCount }));
  const failedCall = view.steps.some((s) => s.kind === "calls" && s.calls.some((c) => c.status === "fail"));
  const lastStep = view.steps.length - 1;
  const steps = view.steps.map((s, i) => <StepLine key={i} step={s} thinkingNow={!hasReply && live && isLast && run.state === "think" && i === lastStep} />);

  return (
    <>
      {turn.user.text && (
        <div className="msg user">
          <div className="bubble">
            {turn.user.images?.map((im, i) => <img key={i} className="att" alt="" src={`data:${im.mimeType};base64,${im.data}`} />)}
            {turn.user.text}
          </div>
          {interrupted && !!view.steps.length && (
            <button type="button" className="edit-btn" onClick={() => actions.restoreDraft(turn.user.text)}>
              {t("turn.edit")}
            </button>
          )}
        </div>
      )}
      {showAssistant && (
        <div className="msg asst">
          <div className="gutter">
            <Ring state={ring} level={level} />
          </div>
          <div className="body">
            {steps.length > 0 &&
              (hasReply ? (
                <Fold className={`proc${failedCall ? " err" : ""}`} summary={parts.join(t("sep.parts")) || t("turn.process")}>
                  <div className="plist">{steps}</div>
                </Fold>
              ) : (
                <div className="proc live">
                  <div className="plist">{steps}</div>
                </div>
              ))}
            {view.replies.map((r, i) => {
              const finished = !live || !!r.stopReason;
              const last = i === view.replies.length - 1;
              return (
                <div key={r.id}>
                  <Markdown text={r.text} />
                  {finished && (
                    <div className="actions">
                      <CopyButton text={r.text} />
                      {last && canFork && (
                        <button type="button" className="act-btn" title={t("turn.fork")} aria-label={t("turn.fork")} onClick={() => actions.fork(index)}>
                          <ForkIcon />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {errorText && <div className="errline">{errorText}</div>}
          </div>
        </div>
      )}
    </>
  );
});
