import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";

/** Minimum the sidecar enforces too (`password_too_short`); checking here only saves the round trip. */
export const MIN_PASSWORD = 8;

/**
 * The remote access password, typed twice. `first` is the one-time setup that precedes turning remote access on; otherwise it
 * changes the existing password. `onSubmit` rejects with the host's error code, which is shown under the fields.
 */
export function PasswordDialog({ first, busy, error, onSubmit, onClose }: { first: boolean; busy: boolean; error: string; onSubmit: (password: string) => void; onClose: () => void }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [touched, setTouched] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);
  const problem = password.length < MIN_PASSWORD ? t("set.pw.short") : password !== again ? t("set.pw.mismatch") : "";
  const submit = () => {
    setTouched(true);
    if (!problem && !busy) onSubmit(password);
  };
  return (
    <div id="pw-dialog" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form
        className="pw-card"
        role="dialog"
        aria-modal="true"
        aria-label={t(first ? "set.pw.titleFirst" : "set.pw.titleChange")}
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        onKeyDown={(e) => { if (e.key === "Escape" && !busy) onClose(); }}
      >
        <h3>{t(first ? "set.pw.titleFirst" : "set.pw.titleChange")}</h3>
        <p>{t(first ? "set.pw.bodyFirst" : "set.pw.bodyChange")}</p>
        <label>
          <span>{t("set.pw.new")}</span>
          <input ref={field} type="password" autoComplete="new-password" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label>
          <span>{t("set.pw.again")}</span>
          <input type="password" autoComplete="new-password" value={again} disabled={busy} onChange={(e) => setAgain(e.target.value)} />
        </label>
        {(touched && problem) || error ? <p className="pw-error" role="alert">{touched && problem ? problem : error}</p> : null}
        <div className="pw-btns">
          <button type="button" className="set-btn" disabled={busy} onClick={onClose}>{t("set.ui.cancel")}</button>
          <button type="submit" className="set-btn primary" disabled={busy}>{t(first ? "set.pw.confirmFirst" : "set.pw.confirmChange")}</button>
        </div>
      </form>
    </div>
  );
}
