import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useActions, useClientState } from "../client-context";
import { ArrowUpIcon, BoltIcon, CloseIcon, PlusIcon, StopIcon } from "../icons";
import { Ring } from "../ring";
import { ModelPopover } from "./ModelPopover";
import { useT } from "../../i18n";

const MAX_HEIGHT_PX = 220;

/**
 * The message box. While the agent runs, Enter sends the text as a steering message (delivered before the model's next call).
 * Enter again on the emptied box interrupts the running output and delivers the queue now (ADR 0032).
 */
export function Composer() {
  const t = useT();
  const actions = useActions();
  const streaming = useClientState((s) => s.run.streaming);
  const queue = useClientState((s) => s.queue);
  const ringState = useClientState((s) => s.run.state);
  const level = useClientState((s) => s.thinking.resolved);
  const restore = useClientState((s) => s.draftRestore);

  const [text, setText] = useState("");
  const [popover, setPopover] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const ringBtn = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const lastRestore = useRef(restore?.seq);
  useEffect(() => {
    if (!restore || restore.seq === lastRestore.current) return;
    lastRestore.current = restore.seq;
    setText((cur) => (cur.trim() ? `${cur}\n${restore.text}` : restore.text));
    area.current?.focus();
  }, [restore]);

  const draft = text.trim();
  const mode = streaming ? (draft ? "steer" : queue.length ? "deliver" : "stop") : "send";

  const submit = () => {
    if (draft) {
      setText("");
      void actions.send(draft);
    } else if (streaming && queue.length) void actions.deliverQueueNow();
  };
  const onButton = () => (mode === "stop" ? void actions.stop() : submit());

  const BUTTON = {
    send: { icon: <ArrowUpIcon />, title: t("composer.send") },
    steer: { icon: <ArrowUpIcon />, title: t("composer.steer") },
    deliver: { icon: <BoltIcon />, title: t("composer.deliver") },
    stop: { icon: <StopIcon />, title: t("composer.stop") },
  }[mode];

  return (
    <div id="composer-wrap">
      {queue.length > 0 && (
        <div className="queue" aria-label={t("composer.queueAria")}>
          {queue.map((q, i) => (
            <div key={`${i}:${q.text}`} className="chip">
              <span className="chip-t">{q.text}</span>
              <button type="button" className="chip-x" title={t("composer.recall")} aria-label={t("composer.recall")} onClick={() => void actions.removeQueued(i)}>
                <CloseIcon />
              </button>
            </div>
          ))}
          <div className="queue-hint">{t("composer.queueHint")}</div>
        </div>
      )}
      <form
        id="composer"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          onButton();
        }}
      >
        <button type="button" className="icon" title={t("composer.attach")} disabled>
          <PlusIcon />
        </button>
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={streaming ? t("composer.placeholderBusy") : t("composer.placeholder")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button ref={ringBtn} type="button" className="icon" aria-haspopup="dialog" title={t("composer.model")} onClick={(e) => (e.stopPropagation(), setPopover((v) => !v))}>
          <Ring state={ringState} level={level} />
        </button>
        <button type="submit" id="send" data-mode={mode} title={BUTTON.title} aria-label={BUTTON.title} disabled={mode === "send" && !draft}>
          {BUTTON.icon}
        </button>
      </form>
      {popover && <ModelPopover anchor={ringBtn} onClose={() => setPopover(false)} />}
    </div>
  );
}
