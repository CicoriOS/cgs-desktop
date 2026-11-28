import { useEffect, useState } from "react";
import type { DeviceSettings, SettingsApi } from "../../core/settings";
import { getLocale, useT } from "../../i18n";
import { useActions, useClientState, useReadOnly } from "../client-context";
import { DesktopUpdateRows } from "./DesktopUpdate";
import { PasswordDialog } from "./PasswordDialog";

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
  // The password dialog: asked for the first time remote access is turned on, and by "Change password".
  const [dialog, setDialog] = useState<"first" | "change" | null>(null);
  const [dialogError, setDialogError] = useState("");

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

  const submitPassword = async (password: string) => {
    if (!api || !dialog) return;
    setBusy(true);
    setDialogError("");
    try {
      setInfo(dialog === "first" ? await api.setRemote(true, password) : await api.setPassword(password));
      setDialog(null);
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      setDialogError(code === "remote_not_allowed" ? t("set.ui.remoteNotAllowed") : code === "password_too_short" ? t("set.pw.short") : t("set.ui.actionFailed"));
    } finally {
      setBusy(false);
    }
  };
  const toggleRemote = () => {
    if (!api || !info) return;
    if (!info.remote && !info.hasPassword) {
      setDialogError("");
      setDialog("first");
      return;
    }
    void run(async () => setInfo(await api.setRemote(!info.remote)));
  };
  const names = info?.fingerprint ? (getLocale() === "zh" ? info.fingerprint.zh : info.fingerprint.en) : [];

  return (
    <>
      {!api && <p className="set-note">{t("set.ui.deviceUnavailable")}</p>}
      {device && <p className="set-desc set-device-name">{device}</p>}
      <section className="set-section">
        <h3 className="set-sec">{t("set.ui.remote")}</h3>
        {info?.remote && info.fingerprint && info.fingerprint.emoji.length > 0 && (
          <div className="set-fingerprint" role="group" aria-label={t("set.ui.fingerprint")}>
            <div className="set-label">{t("set.ui.fingerprint")}</div>
            <div className="fp-emoji" translate="no">
              {info.fingerprint.emoji.map((emoji, i) => <span key={i} title={names[i]}>{emoji}</span>)}
            </div>
            <div className="set-desc">{t("set.ui.fingerprintHelp")}</div>
          </div>
        )}
        <div className="set-rows">
          <div className="set-row">
            <div className="set-text-col">
              <div className="set-label">{t("set.ui.remoteEnable")}</div>
              <div className="set-desc">{t("set.ui.remoteHelp")}</div>
            </div>
            {info?.remote && <button type="button" className="set-btn" disabled={disabled} onClick={() => { setDialogError(""); setDialog("change"); }}>{t("set.ui.changePassword")}</button>}
            {info ? <button type="button" role="switch" className="sw" aria-label={t("set.ui.remoteEnable")} aria-checked={info.remote} disabled={disabled}
              onClick={toggleRemote}><i /></button> : <span className="muted">—</span>}
          </div>
        </div>
      </section>
      <section className="set-section">
        <h3 className="set-sec">{t("set.ui.update")}</h3>
        <div className="set-rows">
          {/* Two numbers, each its own (ADR 0048): the experience package (the desktop app) and the core (the local cgscli). The web client has no package. */}
          <div className="set-row">
            <div className="set-text-col">
              <div className="set-label">{t(info?.packageVersion ? "set.row.package" : "set.row.version")}</div>
              <div className="set-desc">{info ? (info.packageVersion ?? info.version) : "—"}</div>
              {info?.packageVersion && <div className="set-desc">{t("set.row.package.d")}</div>}
            </div>
            <button type="button" className="set-btn" disabled={disabled} onClick={() => api && void run(async () => {
              const result = await api.checkUpdate();
              setMessage(result.available ? t("set.ui.updateAvailable", { version: result.available }) : t("set.ui.upToDate", { version: result.version }));
            })}>{t("set.row.checkUpdate")}</button>
          </div>
          {info?.packageVersion && (
            <div className="set-row">
              <div className="set-text-col">
                <div className="set-label">{t("set.row.core")}</div>
                <div className="set-desc">{info.version}</div>
                <div className="set-desc">{t("set.row.core.d")}</div>
              </div>
            </div>
          )}
          <div className="set-row">
            <div className="set-text-col">
              <div className="set-label">{t("set.row.autoUpdate")}</div>
              <div className="set-desc">{t("set.row.autoUpdate.d")}</div>
            </div>
            {info ? <button type="button" role="switch" className="sw" aria-label={t("set.row.autoUpdate")} aria-checked={info.autoUpdate} disabled={disabled}
              onClick={() => api && void run(async () => setInfo(await api.setAutoUpdate(!info.autoUpdate)))}><i /></button> : <span className="muted">—</span>}
          </div>
          {/* The desktop's own updater (ADR 0046 §6); the web client has no `desktop.updater` and shows nothing. */}
          <DesktopUpdateRows />
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
      {dialog && <PasswordDialog first={dialog === "first"} busy={busy} error={dialogError} onSubmit={(password) => void submitPassword(password)} onClose={() => setDialog(null)} />}
      {(api && !info && !message || busy && !dialog || message) && <p className="set-desc" role="status">{busy || !message ? t("set.ui.loading") : message}</p>}
    </>
  );
}
