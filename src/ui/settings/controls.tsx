import { useId } from "react";
import type { MessageKey } from "../../i18n";
import { setLocale, useLocalePreference, useT } from "../../i18n";
import { cx } from "../format";
import { setTheme, useTheme } from "../theme";
import { type Control, type OptId, type Row, type Value, isOpt } from "./schema";

const choiceText = (tr: (key: MessageKey) => string, choice: string) => (isOpt(choice) ? tr(choice) : choice);

/** The control at the right of a row (below it for a text area). `value` is the page's current value; `onChange` stores a new one. */
export function ControlView({ control, value, label, onChange, onPress }: { control: Control; value: Value | undefined; label: string; onChange: (value: Value) => void; onPress: () => void }) {
  const t = useT();
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
      return <Segments options={control.options} value={value} label={label} onChange={onChange} />;
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
      return <LanguageControl label={label} />;
    case "theme":
      return <ThemeControl label={label} />;
  }
}

function LanguageControl({ label }: { label: string }) {
  const t = useT();
  const locale = useLocalePreference();
  return (
    <select className="set-select" aria-label={label} value={locale} onChange={(e) => {
      const next = e.currentTarget.value;
      if (next === "zh" || next === "en" || next === "system") setLocale(next);
    }}>
      <option value="system">{t("set.opt.system")}</option>
      <option value="zh">中文</option>
      <option value="en">English</option>
    </select>
  );
}

function Segments<T extends OptId>({ options, value, label, onChange }: { options: readonly T[]; value: Value | undefined; label: string; onChange: (option: T) => void }) {
  const t = useT();
  const group = useId();
  return (
    <div className="set-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option}>
          <input type="radio" name={group} checked={value === option} onChange={() => onChange(option)} />
          {t(option)}
        </label>
      ))}
    </div>
  );
}

const THEMES = { "set.opt.system": "system", "set.opt.light": "light", "set.opt.dark": "dark" } as const;
function ThemeControl({ label }: { label: string }) {
  const theme = useTheme();
  return <Segments options={["set.opt.system", "set.opt.light", "set.opt.dark"]} label={label}
    value={`set.opt.${theme}`} onChange={(next) => setTheme(THEMES[next])} />;
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
