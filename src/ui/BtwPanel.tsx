import { useEffect, useState } from "react";
import { useActions, useClientState } from "./client-context";
import { CloseIcon } from "./icons";
import { useT } from "../i18n";

/** omp's `/btw` side question: answered beside the conversation, never added to it. */
export function BtwPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const actions = useActions();
  const records = useClientState((s) => s.btw);
  const [q, setQ] = useState("");
  useEffect(() => void actions.loadBtw(), [actions]);
  const running = records.some((r) => r.status === "running");
  return (
    <div id="btw-panel">
      <div className="btw-head">
        <b>btw</b>
        <span className="muted">{t("btw.note")}</span>
        <span className="grow" />
        <button type="button" className="icon small" title={t("common.close")} onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <form
        id="btw-form"
        onSubmit={(e) => {
          e.preventDefault();
          const question = q.trim();
          if (!question) return;
          setQ("");
          void actions.btw(question);
        }}
      >
        <input autoFocus placeholder={t("btw.placeholder")} autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} />
        {running && (
          <button type="button" onClick={() => void actions.btwCancel()}>
            {t("common.cancel")}
          </button>
        )}
      </form>
      <div id="btw-list">
        {records.map((r) => (
          <div key={r.id} className="btw-item">
            <div className="q">{r.question}</div>
            <div className="a">{r.answer || (r.status === "running" ? "…" : "")}</div>
            {r.status && r.status !== "complete" && <div className="st">{r.status}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
