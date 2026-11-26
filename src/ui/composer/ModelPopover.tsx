import { type CSSProperties, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModelPicker, ThinkingLevel } from "../../core/types";
import { useActions, useClientState } from "../client-context";
import { CheckIcon } from "../icons";
import { isHot, levelColor, levelName } from "../ring";
import { useT } from "../../i18n";

/** Off, then Auto (omp picks the effort per turn), then the efforts the live model offers, low to high. */
function ThinkingSlider({ steps, current, onPick }: { steps: string[]; current: string; onPick: (level: string) => void }) {
  const t = useT();
  const at = Math.max(0, steps.indexOf(current));
  const [value, setValue] = useState(at);
  useEffect(() => setValue(at), [at]);
  const last = Math.max(1, steps.length - 1);
  const step = steps[value] ?? "auto";
  const c1 = levelColor(step);
  const style = { "--t": String(value / last), "--c1": c1, "--c2": `color-mix(in srgb, ${c1} 45%, #fff)` } as CSSProperties;
  return (
    <div className="think">
      <div className="think-now">
        {t("pop.effort")}<b>{levelName(step)}</b>
      </div>
      <div className={`sl${isHot(step) ? " hot" : ""}`} style={style}>
        <span className="sand" aria-hidden />
        <input type="range" min={0} max={steps.length - 1} step={1} value={value} aria-label={t("pop.thinking")} onChange={(e) => setValue(Number(e.target.value))} onPointerUp={() => onPick(steps[value] ?? "auto")} onKeyUp={() => onPick(steps[value] ?? "auto")} />
        <div className="ticks">
          {steps.map((l, i) => (
            <span key={l} style={{ "--t": String(i / last) } as CSSProperties}>
              {levelName(l)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Thinking effort and model picker, anchored above (or below) the ring button. Picking a model keeps the card open with the new model's efforts. */
export function ModelPopover({ anchor, onClose }: { anchor: RefObject<HTMLElement | null>; onClose: () => void }) {
  const t = useT();
  const actions = useActions();
  const configured = useClientState((s) => s.thinking.configured);
  const model = useClientState((s) => s.model);
  const [levels, setLevels] = useState<ThinkingLevel[]>();
  const [picker, setPicker] = useState<ModelPicker>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const load = useCallback(
    async (q: string) => {
      const mine = ++seq.current;
      try {
        const [lv, pk] = await Promise.all([actions.thinkingLevels(), actions.pickerRows(q || undefined)]);
        if (mine !== seq.current) return;
        setLevels(lv);
        setPicker(pk);
        setError(undefined);
      } catch (e) {
        if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
      }
    },
    [actions],
  );

  useEffect(() => {
    const t = setTimeout(() => void load(query), query ? 180 : 0);
    return () => clearTimeout(t);
  }, [query, load, model?.id]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  // Anchored to the ring button: above it when there is room, else below, clamped to the viewport.
  useLayoutEffect(() => {
    const el = box.current;
    const a = anchor.current?.getBoundingClientRect();
    if (!el || !a) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const above = a.top - h - 8;
    el.style.left = `${Math.max(8, Math.min(a.right - w, innerWidth - w - 8))}px`;
    el.style.top = `${above >= 8 ? above : Math.min(a.bottom + 8, Math.max(8, innerHeight - h - 8))}px`;
  });

  const steps = ["off", "auto", ...(levels ?? []).filter((l) => l !== "off")];
  return (
    <div id="popover" ref={box} role="dialog" aria-label={t("pop.aria")}>
      <h4>{t("pop.thinking")}</h4>
      {levels ? <ThinkingSlider steps={steps} current={configured} onPick={(l) => void actions.setThinking(l as ThinkingLevel | "auto")} /> : <div className="muted pad">{error ?? t("common.loading")}</div>}
      <h4>{t("pop.model")}</h4>
      <input className="search" placeholder={t("pop.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div>
        {picker?.rows.map((r, i) => (
          <div key={`${r.provider}/${r.id}/${r.role ?? ""}`}>
            {i === picker.recent && picker.recent > 0 && <div className="sep" />}
            <button type="button" className="mrow" onClick={() => void actions.setModel(r.provider, r.id, r.role)}>
              <span className="n">{r.name || r.id}</span>
              <span className="p">{r.provider}</span>
              <span className="ck">{r.current && <CheckIcon />}</span>
            </button>
          </div>
        ))}
        {picker && !picker.rows.length && <div className="muted pad">{t("pop.none")}</div>}
      </div>
    </div>
  );
}
