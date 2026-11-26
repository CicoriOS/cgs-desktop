import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ImageRef } from "../../core/types";
import { useT } from "../../i18n";
import { FRAME_BUDGET_CHARS, imageFiles, MAX_IMAGES, MIN_IMAGE_CHARS, prepareImage } from "../attachments";
import { useActions, useClientState } from "../client-context";
import { FEATURES } from "../features";
import { ArrowUpIcon, BoltIcon, CloseIcon, PlusIcon, StopIcon } from "../icons";
import { Ring } from "../ring";
import { ModelPopover } from "./ModelPopover";

const MAX_HEIGHT_PX = 220;

/**
 * The message box. While the agent runs, Enter sends the text as a steering message (delivered before the model's next call).
 * Enter again on the emptied box interrupts the running output and delivers the queue now (ADR 0032).
 * Pictures attach by paste or drop (the "+" file picker is a desktop feature, see features.ts).
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
  const [images, setImages] = useState<ImageRef[]>([]);
  const [dragging, setDragging] = useState(false);
  const [popover, setPopover] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const ringBtn = useRef<HTMLButtonElement>(null);
  const imagesRef = useRef(images);
  imagesRef.current = images;

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
    if (restore.images?.length) setImages((cur) => [...cur, ...restore.images!].slice(0, MAX_IMAGES));
    area.current?.focus();
  }, [restore]);

  /**
   * Decodes and adds pictures. All attachments travel in one frame, so each new picture gets an equal share of what the frame
   * has left; what exceeds the count or the budget is reported, the rest still attach.
   */
  const attach = async (files: File[]) => {
    const room = MAX_IMAGES - imagesRef.current.length;
    if (files.length > room) actions.notify(t("attach.tooMany", { n: MAX_IMAGES }));
    const wanted = files.slice(0, Math.max(0, room));
    const added: ImageRef[] = [];
    for (const [i, file] of wanted.entries()) {
      const used = [...imagesRef.current, ...added].reduce((n, im) => n + im.data.length, 0);
      const share = Math.floor((FRAME_BUDGET_CHARS - used) / (wanted.length - i));
      if (share < MIN_IMAGE_CHARS) {
        actions.notify(t("attach.tooBig"));
        break;
      }
      try {
        added.push(await prepareImage(file, share));
      } catch {
        actions.notify(t("attach.failed"));
      }
    }
    if (added.length) setImages((cur) => [...cur, ...added].slice(0, MAX_IMAGES));
  };

  // Drop anywhere on the page, not only on the box.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => hasFiles(e) && (depth++, setDragging(true));
    const leave = (e: DragEvent) => hasFiles(e) && --depth <= 0 && ((depth = 0), setDragging(false));
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      void attach(imageFiles(e.dataTransfer));
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragleave", leave);
    document.addEventListener("dragover", over);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", drop);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const draft = text.trim();
  const hasInput = !!draft || images.length > 0;
  const mode = streaming ? (hasInput ? "steer" : queue.length ? "deliver" : "stop") : "send";

  const submit = () => {
    if (hasInput) {
      const sent = images;
      setText("");
      setImages([]);
      void actions.send(draft, sent);
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
    <div id="composer-wrap" className={dragging ? "dragging" : undefined}>
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
      {(images.length > 0 || dragging) && (
        <div className="att-tray">
          {images.map((im, i) => (
            <div key={i} className="att-thumb">
              <img alt="" src={`data:${im.mimeType};base64,${im.data}`} />
              <button type="button" title={t("attach.remove")} aria-label={t("attach.remove")} onClick={() => setImages((cur) => cur.filter((_, k) => k !== i))}>
                <CloseIcon />
              </button>
            </div>
          ))}
          {dragging && <div className="att-drop">{t("attach.drop")}</div>}
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
        {FEATURES.attachButton && (
          <button type="button" className="icon" title={t("composer.attach")} disabled>
            <PlusIcon />
          </button>
        )}
        <textarea
          ref={area}
          rows={1}
          value={text}
          placeholder={streaming ? t("composer.placeholderBusy") : t("composer.placeholder")}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = imageFiles(e.clipboardData);
            if (!files.length) return;
            e.preventDefault();
            void attach(files);
          }}
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
        <button type="submit" id="send" data-mode={mode} title={BUTTON.title} aria-label={BUTTON.title} disabled={mode === "send" && !hasInput}>
          {BUTTON.icon}
        </button>
      </form>
      {popover && <ModelPopover anchor={ringBtn} onClose={() => setPopover(false)} />}
    </div>
  );
}
