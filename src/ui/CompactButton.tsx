import { useEffect, useRef, useState } from "react";
import { COMPACT_MODES, type CompactMode } from "../core/compact";
import { type MessageKey, t as translate, useT } from "../i18n";
import { useActions, useClientState } from "./client-context";
import { setCompactMode, useCompactMode } from "./compact-mode";
import { CheckIcon, ChevronDownIcon } from "./icons";

/** Callers render under `useT`, so a language change re-renders them. */
export const compactModeName = (mode: CompactMode) => translate(`compact.mode.${mode}` as MessageKey);

/** True while compacting now would be refused: the agent runs, a compaction runs, or the device is not attached. */
export const useCompactBusy = () => useClientState((s) => s.compacting || s.run.streaming || s.connection !== "ready");

/** "Compact context" with the mode picker beside it. The main button runs the last mode used (quick compaction at first); picking one runs it and makes it the next default. */
export function CompactSplit() {
  const t = useT();
  const actions = useActions();
  const mode = useCompactMode();
  const compacting = useClientState((s) => s.compacting);
  const busy = useCompactBusy();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const run = (m: CompactMode) => {
    setCompactMode(m);
    setOpen(false);
    void actions.compact(m);
  };

  return (
    <div className="split" ref={box}>
      <button type="button" className="split-main" disabled={busy} title={t("compact.hint", { mode: compactModeName(mode) })} onClick={() => run(mode)}>
        {compacting ? t("compact.running") : t("compact.run")}
      </button>
      <button type="button" className="split-arrow" disabled={busy} aria-haspopup="menu" aria-expanded={open} title={t("compact.choose")} aria-label={t("compact.choose")} onClick={() => setOpen((v) => !v)}>
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="split-menu" role="menu">
          {COMPACT_MODES.map((m) => (
            <button key={m} type="button" role="menuitemradio" aria-checked={m === mode} className="mrow" onClick={() => run(m)}>
              <span className="ck">{m === mode && <CheckIcon />}</span>
              <span className="n">
                {compactModeName(m)}
                <small>{t(`compact.desc.${m}` as MessageKey)}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
