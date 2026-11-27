import { useId } from "react";
import type { MessageKey } from "../../i18n";
import { setLocale, useLocale, useT } from "../../i18n";
import { cx } from "../format";
import { type Control, type Row, type Value, isOpt } from "./schema";

const choiceText = (tr: (key: MessageKey) => string, choice: string) => (isOpt(choice) ? tr(choice) : choice);

/** The control at the right of a row (below it for a text area). `value` is the page's current value; `onChange` stores a new one. */
export function ControlView({ control, value, label, onChange, onPress }: { control: Control; value: Value | undefined; label: string; onChange: (value: Value) => void; onPress: () => void }) {
  const t = useT();
  const locale = useLocale();
  const group = useId();
  switch (control.kind) {
    case "toggle":
      return (
        <button type="button" role="switch" aria-checked={value === true} aria-label={label} className="sw" onClick={() => onChange(value !== true)}>
          <i />
        </button>
      );
    case "select":
      return (
        <select className="set-select" aria-label={label} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {control.options.map((o) => (
            <option key={o} value={o}>
              {choiceText(t, o)}
            </option>
          ))}
        </select>
      );
    case "segmented":
      return (
        <div className="set-seg" role="radiogroup" aria-label={label}>
          {control.options.map((o) => (
            <label key={o}>
              <input type="radio" name={group} checked={value === o} onChange={() => onChange(o)} />
              {t(o)}
            </label>
          ))}
        </div>
      );
    case "number":
      return (
        <span className="set-num">
          <input type="number" aria-label={label} min={control.min} max={control.max} value={String(value ?? control.value)}
            onChange={(e) => onChange(e.currentTarget.value)}
            onBlur={(e) => {
              const n = e.currentTarget.valueAsNumber;
              onChange(Number.isNaN(n) ? control.value : Math.min(control.max, Math.max(control.min, n)));
            }} />
          {control.unit && <span>{control.unit}</span>}
        </span>
      );
    case "area":
      return <textarea className="set-area" aria-label={label} rows={control.rows} spellCheck={false} value={String(value)} onChange={(e) => onChange(e.target.value)} />;
    case "button":
      return (
        <button type="button" className="set-btn" onClick={onPress}>
          {t(control.label)}
        </button>
      );
    case "locale":
      return (
        <select className="set-select" aria-label={label} value={locale} onChange={(e) => setLocale(e.target.value === "en" ? "en" : "zh")}>
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      );
  }
}

/** One setting: its name and help at the left, its control at the right. */
export function SettingRow({ row, value, onChange, onPress }: { row: Row; value: Value | undefined; onChange: (value: Value) => void; onPress: () => void }) {
  const t = useT();
  const label = t(row.id);
  return (
    <div className={cx("set-row", row.control.kind === "area" && "stack")} data-setting={row.id}>
      <div className="set-text-col">
        <div className="set-label">{label}</div>
        <div className="set-desc">{t(`${row.id}.d`)}</div>
      </div>
      <ControlView control={row.control} value={value} label={label} onChange={onChange} onPress={onPress} />
    </div>
  );
}
