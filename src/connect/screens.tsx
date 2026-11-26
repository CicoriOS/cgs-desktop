import { type FormEvent, type ReactNode, useState } from "react";
import { useLocale, useT } from "../i18n";
import type { DeviceMark, RelayConnection, RelayState } from "./connection";

/** Plain shell for every connect page; the logo path follows the deployment base, not a fixed root. */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="connect-page">
      <main className="connect-card">
        <div className="connect-brand">
          <img src={`${import.meta.env.BASE_URL}cgs-logo.svg`} alt="" width={24} height={24} />
          <span>CGS Connect</span>
        </div>
        {children}
      </main>
    </div>
  );
}

export function Notice({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  return (
    <Page>
      <h1>{title}</h1>
      {body && <p className="muted">{body}</p>}
      {children && <div className="connect-actions">{children}</div>}
    </Page>
  );
}

/** Shown at `/connect` without `?device=`. Nothing here constructs a connection. */
export function MissingPage() {
  const t = useT();
  return <Notice title={t("connect.missing.title")} body={t("connect.missing.body")} />;
}

function Retry({ relay }: { relay: RelayConnection }) {
  const t = useT();
  return (
    <button type="button" className="primary" onClick={() => relay.retry()}>
      {t("connect.retry")}
    </button>
  );
}

function PasswordScreen({ problem, onSubmit }: { problem?: string; onSubmit: (password: string) => void }) {
  const t = useT();
  const [password, setPassword] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setPassword("");
    onSubmit(password);
  };

  return (
    <Page>
      <h1>{t("connect.password.title")}</h1>
      <p className="muted">{t("connect.password.body")}</p>
      {problem && <p className="warn" role="alert">{problem}</p>}
      <form className="connect-form" onSubmit={submit}>
        <label>
          <span>{t("connect.password.label")}</span>
          <input type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <div className="connect-actions">
          <button type="submit" className="primary" disabled={!password}>
            {t("connect.password.submit")}
          </button>
        </div>
      </form>
    </Page>
  );
}

function FingerprintScreen({ marks, title, body, confirm, warn, onConfirm }: { marks: readonly DeviceMark[]; title: string; body: string; confirm: string; warn: boolean; onConfirm: () => void }) {
  const locale = useLocale();
  return (
    <Page>
      <h1>{title}</h1>
      <p className={warn ? "warn" : "muted"}>{body}</p>
      <ul className="fp-grid" aria-label={title}>
        {marks.map((m, i) => (
          <li key={i}>
            <span className="fp-emoji">{m.emoji}</span>
            <span className="fp-name">{locale === "zh" ? m.zh : m.en}</span>
          </li>
        ))}
      </ul>
      <div className="connect-actions">
        <button type="button" className="primary" onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </Page>
  );
}

function untilText(until: number | undefined, zh: boolean): string {
  if (until === undefined) return "…";
  return new Date(until).toLocaleTimeString(zh ? "zh-CN" : "en", { hour: "2-digit", minute: "2-digit" });
}

/** Every phase that does not show the session. `ready` and `readonly` are rendered by ConnectView. */
export function StateScreen({ state, relay }: { state: RelayState; relay: RelayConnection }) {
  const t = useT();
  const locale = useLocale();
  switch (state.phase) {
    case "connecting":
    case "ready":
    case "readonly":
      return (
        <Page>
          <p className="muted">{t("connect.connecting")}</p>
        </Page>
      );
    case "missing":
      return <Notice title={t("connect.missing.title")} body={t("connect.missing.body")} />;
    case "login":
      return (
        <Notice title={t("connect.login.title")} body={t("connect.login.body")}>
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            {t("connect.reload")}
          </button>
        </Notice>
      );
    case "forbidden":
      return (
        <Notice title={t("connect.forbidden.title")} body={t("connect.forbidden.body")}>
          <Retry relay={relay} />
        </Notice>
      );
    case "disabled":
      return (
        <Notice title={t("connect.disabled.title")} body={t("connect.disabled.body")}>
          <Retry relay={relay} />
        </Notice>
      );
    case "offline":
      return (
        <Notice title={t("connect.offline.title")} body={t("connect.offline.body")}>
          <Retry relay={relay} />
        </Notice>
      );
    case "error":
      return (
        <Notice title={t("connect.error.title")} body={state.problem ?? t("connect.error.generic")}>
          <Retry relay={relay} />
        </Notice>
      );
    case "revoked":
      return (
        <Notice title={t("connect.revoked.title")} body={t("connect.revoked.body")}>
          <Retry relay={relay} />
        </Notice>
      );
    case "locked":
      return (
        <Notice title={t("connect.locked.title")} body={t("connect.locked.body", { time: untilText(state.until, locale === "zh") })}>
          <Retry relay={relay} />
        </Notice>
      );
    case "password":
      return <PasswordScreen problem={state.problem} onSubmit={(password) => relay.password(password)} />;
    case "fingerprint":
      return (
        <FingerprintScreen
          marks={state.emoji}
          title={t("connect.fingerprint.title")}
          body={t("connect.fingerprint.body")}
          confirm={t("connect.fingerprint.confirm")}
          warn={false}
          onConfirm={() => relay.confirm()}
        />
      );
    case "changed":
      return (
        <FingerprintScreen
          marks={state.emoji}
          title={t("connect.changed.title")}
          body={t("connect.changed.body")}
          confirm={t("connect.changed.confirm")}
          warn
          onConfirm={() => relay.confirm()}
        />
      );
    case "busy":
      return (
        <Notice title={t("connect.busy.title")} body={t("connect.busy.body", { by: state.by ?? "…" })}>
          <button type="button" className="primary" onClick={() => relay.takeover()}>
            {t("connect.busy.takeover")}
          </button>
        </Notice>
      );
  }
}
