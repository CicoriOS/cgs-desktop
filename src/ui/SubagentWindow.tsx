import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { turnsFromMessages } from "../core/history";
import type { RawMessage } from "../core/messages";
import { isFinished, taskCallOf } from "../core/subagents";
import type { RingState, SubagentStatus, ToolCall } from "../core/types";
import { useT } from "../i18n";
import { useActions, useClientState } from "./client-context";
import { CloseIcon } from "./icons";
import { Ring } from "./ring";
import { RunScopeProvider } from "./transcript/scope";
import { Pre } from "./transcript/tools/BodyText";
import { TurnView } from "./transcript/TurnView";
import { isMobile } from "./viewport";

const POLL_MS = 1500;
const RETRY_MS = 3000;
const WIDTH = 560;
const HEIGHT = 520;
const CASCADE = 28;
const RING: Record<SubagentStatus, RingState> = { pending: "idle", running: "work", completed: "ok", failed: "fail", aborted: "stop" };

type Load = "loading" | "ready" | "unavailable";

/** The subagent's transcript, kept current while it runs: each pull reads only what was appended (`nextByte`). */
function useTranscript(id: string, running: boolean): { messages: RawMessage[]; load: Load } {
  const actions = useActions();
  const [messages, setMessages] = useState<RawMessage[]>([]);
  const [load, setLoad] = useState<Load>("loading");
  const from = useRef(0);
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    const pull = async () => {
      let again = POLL_MS;
      try {
        const r = await actions.subagentTranscript(id, from.current);
        if (!alive) return;
        from.current = r.nextByte;
        setMessages((prev) => (r.reset ? r.messages : r.messages.length ? [...prev, ...r.messages] : prev));
        setLoad("ready");
      } catch {
        if (!alive) return;
        setLoad("unavailable");
        again = RETRY_MS;
      }
      if (alive && running) timer = window.setTimeout(() => void pull(), again);
    };
    void pull();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [actions, id, running]);
  return { messages, load };
}

function Body({ id, running }: { id: string; running: boolean }) {
  const t = useT();
  const info = useClientState((s) => s.subagents.find((x) => x.id === id));
  const parent: ToolCall | undefined = useClientState((s) => (info?.parentToolCallId ? s.tools[info.parentToolCallId] : undefined));
  const { messages, load } = useTranscript(id, running);
  const built = useMemo(() => {
    const { turns, tools } = turnsFromMessages(messages.map((message) => ({ message })));
    // A call without a result is still running while the subagent runs; history marks it done.
    for (const call of Object.values(tools)) if (!call.result) call.status = running ? "running" : "ok";
    const last = turns.at(-1);
    if (last && running) last.state = "running";
    return { turns, tools };
  }, [messages, running]);

  if (load === "unavailable" && !messages.length) {
    const fallback = taskCallOf(parent, id);
    const prompt = fallback.task ?? info?.task;
    return (
      <>
        <div className="sub-note">{t("sub.unavailable")}</div>
        {prompt && <div className="sub-prompt-text">{prompt}</div>}
        {fallback.output && <Pre label={t("sub.result")}>{fallback.output}</Pre>}
      </>
    );
  }
  const [first, ...rest] = built.turns;
  const prompt = first?.user.text || info?.task;
  return (
    <>
      {prompt && (
        <details className="sub-prompt" open>
          <summary>{t("sub.prompt")}</summary>
          <div className="sub-prompt-text">{prompt}</div>
        </details>
      )}
      {first && <TurnView key={0} turn={{ ...first, user: { text: "" } }} index={0} isLast={!rest.length} tools={built.tools} />}
      {rest.map((turn, i) => (
        <TurnView key={i + 1} turn={turn} index={i + 1} isLast={i === rest.length - 1} tools={built.tools} />
      ))}
      {load === "loading" && !messages.length && <div className="sub-note">{t("sub.loading")}</div>}
      {load === "ready" && !messages.length && <div className="sub-note">{t("sub.noCalls")}</div>}
    </>
  );
}

/**
 * A subagent's prompt and calls in a floating in-page window (ADR 0037): draggable by its title, resizable from the corner,
 * several at once. Successful calls are folded like in the main transcript, failed ones open.
 */
export function SubagentWindow({ id, slot, z, onClose, onFocus }: { id: string; slot: number; z: number; onClose: () => void; onFocus: () => void }) {
  const t = useT();
  const info = useClientState((s) => s.subagents.find((x) => x.id === id));
  const running = !!info && !isFinished(info.status);
  const [pos, setPos] = useState(() => ({
    x: Math.max(12, window.innerWidth - WIDTH - 40 - slot * CASCADE),
    y: Math.min(Math.max(12, window.innerHeight - HEIGHT - 40), 72 + slot * CASCADE),
  }));
  const grab = useRef<{ dx: number; dy: number } | undefined>(undefined);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    onFocus();
    if (isMobile() || (e.target as HTMLElement).closest("button")) return;
    grab.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = grab.current;
    if (g) setPos({ x: Math.min(Math.max(0, e.clientX - g.dx), window.innerWidth - 80), y: Math.min(Math.max(0, e.clientY - g.dy), window.innerHeight - 40) });
  };
  const onUp = () => {
    grab.current = undefined;
  };

  if (!info) return null;
  const title = info.description ?? info.id;
  return (
    <div className="sub-win" role="dialog" aria-label={title} style={{ left: pos.x, top: pos.y, zIndex: z }} onPointerDown={onFocus}>
      <div className="sub-head" title={t("sub.drag")} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <b className="sub-title">{title}</b>
        <small className="sub-agent">{[info.agent !== title && info.agent, info.model].filter(Boolean).join(" · ")}</small>
        <Ring small state={RING[info.status]} level={info.level ?? "auto"} />
        <button type="button" className="icon small" title={t("common.close")} aria-label={t("common.close")} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <div className="sub-body">
        <RunScopeProvider value={{ streaming: running, level: info.level ?? "auto" }}>
          <Body id={id} running={running} />
        </RunScopeProvider>
      </div>
    </div>
  );
}
