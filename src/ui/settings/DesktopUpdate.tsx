// The desktop update control (ADR 0046 §6): only reachable once a release is known, so the settings screen never shows a
// disabled row. Downloading and installing are explicit clicks; installing asks again if sessions are running (main).
import { useState } from "react";
import { useT } from "../../i18n";
import { useUpdaterStatus } from "../../desktop/updater";
import { desktop } from "../desktop";

export function DesktopUpdateRows() {
  const t = useT();
  const api = desktop?.updater;
  const status = useUpdaterStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!api) return null;
  const phase = status?.phase ?? "idle";
  if (phase === "idle") return null;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const label =
    phase === "available"
      ? t("shell.update.available", { version: status?.version ?? "?" })
      : phase === "downloading"
        ? t("shell.update.downloading", { percent: status?.percent ?? 0 })
        : phase === "downloaded"
          ? t("shell.update.downloaded", { version: status?.version ?? "?" })
          : t("shell.update.error", { error: status?.error ?? "?" });
  return (
    <div className="set-row" data-desktop-update>
      <div className="set-text-col">
        <div className="set-label">CGS Desktop</div>
        <div className="set-desc">
          {label}
          {error ? ` — ${error}` : ""}
        </div>
      </div>
      {phase === "available" && (
        <button type="button" className="set-btn" disabled={busy} onClick={() => void run(() => api.download())}>
          {t("shell.update.download")}
        </button>
      )}
      {phase === "downloaded" && (
        <button type="button" className="set-btn" disabled={busy} onClick={() => void run(() => api.install())}>
          {t("shell.update.install")}
        </button>
      )}
      {phase === "downloading" && <span className="muted">{status?.percent ?? 0}%</span>}
    </div>
  );
}
