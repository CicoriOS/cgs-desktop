import { useEffect, useState } from "react";
import type { DeviceSettings, SettingsApi } from "../../core/settings";
import { useT } from "../../i18n";
import { useActions, useClientState, useReadOnly } from "../client-context";

export function DevicePanel({ api }: { api?: SettingsApi["device"] }) {
  const t = useT();
  const actions = useActions();
  const device = useClientState((s) => s.device);
  const signedIn = useClientState((s) => s.account !== undefined);
  const readOnly = useReadOnly();
  const [info, setInfo] = useState<DeviceSettings>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!api) return;
    let active = true;
    void api.read().then((state) => { if (active) setInfo(state); }, () => { if (active) setMessage(t("set.ui.loadFailed")); });
    return () => { active = false; };
  }, [api, t]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch {
      setMessage(t("set.ui.actionFailed"));
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || readOnly || !api || !info;

  return (
    <>
      {!api && <p className="set-note">{t("set.ui.deviceUnavailable")}</p>}
      {device && <p className="set-desc set-device-name">{device}</p>}
      <section className="set-section">
        <h3 className="set-sec">{t("set.ui.remote")}</h3>
        <div className="set-rows">
          <div className="set-row">
            <div className="set-text-col">
              <div className="set-label">{t("set.ui.remoteEnable")}</div>
              <div className="set-desc">{t("set.ui.remoteHelp")}</div>
            </div>
            {info ? <button type="button" role="switch" className="sw" aria-label={t("set.ui.remoteEnable")} aria-checked={info.remote} disabled={disabled}
              onClick={() => api && void run(async () => setInfo(await api.setRemote(!info.remote)))}><i /></button> : <span className="muted">—</span>}
          </div>
        </div>
      </section>
      <section className="set-section">
        <h3 className="set-sec">{t("set.ui.update")}</h3>
        <div className="set-rows">
          <div className="set-row">
            <div className="set-text-col">
              <div className="set-label">{t("set.row.version")}</div>
              <div className="set-desc">{info?.version ?? "—"}</div>
            </div>
            <button type="button" className="set-btn" disabled={disabled} onClick={() => api && void run(async () => {
              const result = await api.checkUpdate();
              setMessage(result.available ? t("set.ui.updateAvailable", { version: result.available }) : t("set.ui.upToDate", { version: result.version }));
            })}>{t("set.row.checkUpdate")}</button>
          </div>
          <div className="set-row">
            <div className="set-text-col">
              <div className="set-label">{t("set.row.autoUpdate")}</div>
              <div className="set-desc">{t("set.row.autoUpdate.d")}</div>
            </div>
            {info ? <button type="button" role="switch" className="sw" aria-label={t("set.row.autoUpdate")} aria-checked={info.autoUpdate} disabled={disabled}
              onClick={() => api && void run(async () => setInfo(await api.setAutoUpdate(!info.autoUpdate)))}><i /></button> : <span className="muted">—</span>}
          </div>
        </div>
      </section>
      <section className="set-section">
        <h3 className="set-sec">{t("set.ui.deviceSession")}</h3>
        <div className="set-rows">
          <div className="set-row">
            <div className="set-text-col">
              <div className="set-label">{t("set.row.logout")}</div>
              <div className="set-desc">{!signedIn && api ? t("set.ui.noAccount") : t("set.row.logout.d")}</div>
            </div>
            {confirm && <button type="button" className="set-btn" disabled={busy} onClick={() => setConfirm(false)}>{t("set.ui.cancel")}</button>}
            <button type="button" className="set-btn danger" disabled={disabled || !signedIn} onClick={() => {
              if (!confirm) setConfirm(true);
              else if (api) void run(async () => {
                await api.signOut();
                await actions.refreshAccount();
                setConfirm(false);
                setMessage(t("set.ui.signedOut"));
              });
            }}>{t(confirm ? "set.ui.confirmSignOut" : "set.row.logout")}</button>
          </div>
        </div>
      </section>
      {(api && !info && !message || busy || message) && <p className="set-desc" role="status">{busy || !message ? t("set.ui.loading") : message}</p>}
    </>
  );
}
