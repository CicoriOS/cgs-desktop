import { useEffect, useRef, useState } from "react";
import type { Dialog, DialogAnswer } from "../../core/types";
import { useT } from "../../i18n";
import { useActions, useClientState } from "../client-context";
import { cx } from "../format";
import { FormDialog } from "./FormDialog";

type Answer = (a: DialogAnswer) => void;

function ConfirmDialog({ d, answer }: { d: Extract<Dialog, { method: "confirm" }>; answer: Answer }) {
  const t = useT();
  return (
    <div className="dlg" role="alertdialog" onKeyDown={(e) => e.key === "Escape" && answer({ confirmed: false })}>
      <div className="dlg-title">{d.title}</div>
      {d.message && <div className="dlg-body"><p className="pre-line">{d.message}</p></div>}
      <div className="dlg-btns">
        <button type="button" onClick={() => answer({ confirmed: false })}>{t("dialog.confirm.no")}</button>
        <button type="button" className="primary" autoFocus onClick={() => answer({ confirmed: true })}>{t("dialog.confirm.yes")}</button>
      </div>
    </div>
  );
}

function SelectDialog({ d, answer }: { d: Extract<Dialog, { method: "select" }>; answer: Answer }) {
  const t = useT();
  const markable = d.marker ? (d.markableCount ?? d.options.length) : 0;
  const checked = new Set(d.checkedIndices ?? []);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <div className="dlg" role="dialog" onKeyDown={(e) => e.key === "Escape" && answer({ cancelled: true })}>
      <div className="dlg-title">{d.title}</div>
      <div className="dlg-body sel-list">
        {d.options.map((o, i) => (
          <button key={i} ref={i === (d.initialIndex ?? 0) ? first : undefined} type="button" className="sel-row" onClick={() => answer({ value: o })}>
            {i < markable && <span className={cx("mark", d.marker, checked.has(i) && "on")} aria-hidden="true" />}
            <span className="sel-t">{o}</span>
            {d.details?.[i] && <span className="muted">{d.details[i]}</span>}
          </button>
        ))}
      </div>
      <div className="dlg-btns"><button type="button" onClick={() => answer({ cancelled: true })}>{t("dialog.dismiss")}</button></div>
    </div>
  );
}

function TextDialog({ d, answer }: { d: Extract<Dialog, { method: "input" | "editor" }>; answer: Answer }) {
  const t = useT();
  const [value, setValue] = useState(d.method === "editor" ? (d.prefill ?? "") : "");
  const submit = () => answer({ value });
  return (
    <form className="dlg" onSubmit={(e) => (e.preventDefault(), submit())} onKeyDown={(e) => e.key === "Escape" && answer({ cancelled: true })}>
      <div className="dlg-title">{d.title}</div>
      <div className="dlg-body">
        {d.method === "editor" ? (
          <textarea autoFocus rows={8} value={value} onChange={(e) => setValue(e.target.value)} />
        ) : (
          <input autoFocus type={d.secret ? "password" : "text"} autoComplete="off" placeholder={d.placeholder} value={value} onChange={(e) => setValue(e.target.value)} />
        )}
      </div>
      <div className="dlg-btns">
        <button type="button" onClick={() => answer({ cancelled: true })}>{t("dialog.dismiss")}</button>
        <button type="submit" className="primary">{t("dialog.input.submit")}</button>
      </div>
    </form>
  );
}

/** The oldest unanswered question from omp, above the message box. The conversation and the box stay usable meanwhile. */
export function DialogHost() {
  const actions = useActions();
  const dialog = useClientState((s) => s.dialogs[0]);
  if (!dialog) return null;
  const answer: Answer = (a) => actions.answerDialog(dialog.id, a);
  return (
    <div className="dlg-wrap" key={dialog.id}>
      {dialog.method === "form" && <FormDialog html={dialog.html} onSubmit={(data) => answer({ data })} onCancel={() => answer({ cancelled: true })} />}
      {dialog.method === "confirm" && <ConfirmDialog d={dialog} answer={answer} />}
      {dialog.method === "select" && <SelectDialog d={dialog} answer={answer} />}
      {(dialog.method === "input" || dialog.method === "editor") && <TextDialog d={dialog} answer={answer} />}
    </div>
  );
}
